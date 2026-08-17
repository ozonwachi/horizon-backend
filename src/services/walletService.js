const { db, admin } = require("../config/firebaseAdmin");

const WALLETS_COLLECTION = "wallets";
const WITHDRAWALS_COLLECTION = "withdrawalRequests";

const WithdrawalStatus = {
  PENDING: "pending",
  PAID: "paid",
  REJECTED: "rejected",
};

// Returns the current balance for a user, in kobo. New sellers with no
// wallet document yet simply have a balance of 0.
async function getBalance(uid) {
  const snap = await db.collection(WALLETS_COLLECTION).doc(uid).get();
  if (!snap.exists) return 0;
  return snap.data().balanceKobo || 0;
}

// Creates a withdrawal request and immediately deducts the requested
// amount from the seller's available balance, so they can't request the
// same funds twice while a request is pending. If the request is later
// rejected, the amount is credited back (see rejectWithdrawal).
async function requestWithdrawal({
  uid,
  amountKobo,
  bankName,
  accountNumber,
  accountName,
}) {
  if (!amountKobo || amountKobo <= 0) {
    throw new Error("amountKobo must be greater than 0");
  }
  if (!bankName || !accountNumber || !accountName) {
    throw new Error("bankName, accountNumber, and accountName are required");
  }

  const walletRef = db.collection(WALLETS_COLLECTION).doc(uid);
  const requestRef = db.collection(WITHDRAWALS_COLLECTION).doc();

  return db.runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);
    const currentBalance = walletSnap.exists
      ? walletSnap.data().balanceKobo || 0
      : 0;

    if (amountKobo > currentBalance) {
      throw new Error("Requested amount exceeds available balance");
    }

    tx.set(
      walletRef,
      {
        balanceKobo: admin.firestore.FieldValue.increment(-amountKobo),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const request = {
      id: requestRef.id,
      uid,
      amountKobo,
      bankName,
      accountNumber,
      accountName,
      status: WithdrawalStatus.PENDING,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    tx.set(requestRef, request);

    return request;
  });
}

// Lists a user's own withdrawal requests, newest first.
async function listWithdrawalsForUser(uid) {
  const snap = await db
    .collection(WITHDRAWALS_COLLECTION)
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((doc) => doc.data());
}

// --- Admin-only operations (called manually for now - no admin UI yet) ---

// Marks a withdrawal request as paid, after you've sent the money
// yourself outside the app (bank transfer, etc). Does not touch the
// wallet balance again since it was already deducted at request time.
async function markWithdrawalPaid(requestId) {
  const ref = db.collection(WITHDRAWALS_COLLECTION).doc(requestId);
  await ref.update({
    status: WithdrawalStatus.PAID,
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return (await ref.get()).data();
}

// Rejects a withdrawal request and credits the amount back to the
// seller's balance.
async function rejectWithdrawal(requestId, reason) {
  const ref = db.collection(WITHDRAWALS_COLLECTION).doc(requestId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Withdrawal request not found");
    const data = snap.data();

    if (data.status !== WithdrawalStatus.PENDING) {
      throw new Error(`Cannot reject a request with status "${data.status}"`);
    }

    const walletRef = db.collection(WALLETS_COLLECTION).doc(data.uid);
    tx.set(
      walletRef,
      {
        balanceKobo: admin.firestore.FieldValue.increment(data.amountKobo),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.update(ref, {
      status: WithdrawalStatus.REJECTED,
      rejectionReason: reason || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ...data, status: WithdrawalStatus.REJECTED };
  });
}

module.exports = {
  WithdrawalStatus,
  getBalance,
  requestWithdrawal,
  listWithdrawalsForUser,
  markWithdrawalPaid,
  rejectWithdrawal,
};