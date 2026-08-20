const { db, admin } = require("../config/firebaseAdmin");

const ESCROW_COLLECTION = "escrowAgreements";
const COMMISSION_COLLECTION = "commissionRules";

const EscrowStatus = {
  PENDING_PAYMENT: "pending_payment",
  FUNDED: "funded",
  PARTIALLY_RELEASED: "partially_released", // NEW: some tranches released, some still pending
  RELEASED: "released",
  DISPUTED: "disputed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
};

const TrancheStatus = {
  PENDING: "pending",
  RELEASED: "released",
  DISPUTED: "disputed",
  REFUNDED: "refunded",
};

const ReleaseConditionType = {
  BUYER_CONFIRMATION: "buyer_confirmation",
  TIMED_FROM_FUNDING: "timed_from_funding",
  TIMED_FROM_MILESTONE: "timed_from_milestone",
};

async function calculateCommission({ type, category, amountKobo }) {
  const snapshot = await db
    .collection(COMMISSION_COLLECTION)
    .where("type", "==", type)
    .where("category", "==", category)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return { commissionKobo: 0, rule: null };
  }

  const rule = snapshot.docs[0].data();
  let commissionKobo;

  if (rule.mode === "percentage") {
    commissionKobo = Math.round((amountKobo * rule.value) / 100);
  } else {
    commissionKobo = rule.value;
  }

  if (rule.minKobo != null) commissionKobo = Math.max(commissionKobo, rule.minKobo);
  if (rule.maxKobo != null) commissionKobo = Math.min(commissionKobo, rule.maxKobo);

  return { commissionKobo, rule };
}

// Builds the tranches array for a new agreement. If the caller passes
// explicit `tranches`, they're validated and normalized. Otherwise we fall
// back to a single tranche covering the full amount, using `terms` (the
// old param) as its release condition - this is what keeps every existing
// simple buy/sell flow working unchanged.
function buildTranches({ amountKobo, tranches, terms }) {
  if (tranches && tranches.length > 0) {
    const sum = tranches.reduce((acc, t) => acc + t.amountKobo, 0);
    if (sum !== amountKobo) {
      throw new Error(
        `Tranche amounts (${sum}) must sum to agreement amountKobo (${amountKobo})`
      );
    }

    return tranches.map((t, index) => {
      if (!t.releaseCondition || !t.releaseCondition.type) {
        throw new Error(`Tranche "${t.label || index}" is missing a releaseCondition`);
      }
      const isTimed =
        t.releaseCondition.type === ReleaseConditionType.TIMED_FROM_FUNDING ||
        t.releaseCondition.type === ReleaseConditionType.TIMED_FROM_MILESTONE;
      if (isTimed && !t.releaseCondition.releaseAfterDays) {
        throw new Error(
          `Tranche "${t.label || index}" has a timed release condition but no releaseAfterDays`
        );
      }

      return {
        id: t.id || `tranche_${index}`,
        label: t.label || `Tranche ${index + 1}`,
        amountKobo: t.amountKobo,
        releaseCondition: t.releaseCondition,
        status: TrancheStatus.PENDING,
        fundedAt: null,
        releaseEligibleAt: null,
        milestoneMarkedAt: null,
        releasedAt: null,
        disputeReason: null,
      };
    });
  }

  // Legacy / simple path - one tranche, whole amount.
  return [
    {
      id: "full",
      label: "Full amount",
      amountKobo,
      releaseCondition: terms || { type: ReleaseConditionType.BUYER_CONFIRMATION },
      status: TrancheStatus.PENDING,
      fundedAt: null,
      releaseEligibleAt: null,
      milestoneMarkedAt: null,
      releasedAt: null,
      disputeReason: null,
    },
  ];
}

// Computes the soonest releaseEligibleAt across all still-pending tranches
// that have a concrete timer running. Tranches waiting on buyer confirmation
// or an unreached milestone don't have a releaseEligibleAt yet, so they're
// skipped here - they only enter the timed pool once that condition is set.
function computeNextReleaseEligibleAt(tranches) {
  const pendingTimed = tranches.filter(
    (t) => t.status === TrancheStatus.PENDING && t.releaseEligibleAt
  );
  if (pendingTimed.length === 0) return null;

  return pendingTimed.reduce((soonest, t) => {
    const ms = t.releaseEligibleAt.toMillis
      ? t.releaseEligibleAt.toMillis()
      : t.releaseEligibleAt;
    return soonest === null || ms < soonest ? ms : soonest;
  }, null);
}

