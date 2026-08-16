const { db, admin } = require("../config/firebaseAdmin");

const ESCROW_COLLECTION = "escrowAgreements";
const COMMISSION_COLLECTION = "commissionRules";

// Statuses an EscrowAgreement can move through. Keep this centralized so
// the Flutter app and backend agree on the same string values.
const EscrowStatus = {
  PENDING_PAYMENT: "pending_payment",
  FUNDED: "funded",
  RELEASED: "released",
  DISPUTED: "disputed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
};

// Looks up the applicable CommissionRule for a given type/category and
// computes the commission in kobo. Falls back to 0 if no rule matches -
// tune this default to whatever makes sense once real rules exist.
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
    // flat, already stored in kobo
    commissionKobo = rule.value;
  }

  if (rule.minKobo != null) commissionKobo = Math.max(commissionKobo, rule.minKobo);
  if (rule.maxKobo != null) commissionKobo = Math.min(commissionKobo, rule.maxKobo);

  return { commissionKobo, rule };
}

// Creates a new EscrowAgreement in pending_payment state. The commission is
// locked in at creation time (per your build notes) so later CommissionRule
// changes don't retroactively affect deals already in progress.
async function createAgreement({
  buyerId,
  sellerId,
  type, // "listing" | "job" | "barter" | custom
  category,
  amountKobo,
  terms, // free-form object: simple release-on-confirmation or custom conditions
  referenceId, // id of the listing/job/barter this escrow is tied to
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

// Marks an agreement funded once Paystack verification succeeds. Called
// from the webhook handler or the verify-after-redirect route - never from
// a route that just trusts client input.
async function markFunded(agreementId, paystackReference) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  await docRef.update({
    status: EscrowStatus.FUNDED,
    paystackReference,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return (await docRef.get()).data();
}

// Releases funds to the seller. Actual money movement (Paystack transfer)
// happens in the route handler using paystackService - this just updates
// the record of truth in Firestore.
async function markReleased(agreementId) {
  const docRef = db.collection(ESCROW_COLLECTION).doc(agreementId);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error("Agreement not found");
  const data = snap.data();

  if (data.status !== EscrowStatus.FUNDED) {
    throw new Error(`Cannot release from status "${data.status}"`);
  }

  await docRef.update({
    status: EscrowStatus.RELEASED,
    releasedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return (await docRef.get()).data();
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

// Lists all agreements where the user is either buyer or seller, newest
// first. Firestore doesn't support OR queries across different fields in
// one call, so we run two queries and merge the results.
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

  // De-dupe in the unlikely case a user is somehow both buyer and seller,
  // and sort the merged list by createdAt descending.
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
  listForUser,
};