const { db, admin } = require("../config/firebaseAdmin");

const ESCROW_COLLECTION = "escrowAgreements";
const COMMISSION_COLLECTION = "commissionRules";

const EscrowStatus = {
  PENDING_PAYMENT: "pending_payment",
  FUNDED: "funded",
  RELEASED: "released",
  DISPUTED: "disputed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
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

async function createAgreement({
  buyerId,
  sellerId,
  type,
  category,
  amountKobo,
  terms,
  referenceId,
}) {
  const { commissionKobo, rule } = await calculateCommission({
    type,
    category,
    amountKobo,
  });

  const docRef = db.collection(ESCROW_COLLECTION).doc();
  const agreement = {
    id: docRef.id,
    buyerId,
    sellerId,
    type,
    category,
    referenceId: referenceId || null,
    amountKobo,
    commissionKobo,
    commissionRuleId: rule ? rule.id || null : null,
    terms: terms || { releaseOn: "buyer_confirmation" },
    status: EscrowStatus.PENDING_PAYMENT,
    paystackReference: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await docRef.set(agreement);
  return agreement;
}

async function markFunded(agreementId, paystackReference) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  await docRef.update({
    status: EscrowStatus.FUNDED,
    paystackReference,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return (await docRef.get()).data();
}

async function markReleased(agreementId) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("Agreement not found");
    const data = snap.data();

    if (data.status !== EscrowStatus.FUNDED) {
      throw new Error(`Cannot release from status "${data.status}"`);
    }

    tx.update(docRef, {
      status: EscrowStatus.RELEASED,
      releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

    tx.update(agreementRef, {
      status: EscrowStatus.FUNDED,
      paystackReference: null,
      paymentMethod: "wallet",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ...agreement, status: EscrowStatus.FUNDED, paymentMethod: "wallet" };
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
  calculateCommission,
  createAgreement,
  markFunded,
  markReleased,
  markDisputed,
  getAgreement,
  payFromWallet,
  listForUser,
};