async function createAgreement({
  buyerId,
  sellerId,
  type,
  category,
  amountKobo,
  terms,
  referenceId,
  title,
  description,
  tranches,
}) {
  const { commissionKobo, rule } = await calculateCommission({
    type,
    category,
    amountKobo,
  });

  const builtTranches = buildTranches({ amountKobo, tranches, terms });

  const docRef = db.collection(ESCROW_COLLECTION).doc();
  const agreement = {
    id: docRef.id,
    buyerId,
    sellerId,
    type, // "listing" | "job" | "barter" | "custom"
    category: category || null,
    referenceId: referenceId || null,
    // title/description are only meaningful for freestanding custom deals
    // not tied to an existing listing/job/barter.
    title: title || null,
    description: description || null,
    amountKobo,
    commissionKobo,
    commissionRuleId: rule ? rule.id || null : null,
    // Kept for backward compatibility with old clients reading `terms`
    // directly; new code should read tranches[].releaseCondition instead.
    terms: terms || (builtTranches.length === 1 ? builtTranches[0].releaseCondition : null),
    tranches: builtTranches,
    nextReleaseEligibleAt: null,
    status: EscrowStatus.PENDING_PAYMENT,
    paystackReference: null,
    paymentMethod: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await docRef.set(agreement);
  return agreement;
}

// Called once an agreement is fully funded (by either payment path). Starts
// the clock on any "timed_from_funding" tranches and recomputes the
// denormalized nextReleaseEligibleAt used by the cron sweep.
function activateTranchesOnFunding(tranches, fundedAtMillis) {
  const activated = tranches.map((t) => {
    if (t.releaseCondition.type === ReleaseConditionType.TIMED_FROM_FUNDING) {
      const releaseEligibleAt = admin.firestore.Timestamp.fromMillis(
        fundedAtMillis + t.releaseCondition.releaseAfterDays * 24 * 60 * 60 * 1000
      );
      return { ...t, fundedAt: admin.firestore.Timestamp.fromMillis(fundedAtMillis), releaseEligibleAt };
    }
    return { ...t, fundedAt: admin.firestore.Timestamp.fromMillis(fundedAtMillis) };
  });

  return {
    tranches: activated,
    nextReleaseEligibleAt: computeNextReleaseEligibleAt(activated),
  };
}

async function markFunded(agreementId, paystackReference) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    const nowMillis = Date.now();
    const update = {
      status: EscrowStatus.FUNDED,
      paystackReference,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Legacy docs created before tranches existed won't have the field -
    // leave them exactly as before.
    if (data.tranches) {
      const { tranches, nextReleaseEligibleAt } = activateTranchesOnFunding(
        data.tranches,
        nowMillis
      );
      update.tranches = tranches;
      update.nextReleaseEligibleAt = nextReleaseEligibleAt
        ? admin.firestore.Timestamp.fromMillis(nextReleaseEligibleAt)
        : null;
    }

    tx.update(docRef, update);
    return { ...data, ...update };
  });
}

// Legacy whole-agreement release. Kept unchanged for old agreements with no
// tranches array. For new tranche-based agreements, use releaseTranche /
// confirmTrancheRelease instead - calling this on a tranche-based agreement
// will throw, since "release the whole thing at once" isn't well-defined
// once a deal has independently-timed portions.
async function markReleased(agreementId) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.tranches && data.tranches.length > 1) {
      throw new Error(
        "This agreement has multiple tranches - release them individually via releaseTranche."
      );
    }

    if (data.status !== EscrowStatus.FUNDED) {
      throw new Error(`Cannot release from status "${data.status}"`);
    }

    tx.update(docRef, {
      status: EscrowStatus.RELEASED,
      releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(data.tranches
        ? {
            tranches: data.tranches.map((t) => ({
              ...t,
              status: TrancheStatus.RELEASED,
              releasedAt: admin.firestore.Timestamp.now(),
            })),
          }
        : {}),
    });

    const walletRef = db.collection("wallets").doc(data.sellerId);
    tx.set(
      walletRef,
      {
        balanceKobo: admin.firestore.FieldValue.increment(data.amountKobo),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ...data, status: EscrowStatus.RELEASED };
  });
}

