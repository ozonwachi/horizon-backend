const { db, admin } = require("../config/firebaseAdmin");
const { notifyUser } = require("./notificationService");
const { notifyAdminsOfDispute } = require("./conversationService");
const { recordAuditLog } = require("./auditLogService");
const {
  ADMIN_WALLET_UID,
  TYPES: LEDGER_TYPES,
  recordWalletTransaction,
} = require("./walletLedgerService");

const ESCROW_COLLECTION = "escrowAgreements";
const COMMISSION_COLLECTION = "commissionRules";

// Fields a generic admin edit (adminUpdateAgreement) is allowed to touch.
// Status transitions have their own dedicated, invariant-preserving
// functions (markFunded, markReleased, adminResolveTranche, cancel*) and are
// deliberately excluded here.
const ADMIN_EDITABLE_FIELDS = ["amountKobo", "commissionKobo", "title", "description"];

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
  // A tranche an admin force-cancelled with a split decision - part to the
  // buyer, part to the seller, part to the admin wallet, in any
  // combination - so neither RELEASED (100% to seller) nor REFUNDED (100%
  // to buyer) describes it accurately. The tranche's `splits` array (see
  // adminForceCancelDeal) is the actual record of where the money went.
  SETTLED: "settled",
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

  // Item 6: notify the other party that a deal was opened. The buyer
  // already knows (they just created it) - it's the seller who needs the
  // heads up.
  await notifyUser(sellerId, {
    type: "escrow_opened",
    title: "New escrow deal opened",
    body: title
      ? `An escrow agreement for "${title}" was opened with you.`
      : "An escrow agreement was opened with you.",
    relatedType: "escrow",
    relatedId: agreement.id,
  }).catch((err) => console.error("notifyUser (escrow_opened) failed:", err));

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

  const result = await db.runTransaction(async (tx) => {
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

  await notifyUser(result.sellerId, {
    type: "escrow_funded",
    title: "Escrow deal funded",
    body: "The buyer has funded your escrow agreement.",
    relatedType: "escrow",
    relatedId: agreementId,
  }).catch((err) => console.error("notifyUser (escrow_funded) failed:", err));

  return result;
}

// Legacy whole-agreement release. Kept unchanged for old agreements with no
// tranches array. For new tranche-based agreements, use releaseTranche /
// confirmTrancheRelease instead - calling this on a tranche-based agreement
// will throw, since "release the whole thing at once" isn't well-defined
// once a deal has independently-timed portions.
async function markReleased(agreementId) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  const result = await db.runTransaction(async (tx) => {
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
    recordWalletTransaction(tx, {
      uid: data.sellerId,
      amountKobo: data.amountKobo,
      type: LEDGER_TYPES.ESCROW_RELEASE,
      agreementId,
      recipientRole: "seller",
    });

    return { ...data, status: EscrowStatus.RELEASED };
  });

  await notifyUser(result.sellerId, {
    type: "escrow_released",
    title: "Escrow funds released",
    body: "The buyer released the escrow funds to you.",
    relatedType: "escrow",
    relatedId: agreementId,
  }).catch((err) => console.error("notifyUser (escrow_released) failed:", err));

  return result;
}

// Single source of truth for "what should the deal-level status be, given
// these tranches" - called after every tranche mutation (release, refund,
// dispute) so RELEASED/REFUNDED/PARTIALLY_RELEASED mean the same thing
// everywhere. Before this existed, several call sites each had their own
// "allReleased ? RELEASED : PARTIALLY_RELEASED" ternary that never checked
// for REFUNDED - a deal where every tranche was refunded to the buyer would
// incorrectly show as "Released" (implying the seller got paid) instead of
// "Refunded", and the Admin Dashboard's Refunded filter would never match
// anything as a result.
function computeAgreementStatus(tranches) {
  if (tranches.some((t) => t.status === TrancheStatus.DISPUTED)) {
    return EscrowStatus.DISPUTED;
  }
  const allSettled = tranches.every(
    (t) =>
      t.status === TrancheStatus.RELEASED ||
      t.status === TrancheStatus.REFUNDED ||
      t.status === TrancheStatus.SETTLED
  );
  if (!allSettled) {
    return EscrowStatus.PARTIALLY_RELEASED;
  }
  if (tranches.every((t) => t.status === TrancheStatus.REFUNDED)) {
    return EscrowStatus.REFUNDED;
  }
  if (tranches.every((t) => t.status === TrancheStatus.RELEASED)) {
    return EscrowStatus.RELEASED;
  }
  // Fully settled, but split between some tranches released and others
  // refunded - there's no existing status that means "half went to the
  // seller, half came back to the buyer". RELEASED is the closest existing
  // label (money is fully and finally distributed, nothing left pending).
  return EscrowStatus.RELEASED;
}