// Core tranche release logic, shared by confirmTrancheRelease (buyer-driven)
// and releaseExpiredTranches (cron-driven). Not exported directly.
async function _releaseTrancheInTransaction(tx, docRef, data, trancheId) {
  const tranches = data.tranches || [];
  const index = tranches.findIndex((t) => t.id === trancheId);
  if (index === -1) throw new Error("Tranche not found");

  const tranche = tranches[index];
  if (tranche.status === TrancheStatus.RELEASED) {
    return { alreadyReleased: true, tranches };
  }
  if (tranche.status === TrancheStatus.DISPUTED) {
    throw new Error("Cannot release a disputed tranche");
  }

  const updatedTranches = [...tranches];
  updatedTranches[index] = {
    ...tranche,
    status: TrancheStatus.RELEASED,
    releasedAt: admin.firestore.Timestamp.now(),
  };

  const walletRef = db.collection("wallets").doc(data.sellerId);
  tx.set(
    walletRef,
    {
      balanceKobo: admin.firestore.FieldValue.increment(tranche.amountKobo),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const allReleased = updatedTranches.every((t) => t.status === TrancheStatus.RELEASED);
  const nextReleaseEligibleAt = computeNextReleaseEligibleAt(updatedTranches);

  tx.update(docRef, {
    tranches: updatedTranches,
    status: allReleased ? EscrowStatus.RELEASED : EscrowStatus.PARTIALLY_RELEASED,
    nextReleaseEligibleAt: nextReleaseEligibleAt
      ? admin.firestore.Timestamp.fromMillis(nextReleaseEligibleAt)
      : null,
    ...(allReleased ? { releasedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { alreadyReleased: false, tranches: updatedTranches };
}

// Buyer explicitly confirms a tranche (works for buyer_confirmation
// tranches, and also lets a buyer release a timed tranche early rather
// than waiting for the timer).
async function confirmTrancheRelease(agreementId, trancheId, buyerUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.buyerId !== buyerUid) throw new Error("Not your agreement");
    if (
      data.status !== EscrowStatus.FUNDED &&
      data.status !== EscrowStatus.PARTIALLY_RELEASED
    ) {
      throw new Error(`Cannot release from status "${data.status}"`);
    }

    const result = await _releaseTrancheInTransaction(tx, docRef, data, trancheId);
    return result;
  });
}

// Seller marks a milestone reached (e.g. "delivered"), which starts the
// countdown for a timed_from_milestone tranche. Only meaningful for
// tranches with that release condition type.
async function markMilestoneReached(agreementId, trancheId, sellerUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.sellerId !== sellerUid) throw new Error("Not your agreement");

    const tranches = data.tranches || [];
    const index = tranches.findIndex((t) => t.id === trancheId);
    if (index === -1) throw new Error("Tranche not found");

    const tranche = tranches[index];
    if (tranche.releaseCondition.type !== ReleaseConditionType.TIMED_FROM_MILESTONE) {
      throw new Error("This tranche isn't milestone-based");
    }
    if (tranche.status !== TrancheStatus.PENDING) {
      throw new Error(`Cannot mark milestone on tranche with status "${tranche.status}"`);
    }

    const nowMillis = Date.now();
    const releaseEligibleAt = admin.firestore.Timestamp.fromMillis(
      nowMillis + tranche.releaseCondition.releaseAfterDays * 24 * 60 * 60 * 1000
    );

    const updatedTranches = [...tranches];
    updatedTranches[index] = {
      ...tranche,
      milestoneMarkedAt: admin.firestore.Timestamp.fromMillis(nowMillis),
      releaseEligibleAt,
    };

    const nextReleaseEligibleAt = computeNextReleaseEligibleAt(updatedTranches);

    tx.update(docRef, {
      tranches: updatedTranches,
      nextReleaseEligibleAt: nextReleaseEligibleAt
        ? admin.firestore.Timestamp.fromMillis(nextReleaseEligibleAt)
        : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return updatedTranches[index];
  });
}

// Either party disputes a specific tranche. This blocks ONLY that tranche
// from releasing (auto or manual) - other tranches on the same agreement
// keep flowing normally. The agreement is flagged `disputed` at the top
// level so it surfaces in an admin queue; resolve via adminResolveTranche.
async function disputeTranche(agreementId, trancheId, reason, actorUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.buyerId !== actorUid && data.sellerId !== actorUid) {
      throw new Error("Not a party to this agreement");
    }

    const tranches = data.tranches || [];
    const index = tranches.findIndex((t) => t.id === trancheId);
    if (index === -1) throw new Error("Tranche not found");

    const updatedTranches = [...tranches];
    updatedTranches[index] = {
      ...tranches[index],
      status: TrancheStatus.DISPUTED,
      disputeReason: reason || null,
    };

    const nextReleaseEligibleAt = computeNextReleaseEligibleAt(updatedTranches);

    tx.update(docRef, {
      tranches: updatedTranches,
      status: EscrowStatus.DISPUTED,
      nextReleaseEligibleAt: nextReleaseEligibleAt
        ? admin.firestore.Timestamp.fromMillis(nextReleaseEligibleAt)
        : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return updatedTranches[index];
  });
}

// Minimal admin resolution path so a disputed tranche isn't a dead end.
// outcome: "release" credits the seller as normal; "refund" credits the
// buyer's wallet instead and marks the tranche refunded. Full admin
// authentication/authorization is the Admin Panel's job - this function
// assumes the caller (a route protected by an admin check) has already
// verified the actor is an admin.
async function adminResolveTranche(agreementId, trancheId, outcome) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    const tranches = data.tranches || [];
    const index = tranches.findIndex((t) => t.id === trancheId);
    if (index === -1) throw new Error("Tranche not found");
    const tranche = tranches[index];

    if (tranche.status !== TrancheStatus.DISPUTED) {
      throw new Error("Tranche is not under dispute");
    }

    if (outcome === "release") {
      return _releaseTrancheInTransaction(tx, docRef, data, trancheId);
    }

    if (outcome === "refund") {
      const updatedTranches = [...tranches];
      updatedTranches[index] = {
        ...tranche,
        status: TrancheStatus.REFUNDED,
        releasedAt: admin.firestore.Timestamp.now(),
      };

      const walletRef = db.collection("wallets").doc(data.buyerId);
      tx.set(
        walletRef,
        {
          balanceKobo: admin.firestore.FieldValue.increment(tranche.amountKobo),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const stillDisputed = updatedTranches.some((t) => t.status === TrancheStatus.DISPUTED);
      const allSettled = updatedTranches.every(
        (t) => t.status === TrancheStatus.RELEASED || t.status === TrancheStatus.REFUNDED
      );

      tx.update(docRef, {
        tranches: updatedTranches,
        status: stillDisputed
          ? EscrowStatus.DISPUTED
          : allSettled
          ? EscrowStatus.RELEASED
          : EscrowStatus.PARTIALLY_RELEASED,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return updatedTranches[index];
    }

    throw new Error(`Unknown outcome "${outcome}"`);
  });
}

// Cron entrypoint - see routes/escrow.js for the internal, secret-protected
// endpoint that triggers this on a schedule.
//
// IMPORTANT: this does NOT release funds. Ozo's rule: money only ever moves
// when the buyer explicitly confirms, via confirmTrancheRelease - even
// after a timer has fully expired, the buyer still has to tap "release."
// What this DOES do is find tranches whose window has passed and are still
// sitting unreleased, and stamp them so the app/notifications layer can
// prompt the buyer ("Your escrow window on X has ended - release funds to
// the seller?"). No wallet writes happen here.
async function flagOverdueTranches() {
  const nowTs = admin.firestore.Timestamp.now();

  const [fundedSnap, partialSnap] = await Promise.all([
    db
      .collection(ESCROW_COLLECTION)
      .where("status", "==", EscrowStatus.FUNDED)
      .where("nextReleaseEligibleAt", "<=", nowTs)
      .get(),
    db
      .collection(ESCROW_COLLECTION)
      .where("status", "==", EscrowStatus.PARTIALLY_RELEASED)
      .where("nextReleaseEligibleAt", "<=", nowTs)
      .get(),
  ]);

  const candidates = [...fundedSnap.docs, ...partialSnap.docs];
  const results = { checked: candidates.length, flagged: 0, errors: [] };

  for (const doc of candidates) {
    const agreementId = doc.id;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const data = snap.data();
        const tranches = data.tranches || [];
        const nowMillis = Date.now();

        let changed = false;
        const updatedTranches = tranches.map((t) => {
          if (t.status !== TrancheStatus.PENDING || !t.releaseEligibleAt || t.overdueFlaggedAt) {
            return t;
          }
          const ms = t.releaseEligibleAt.toMillis
            ? t.releaseEligibleAt.toMillis()
            : t.releaseEligibleAt;
          if (ms <= nowMillis) {
            changed = true;
            results.flagged += 1;
            return { ...t, overdueFlaggedAt: admin.firestore.Timestamp.now() };
          }
          return t;
        });

        if (changed) {
          tx.update(doc.ref, {
            tranches: updatedTranches,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
    } catch (err) {
      results.errors.push({ agreementId, message: err.message });
    }
  }

  return results;
}

async function markDisputed(agreementId, reason) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  await docRef.update({
    status: EscrowStatus.DISPUTED,
    disputeReason: reason || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return (await docRef.get()).data();
}

async function getAgreement(agreementId) {
  const snap = await db.collection(ESCROW_COLLECTION).doc(agreementId).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function payFromWallet(agreementId, buyerUid) {
  const agreementRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  const walletRef = db.collection("wallets").doc(buyerUid);

  return db.runTransaction(async (tx) => {
    const agreementSnap = await tx.get(agreementRef);
    if (!agreementSnap.exists) throw new Error("Agreement not found");
    const agreement = agreementSnap.data();

    if (agreement.buyerId !== buyerUid) {
      throw new Error("Not your agreement");
    }
    if (agreement.status !== EscrowStatus.PENDING_PAYMENT) {
      throw new Error(`Cannot pay from status "${agreement.status}"`);
    }

    const walletSnap = await tx.get(walletRef);
    const balanceKobo = walletSnap.exists
      ? walletSnap.data().balanceKobo || 0
      : 0;
    const totalKobo = agreement.amountKobo + agreement.commissionKobo;

    if (balanceKobo < totalKobo) {
      throw new Error("Insufficient wallet balance");
    }

    tx.set(
      walletRef,
      {
        balanceKobo: admin.firestore.FieldValue.increment(-totalKobo),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const nowMillis = Date.now();
    const update = {
      status: EscrowStatus.FUNDED,
      paystackReference: null,
      paymentMethod: "wallet",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (agreement.tranches) {
      const { tranches, nextReleaseEligibleAt } = activateTranchesOnFunding(
        agreement.tranches,
        nowMillis
      );
      update.tranches = tranches;
      update.nextReleaseEligibleAt = nextReleaseEligibleAt
        ? admin.firestore.Timestamp.fromMillis(nextReleaseEligibleAt)
        : null;
    }

    tx.update(agreementRef, update);

    return { ...agreement, ...update };
  });
}

async function listForUser(uid) {
  const [asBuyer, asSeller] = await Promise.all([
    db
      .collection(ESCROW_COLLECTION)
      .where("buyerId", "==", uid)
      .orderBy("createdAt", "desc")
      .get(),
    db
      .collection(ESCROW_COLLECTION)
      .where("sellerId", "==", uid)
      .orderBy("createdAt", "desc")
      .get(),
  ]);

  const all = [...asBuyer.docs, ...asSeller.docs].map((doc) => doc.data());

  const byId = new Map(all.map((a) => [a.id, a]));
  return Array.from(byId.values()).sort((a, b) => {
    const aTime = a.createdAt?.toMillis?.() ?? 0;
    const bTime = b.createdAt?.toMillis?.() ?? 0;
    return bTime - aTime;
  });
}

module.exports = {
  EscrowStatus,
  TrancheStatus,
  ReleaseConditionType,
  calculateCommission,
  createAgreement,
  markFunded,
  markReleased,
  markDisputed,
  getAgreement,
  payFromWallet,
  listForUser,
  confirmTrancheRelease,
  markMilestoneReached,
  disputeTranche,
  adminResolveTranche,
  flagOverdueTranches,
};