// Core tranche release logic, shared by confirmTrancheRelease (buyer-driven),
// releaseExpiredTranches (cron-driven), and adminResolveTranche's "release"
// outcome. Not exported directly.
//
// [adminResolution], when passed, is stamped directly onto the tranche
// (not just the audit log) so the tranche itself remembers who released it
// and why - EscrowDetailScreen shows this on the tranche card, so "who did
// I release this to and why" is visible without digging through the audit
// log. Left null for the ordinary buyer-driven and cron paths.
async function _releaseTrancheInTransaction(tx, docRef, data, trancheId, adminResolution = null) {
  const tranches = data.tranches || [];
  const index = tranches.findIndex((t) => t.id === trancheId);
  if (index === -1) throw new Error("Tranche not found");

  const tranche = tranches[index];
  if (tranche.status === TrancheStatus.RELEASED) {
    return { alreadyReleased: true, tranches, status: data.status };
  }
  // This guard exists for the ordinary paths that share this function -
  // a buyer confirming release (confirmTrancheRelease) or the cron job
  // (releaseExpiredTranches) should never be able to release a tranche
  // that's under dispute. adminResolveTranche's "release" outcome is the
  // one legitimate exception: it already requires the tranche to BE
  // disputed before it will even call in here (see "Tranche is not under
  // dispute" above it), so this blanket check was contradicting that and
  // making "release to seller" on a disputed tranche always fail, while
  // "refund to buyer" worked fine since it never goes through this shared
  // function. adminResolution is only ever set by that admin path, so
  // skipping the guard when it's present is safe.
  if (tranche.status === TrancheStatus.DISPUTED && !adminResolution) {
    throw new Error("Cannot release a disputed tranche");
  }

  const updatedTranches = [...tranches];
  updatedTranches[index] = {
    ...tranche,
    status: TrancheStatus.RELEASED,
    releasedAt: admin.firestore.Timestamp.now(),
    ...(adminResolution ? { adminResolution } : {}),
  };

  const walletRef = db.collection("wallets").doc(data.sellerId);
  recordWalletTransaction(tx, {
    uid: data.sellerId,
    amountKobo: tranche.amountKobo,
    type: LEDGER_TYPES.ESCROW_RELEASE,
    agreementId: docRef.id,
    trancheId,
    reason: adminResolution ? adminResolution.reason : null,
    recipientRole: "seller",
  });
  tx.set(
    walletRef,
    {
      balanceKobo: admin.firestore.FieldValue.increment(tranche.amountKobo),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const newStatus = computeAgreementStatus(updatedTranches);
  const allReleased = newStatus === EscrowStatus.RELEASED;
  const nextReleaseEligibleAt = computeNextReleaseEligibleAt(updatedTranches);

  tx.update(docRef, {
    tranches: updatedTranches,
    status: newStatus,
    nextReleaseEligibleAt: nextReleaseEligibleAt
      ? admin.firestore.Timestamp.fromMillis(nextReleaseEligibleAt)
      : null,
    ...(allReleased ? { releasedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { alreadyReleased: false, tranches: updatedTranches, status: newStatus };
}

// Buyer explicitly confirms a tranche (works for buyer_confirmation
// tranches, and also lets a buyer release a timed tranche early rather
// than waiting for the timer).
async function confirmTrancheRelease(agreementId, trancheId, buyerUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  let sellerId = null;

  const result = await db.runTransaction(async (tx) => {
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

    sellerId = data.sellerId;
    const releaseResult = await _releaseTrancheInTransaction(tx, docRef, data, trancheId);
    // Callers (the Flutter app) always parse this as a full EscrowAgreement,
    // not a bare tranche/result fragment - return the merged agreement.
    return {
      ...data,
      tranches: releaseResult.tranches,
      status: releaseResult.status,
      alreadyReleased: releaseResult.alreadyReleased,
    };
  });

  if (sellerId && !result.alreadyReleased) {
    await notifyUser(sellerId, {
      type: "escrow_released",
      title: "Escrow tranche released",
      body: "The buyer released a tranche of escrow funds to you.",
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error("notifyUser (tranche release) failed:", err));
  }

  return result;
}

// Seller marks a milestone reached (e.g. "delivered"), which starts the
// countdown for a timed_from_milestone tranche. Only meaningful for
// tranches with that release condition type.
async function markMilestoneReached(agreementId, trancheId, sellerUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  let buyerId = null;

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.sellerId !== sellerUid) throw new Error("Not your agreement");
    buyerId = data.buyerId;

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

    // Callers always parse this as a full EscrowAgreement - return the
    // merged agreement, not the bare updated tranche.
    return { ...data, tranches: updatedTranches };
  });

  if (buyerId) {
    await notifyUser(buyerId, {
      type: "escrow_milestone",
      title: "Milestone reached",
      body: "The other party marked a milestone reached - a release countdown has started.",
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error("notifyUser (escrow_milestone) failed:", err));
  }

  return result;
}

// Either party disputes a specific tranche. This blocks ONLY that tranche
// from releasing (auto or manual) - other tranches on the same agreement
// keep flowing normally. The agreement is flagged `disputed` at the top
// level so it surfaces in an admin queue; resolve via adminResolveTranche.
async function disputeTranche(agreementId, trancheId, reason, actorUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  let otherPartyId = null;

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.buyerId !== actorUid && data.sellerId !== actorUid) {
      throw new Error("Not a party to this agreement");
    }
    otherPartyId = data.buyerId === actorUid ? data.sellerId : data.buyerId;

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

    // Callers always parse this as a full EscrowAgreement - return the
    // merged agreement, not the bare updated tranche.
    return { ...data, tranches: updatedTranches, status: EscrowStatus.DISPUTED };
  });

  if (otherPartyId) {
    await notifyUser(otherPartyId, {
      type: "escrow_disputed",
      title: "Escrow tranche disputed",
      body: reason
        ? `A tranche was disputed: ${reason}`
        : "A tranche on your escrow agreement was disputed.",
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error("notifyUser (escrow_disputed) failed:", err));
  }

  await notifyAdminsOfDispute({ agreementId, reason }).catch((err) =>
    console.error("notifyAdminsOfDispute failed:", err)
  );

  return result;
}

// Minimal admin resolution path so a disputed tranche isn't a dead end.
// outcome: "release" credits the seller as normal; "refund" credits the
// buyer's wallet instead and marks the tranche refunded. Full admin
// authentication/authorization is the Admin Panel's job - this function
// assumes the caller (a route protected by an admin check) has already
// verified the actor is an admin.
async function adminResolveTranche(agreementId, trancheId, outcome, adminUid, reason) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  let buyerId = null;
  let sellerId = null;
  let previousTrancheStatus = null;
  let trancheLabel = null;
  let trancheAmountKobo = null;

  const adminResolution = adminUid
    ? {
        by: adminUid,
        outcome,
        reason: reason || null,
        resolvedAt: admin.firestore.Timestamp.now(),
      }
    : null;

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();
    buyerId = data.buyerId;
    sellerId = data.sellerId;

    const tranches = data.tranches || [];
    const index = tranches.findIndex((t) => t.id === trancheId);
    if (index === -1) throw new Error("Tranche not found");
    const tranche = tranches[index];
    previousTrancheStatus = tranche.status;
    trancheLabel = tranche.label;
    trancheAmountKobo = tranche.amountKobo;

    if (tranche.status !== TrancheStatus.DISPUTED) {
      throw new Error("Tranche is not under dispute");
    }

    if (outcome === "release") {
      const releaseResult = await _releaseTrancheInTransaction(
        tx,
        docRef,
        data,
        trancheId,
        adminResolution
      );
      // Callers always parse this as a full EscrowAgreement - return the
      // merged agreement, not the bare tranche/result fragment.
      return {
        ...data,
        tranches: releaseResult.tranches,
        status: releaseResult.status,
        alreadyReleased: releaseResult.alreadyReleased,
      };
    }

    if (outcome === "refund") {
      const updatedTranches = [...tranches];
      updatedTranches[index] = {
        ...tranche,
        status: TrancheStatus.REFUNDED,
        releasedAt: admin.firestore.Timestamp.now(),
        ...(adminResolution ? { adminResolution } : {}),
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
      recordWalletTransaction(tx, {
        uid: data.buyerId,
        amountKobo: tranche.amountKobo,
        type: LEDGER_TYPES.ESCROW_REFUND,
        agreementId,
        trancheId,
        reason: adminResolution ? adminResolution.reason : null,
        recipientRole: "buyer",
      });

      const newStatus = computeAgreementStatus(updatedTranches);

      tx.update(docRef, {
        tranches: updatedTranches,
        status: newStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Callers always parse this as a full EscrowAgreement - return the
      // merged agreement, not the bare updated tranche.
      return { ...data, tranches: updatedTranches, status: newStatus };
    }

    throw new Error(`Unknown outcome "${outcome}"`);
  });

  const notifyTargets =
    outcome === "refund" ? [buyerId] : [sellerId, buyerId].filter(Boolean);
  await Promise.all(
    notifyTargets.map((uid) =>
      notifyUser(uid, {
        type: "escrow_dispute_resolved",
        title: "Escrow dispute resolved",
        body:
          outcome === "refund"
            ? "An admin resolved your dispute and issued a refund."
            : "An admin resolved the dispute and released the tranche to the seller.",
        relatedType: "escrow",
        relatedId: agreementId,
      }).catch((err) => console.error("notifyUser (dispute resolved) failed:", err))
    )
  );

  if (adminUid) {
    const recipientUid = outcome === "refund" ? buyerId : sellerId;
    const recipientRole = outcome === "refund" ? "buyer" : "seller";
    await recordAuditLog({
      userId: adminUid,
      action: "escrow_dispute_resolved",
      targetType: "escrowTranche",
      targetId: `${agreementId}/${trancheId}`,
      agreementId,
      previousValue: { status: previousTrancheStatus },
      newValue: {
        status: outcome === "refund" ? TrancheStatus.REFUNDED : TrancheStatus.RELEASED,
        trancheLabel,
        amountKobo: trancheAmountKobo,
        recipientUid,
        recipientRole,
      },
      reason: reason || outcome,
    }).catch((err) => console.error("recordAuditLog (dispute resolved) failed:", err));
  }

  return result;
}

// Item: admin dashboard "browse everything" list - unlike listForUser, this
// is NOT scoped to a buyer/seller and is meant to be called only from a
// route already protected by requireAdmin. Optional [status] filters to one
// EscrowStatus value (e.g. "disputed" to triage what needs attention first).
//
// NOTE: filtering by status AND ordering by updatedAt needs a Firestore
// composite index (collection: escrowAgreements, fields: status ASC,
// updatedAt DESC) - Firestore will return a direct link to create it the
// first time this runs with a status filter, the same as other composite
// queries in this file.
async function listAllAgreements({ status, limit = 100 } = {}) {
  let query = db.collection(ESCROW_COLLECTION).orderBy("updatedAt", "desc");
  if (status) {
    query = query.where("status", "==", status);
  }
  query = query.limit(Math.min(limit, 500));

  const snap = await query.get();
  return snap.docs.map((doc) => doc.data());
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

async function markDisputed(agreementId, reason, actorUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  await docRef.update({
    status: EscrowStatus.DISPUTED,
    disputeReason: reason || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const updated = (await docRef.get()).data();

  const otherPartyId =
    actorUid && updated.buyerId === actorUid
      ? updated.sellerId
      : actorUid && updated.sellerId === actorUid
      ? updated.buyerId
      : null;
  if (otherPartyId) {
    await notifyUser(otherPartyId, {
      type: "escrow_disputed",
      title: "Escrow agreement disputed",
      body: reason ? `Your escrow agreement was disputed: ${reason}` : "Your escrow agreement was disputed.",
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error("notifyUser (escrow_disputed) failed:", err));
  }

  await notifyAdminsOfDispute({ agreementId, reason }).catch((err) =>
    console.error("notifyAdminsOfDispute failed:", err)
  );

  return updated;
}

async function getAgreement(agreementId) {
  const snap = await db.collection(ESCROW_COLLECTION).doc(agreementId).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function payFromWallet(agreementId, buyerUid) {
  const agreementRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  const walletRef = db.collection("wallets").doc(buyerUid);

  const result = await db.runTransaction(async (tx) => {
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
    recordWalletTransaction(tx, {
      uid: buyerUid,
      amountKobo: -totalKobo,
      type: LEDGER_TYPES.ESCROW_PAYMENT,
      agreementId,
      recipientRole: "buyer",
    });

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

  await notifyUser(result.sellerId, {
    type: "escrow_funded",
    title: "Escrow deal funded",
    body: "The buyer funded your escrow agreement from their wallet.",
    relatedType: "escrow",
    relatedId: agreementId,
  }).catch((err) => console.error("notifyUser (escrow_funded) failed:", err));

  return result;
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

// Item 2: buyer can cancel unilaterally before the deal is funded; once
// funded (or partially released), cancelling requires both parties to
// agree - whoever calls this first "requests" the cancellation, and the
// other party's call to this same function confirms it and actually
// unwinds the deal, refunding any still-unreleased tranche funds back to
// the buyer's wallet. Already-released tranches are not clawed back.
async function requestOrConfirmCancel(agreementId, actorUid) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  let notify = null; // { targetUid, type, title, body }

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.buyerId !== actorUid && data.sellerId !== actorUid) {
      throw new Error("Not a party to this agreement");
    }
    const otherPartyId = data.buyerId === actorUid ? data.sellerId : data.buyerId;

    const TERMINAL = [
      EscrowStatus.DISPUTED,
      EscrowStatus.RELEASED,
      EscrowStatus.REFUNDED,
      EscrowStatus.CANCELLED,
    ];
    if (TERMINAL.includes(data.status)) {
      throw new Error(`Cannot cancel from status "${data.status}"`);
    }

    if (data.status === EscrowStatus.PENDING_PAYMENT) {
      if (data.buyerId !== actorUid) {
        throw new Error("Only the buyer can cancel before the deal is funded");
      }
      tx.update(docRef, {
        status: EscrowStatus.CANCELLED,
        cancelRequestedBy: actorUid,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      notify = {
        targetUid: otherPartyId,
        type: "escrow_cancelled",
        title: "Escrow deal cancelled",
        body: "The buyer cancelled this escrow agreement before it was funded.",
      };
      return { ...data, status: EscrowStatus.CANCELLED, cancelRequestedBy: actorUid };
    }

    // FUNDED or PARTIALLY_RELEASED - needs mutual confirmation.
    if (!data.cancelRequestedBy) {
      tx.update(docRef, {
        cancelRequestedBy: actorUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      notify = {
        targetUid: otherPartyId,
        type: "escrow_cancel_requested",
        title: "Cancellation requested",
        body: "The other party requested to cancel this funded escrow agreement. Confirm to proceed.",
      };
      return { ...data, cancelRequestedBy: actorUid, awaitingConfirmation: true };
    }

    if (data.cancelRequestedBy === actorUid) {
      throw new Error(
        "You already requested cancellation - waiting for the other party to confirm"
      );
    }

    // The other party is now confirming - refund any still-pending tranche
    // amounts back to the buyer's wallet and mark the agreement cancelled.
    const tranches = data.tranches || [];
    let refundKobo = 0;
    const updatedTranches = tranches.map((t) => {
      if (t.status === TrancheStatus.PENDING) {
        refundKobo += t.amountKobo;
        return {
          ...t,
          status: TrancheStatus.REFUNDED,
          releasedAt: admin.firestore.Timestamp.now(),
        };
      }
      return t;
    });

    if (refundKobo > 0) {
      const walletRef = db.collection("wallets").doc(data.buyerId);
      tx.set(
        walletRef,
        {
          balanceKobo: admin.firestore.FieldValue.increment(refundKobo),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      recordWalletTransaction(tx, {
        uid: data.buyerId,
        amountKobo: refundKobo,
        type: LEDGER_TYPES.ESCROW_REFUND,
        agreementId,
        reason: "Mutual cancellation",
        recipientRole: "buyer",
      });
    }

    tx.update(docRef, {
      status: EscrowStatus.CANCELLED,
      tranches: updatedTranches,
      // Clear this now that cancellation is final - left set, it made both
      // parties' detail screens permanently show the "confirm cancellation" /
      // "waiting for the other party" banner even after the deal was already
      // cancelled, since those checks only looked at cancelRequestedBy being
      // non-null and never at the deal's actual status.
      cancelRequestedBy: admin.firestore.FieldValue.delete(),
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    notify = {
      targetUid: otherPartyId,
      type: "escrow_cancelled",
      title: "Escrow deal cancelled",
      body: "Both parties confirmed cancellation - any unreleased funds have been refunded to the buyer.",
    };

    return { ...data, status: EscrowStatus.CANCELLED, tranches: updatedTranches, cancelRequestedBy: null };
  });

  if (notify) {
    await notifyUser(notify.targetUid, {
      type: notify.type,
      title: notify.title,
      body: notify.body,
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error(`notifyUser (${notify.type}) failed:`, err));
  }

  return result;
}

// Item 3/4: generic admin override so an admin can correct escrow metadata
// (amount/commission/title/description) for exceptional cases the normal
// flows don't cover - e.g. a job-escrow dispute where the skillsman already
// spent money on transport and the amount needs adjusting. Every call must
// include a reason and is written to the audit log. Blocked once the
// agreement is settled (released/refunded/cancelled) to avoid silently
// desyncing amountKobo from tranches that already reflect a different
// total - for a settled agreement, resolve at the tranche level instead via
// disputeTranche + adminResolveTranche.
async function adminUpdateAgreement(agreementId, adminUid, changes, reason) {
  if (!reason) throw new Error("reason is required for an admin edit");

  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error("Agreement not found");
  const data = snap.data();

  const EDIT_BLOCKED_STATUSES = [
    EscrowStatus.RELEASED,
    EscrowStatus.REFUNDED,
    EscrowStatus.CANCELLED,
  ];
  const editingMoney = "amountKobo" in changes || "commissionKobo" in changes;
  if (editingMoney && EDIT_BLOCKED_STATUSES.includes(data.status)) {
    throw new Error(`Cannot edit amounts on an agreement with status "${data.status}"`);
  }

  const update = {};
  const previousValue = {};
  const newValue = {};
  for (const field of ADMIN_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes, field)) {
      update[field] = changes[field];
      previousValue[field] = data[field] ?? null;
      newValue[field] = changes[field];
    }
  }

  if (Object.keys(update).length === 0) {
    throw new Error("No editable fields provided");
  }

  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await docRef.update(update);

  await recordAuditLog({
    userId: adminUid,
    action: "escrow_admin_update",
    targetType: "escrowAgreement",
    targetId: agreementId,
    agreementId,
    previousValue,
    newValue,
    reason,
  });

  await Promise.all(
    [data.buyerId, data.sellerId]
      .filter(Boolean)
      .map((uid) =>
        notifyUser(uid, {
          type: "escrow_admin_update",
          title: "Escrow agreement updated by admin",
          body: `An admin updated this agreement: ${reason}`,
          relatedType: "escrow",
          relatedId: agreementId,
        }).catch((err) => console.error("notifyUser (escrow_admin_update) failed:", err))
      )
  );

  return (await docRef.get()).data();
}

// Fields adminUpdateTranche is allowed to touch. Deliberately excludes
// releaseCondition (timing) and status - status changes go through the
// dedicated release/refund transactions below so wallet balances always
// stay consistent with the tranche's recorded status.
const TRANCHE_ADMIN_EDITABLE_FIELDS = ["amountKobo", "label"];

// Admin-only: edits a single tranche's amount/label. Only allowed while the
// tranche is still PENDING - once it's released or refunded, real money has
// already moved, and once it's disputed, the intended path is to resolve it
// (adminResolveTranche) or fold it into an adminForceCancelDeal decision,
// not silently rewrite its numbers.
async function adminUpdateTranche(agreementId, trancheId, adminUid, changes, reason) {
  if (!reason || !reason.trim()) {
    throw new Error("A reason is required for an admin tranche edit");
  }

  const filteredChanges = {};
  for (const field of TRANCHE_ADMIN_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes || {}, field)) {
      filteredChanges[field] = changes[field];
    }
  }
  if (Object.keys(filteredChanges).length === 0) {
    throw new Error("No editable fields provided");
  }

  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  let previousValue = null;

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();
    const tranches = data.tranches || [];
    const index = tranches.findIndex((t) => t.id === trancheId);
    if (index === -1) throw new Error("Tranche not found");
    const tranche = tranches[index];

    if (tranche.status !== TrancheStatus.PENDING) {
      throw new Error(
        `Cannot edit a tranche with status "${tranche.status}" - only pending tranches can be edited`
      );
    }

    previousValue = { amountKobo: tranche.amountKobo, label: tranche.label };

    const updatedTranches = [...tranches];
    updatedTranches[index] = { ...tranche, ...filteredChanges };

    tx.update(docRef, {
      tranches: updatedTranches,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ...data, tranches: updatedTranches };
  });

  await recordAuditLog({
    userId: adminUid,
    action: "escrow_tranche_edited",
    targetType: "escrowTranche",
    targetId: `${agreementId}/${trancheId}`,
    agreementId,
    previousValue,
    newValue: filteredChanges,
    reason,
  }).catch((err) => console.error("recordAuditLog (tranche edited) failed:", err));

  return result;
}

// Statuses a deal must be in for adminForceCancelDeal to make sense - money
// actually exists to move (funded), and the deal hasn't already fully
// settled one way or another.
const FORCE_CANCELLABLE_STATUSES = [
  EscrowStatus.FUNDED,
  EscrowStatus.PARTIALLY_RELEASED,
  EscrowStatus.DISPUTED,
];

// Turns one tranche's decision into a validated splits array of
// { recipient: "buyer" | "seller" | "admin_wallet", amountKobo }. Accepts
// the plain "release"/"refund" string (the common case - all of it to one
// side) alongside an actual array (the admin chose to split it), so the
// simple case stays a one-line decision while a genuinely mixed outcome
// (e.g. refund a job-skillsman's transport cost, release the rest) is
// still expressible. Every kobo of the tranche must be accounted for -
// deliberately no silent remainder and no default "leftover goes to
// admin_wallet": the admin has to say where every part of it goes.
function normalizeForceCancelDecision(tranche, decision) {
  let splits;
  if (decision === "release") {
    splits = [{ recipient: "seller", amountKobo: tranche.amountKobo }];
  } else if (decision === "refund") {
    splits = [{ recipient: "buyer", amountKobo: tranche.amountKobo }];
  } else if (Array.isArray(decision) && decision.length > 0) {
    splits = decision;
  } else {
    throw new Error(`Invalid decision for tranche "${tranche.label || tranche.id}"`);
  }

  const validRecipients = ["buyer", "seller", "admin_wallet"];
  let sum = 0;
  for (const split of splits) {
    if (!validRecipients.includes(split && split.recipient)) {
      throw new Error(
        `Invalid split recipient for tranche "${tranche.label || tranche.id}" - must be buyer, seller, or admin_wallet`
      );
    }
    if (!Number.isInteger(split.amountKobo) || split.amountKobo <= 0) {
      throw new Error(
        `Split amounts must be positive whole numbers (tranche "${tranche.label || tranche.id}")`
      );
    }
    sum += split.amountKobo;
  }
  if (sum !== tranche.amountKobo) {
    throw new Error(
      `Split amounts for tranche "${tranche.label || tranche.id}" total ${sum} kobo but the ` +
        `tranche is ${tranche.amountKobo} kobo - every kobo has to be accounted for, with ` +
        "nothing created or lost"
    );
  }

  return splits;
}

// Admin-only: ends a deal immediately, without needing both parties to
// mutually confirm and without requiring a formal dispute first - for
// situations like an inexperienced user who messages admin directly
// instead of using the in-app Dispute button, or a deal that's stuck with
// no cooperation between the parties.
//
// `decisions` is { [trancheId]: "release" | "refund" | Split[] } and MUST
// cover every tranche still PENDING or DISPUTED on the agreement - see
// normalizeForceCancelDecision for what a Split[] looks like. Tranches
// already RELEASED or REFUNDED are left untouched - force-cancelling
// doesn't claw back money that already changed hands. No cap on the amount
// this can move; the Flutter app is expected to show a clear confirmation
// (with the exact total per recipient) before calling this, since it's
// irreversible.
async function adminForceCancelDeal(agreementId, adminUid, decisions, reason) {
  if (!reason || !reason.trim()) {
    throw new Error("A reason is required to force-cancel a deal");
  }

  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  let buyerId = null;
  let sellerId = null;
  let previousStatus = null;
  const actionsSummary = [];

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();
    buyerId = data.buyerId;
    sellerId = data.sellerId;
    previousStatus = data.status;

    if (!FORCE_CANCELLABLE_STATUSES.includes(data.status)) {
      throw new Error(
        `Cannot force-cancel from status "${data.status}" - either nothing has been funded yet, or the deal has already fully settled`
      );
    }

    const tranches = data.tranches || [];
    const openTranches = tranches.filter(
      (t) => t.status === TrancheStatus.PENDING || t.status === TrancheStatus.DISPUTED
    );
    const missing = openTranches.filter((t) => !(decisions || {})[t.id]);
    if (missing.length > 0) {
      throw new Error(
        `Missing a decision for tranche(s): ${missing.map((t) => t.label || t.id).join(", ")}`
      );
    }

    const updatedTranches = [...tranches];
    for (const tranche of openTranches) {
      const splits = normalizeForceCancelDecision(tranche, decisions[tranche.id]);
      const index = updatedTranches.findIndex((t) => t.id === tranche.id);
      const resolvedAt = admin.firestore.Timestamp.now();

      const singleRecipient = splits.length === 1 ? splits[0].recipient : null;
      // Kept as "release"/"refund" for the common single-recipient case so
      // every existing reader of adminResolution.outcome (the tranche
      // card, the audit log) keeps working unchanged; "admin_wallet" and
      // "split" are new values only a genuinely split/redirected tranche
      // produces.
      const outcome =
        singleRecipient === "seller"
          ? "release"
          : singleRecipient === "buyer"
            ? "refund"
            : singleRecipient === "admin_wallet"
              ? "admin_wallet"
              : "split";

      for (const split of splits) {
        const recipientUid =
          split.recipient === "seller"
            ? sellerId
            : split.recipient === "buyer"
              ? buyerId
              : ADMIN_WALLET_UID;

        const walletRef = db.collection("wallets").doc(recipientUid);
        tx.set(
          walletRef,
          {
            balanceKobo: admin.firestore.FieldValue.increment(split.amountKobo),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        recordWalletTransaction(tx, {
          uid: recipientUid,
          amountKobo: split.amountKobo,
          type: LEDGER_TYPES.ADMIN_FORCE_CANCEL,
          agreementId,
          trancheId: tranche.id,
          reason,
          recipientRole: split.recipient,
        });

        actionsSummary.push({
          trancheId: tranche.id,
          trancheLabel: tranche.label,
          outcome: split.recipient === "seller" ? "release" : split.recipient === "buyer" ? "refund" : "admin_wallet",
          amountKobo: split.amountKobo,
          recipientUid,
          recipientRole: split.recipient,
        });
      }

      // Single recipient to buyer/seller keeps the familiar
      // RELEASED/REFUNDED status everything already reads (tranche
      // progress counters, filters, etc.); anything else - multiple
      // recipients, or the whole tranche redirected to the admin wallet -
      // is SETTLED, since neither existing label describes it honestly.
      const newTrancheStatus =
        singleRecipient === "seller"
          ? TrancheStatus.RELEASED
          : singleRecipient === "buyer"
            ? TrancheStatus.REFUNDED
            : TrancheStatus.SETTLED;

      updatedTranches[index] = {
        ...tranche,
        status: newTrancheStatus,
        releasedAt: resolvedAt,
        splits,
        adminResolution: { by: adminUid, outcome, reason, resolvedAt },
      };
    }

    tx.update(docRef, {
      tranches: updatedTranches,
      status: EscrowStatus.CANCELLED,
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ...data, tranches: updatedTranches, status: EscrowStatus.CANCELLED };
  });

  await Promise.all(
    [buyerId, sellerId]
      .filter(Boolean)
      .map((uid) =>
        notifyUser(uid, {
          type: "escrow_force_cancelled",
          title: "Escrow deal closed by admin",
          body: `An admin ended this deal: ${reason}`,
          relatedType: "escrow",
          relatedId: agreementId,
        }).catch((err) => console.error("notifyUser (force cancelled) failed:", err))
      )
  );

  await recordAuditLog({
    userId: adminUid,
    action: "escrow_force_cancelled",
    targetType: "escrowAgreement",
    targetId: agreementId,
    agreementId,
    previousValue: { status: previousStatus },
    newValue: { status: EscrowStatus.CANCELLED, decisions: actionsSummary },
    reason,
  }).catch((err) => console.error("recordAuditLog (force cancelled) failed:", err));

  return result;
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
  requestOrConfirmCancel,
  adminUpdateAgreement,
  adminUpdateTranche,
  adminForceCancelDeal,
  listAllAgreements,
};