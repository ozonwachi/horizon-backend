const { db, admin } = require("../config/firebaseAdmin");
const paystackService = require("./paystackService");
const { notifyUser, notifyUsers } = require("./notificationService");
const { listAdminUids } = require("./conversationService");
const {
  ADMIN_WALLET_UID,
  TYPES: LEDGER_TYPES,
  recordWalletTransaction,
  listWalletTransactions,
} = require("./walletLedgerService");

const WALLETS_COLLECTION = "wallets";
const WITHDRAWALS_COLLECTION = "withdrawalRequests";

const WithdrawalStatus = {
  PENDING: "pending",
  PAID: "paid",
  REJECTED: "rejected",
};

async function getBalance(uid) {
  const snap = await db.collection(WALLETS_COLLECTION).doc(uid).get();
  if (!snap.exists) return 0;
  return snap.data().balanceKobo || 0;
}

async function creditWallet(uid, amountKobo, { type = LEDGER_TYPES.DEPOSIT, reason } = {}) {
  const walletRef = db.collection(WALLETS_COLLECTION).doc(uid);
  await db.runTransaction(async (tx) => {
    tx.set(
      walletRef,
      {
        balanceKobo: admin.firestore.FieldValue.increment(amountKobo),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    recordWalletTransaction(tx, { uid, amountKobo, type, reason });
  });
  return getBalance(uid);
}

async function initiateDeposit({ uid, email, amountKobo }) {
  if (!amountKobo || amountKobo <= 0) {
    throw new Error("amountKobo must be greater than 0");
  }

  const reference = `horizon_deposit_${uid}_${Date.now()}`;

  const tx = await paystackService.initializeTransaction({
    email,
    amountKobo,
    reference,
    metadata: { type: "wallet_deposit", uid },
  });

  return { authorizationUrl: tx.authorization_url, reference: tx.reference };
}

async function confirmDeposit({ uid, amountKobo, reference }) {
  const newBalance = await creditWallet(uid, amountKobo);
  return { uid, amountKobo, reference, balanceKobo: newBalance };
}

async function verifyDeposit({ uid, reference }) {
  const tx = await paystackService.verifyTransaction(reference);
  if (tx.status !== "success") {
    throw new Error(`Transaction status: ${tx.status}`);
  }
  return confirmDeposit({ uid, amountKobo: tx.amount, reference });
}

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

  const request = await db.runTransaction(async (tx) => {
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
    recordWalletTransaction(tx, {
      uid,
      amountKobo: -amountKobo,
      type: LEDGER_TYPES.WITHDRAWAL,
      reason: `Withdrawal to ${bankName} (${accountNumber})`,
    });

    const newRequest = {
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
    tx.set(requestRef, newRequest);

    return newRequest;
  });

  // Fire-and-forget, and deliberately outside the transaction above - a
  // Firestore transaction can retry its callback on contention, and a
  // notifyUser call inside it would then risk firing more than once for
  // the same request. Nothing previously told admins a withdrawal request
  // existed at all - it just sat pending until someone happened to look.
  const adminUids = await listAdminUids().catch((err) => {
    console.error("listAdminUids (withdrawal request) failed:", err);
    return [];
  });
  await notifyUsers(adminUids, {
    type: "withdrawal_requested",
    title: "New withdrawal request",
    body: `${accountName} requested ₦${(amountKobo / 100).toFixed(2)} to ${bankName} (${accountNumber}).`,
    relatedType: "withdrawal",
    relatedId: request.id,
  }).catch((err) => console.error("notifyUsers (withdrawal_requested) failed:", err));

  return request;
}

async function listWithdrawalsForUser(uid) {
  const snap = await db
    .collection(WITHDRAWALS_COLLECTION)
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((doc) => doc.data());
}

// Admin-only: every withdrawal request across every user, newest first.
// Deliberately no `where` clause - equality-filter-plus-orderBy is exactly
// the query shape that needs a Firestore composite index (see
// listWithdrawalsForUser/listWalletTransactions above, and the identical
// gotcha already documented in notifications_screen.dart on the Flutter
// side). A single-field orderBy needs no composite index at all, so the
// Admin Withdrawals screen filters by status client-side instead of
// pushing that requirement onto a brand new collection query.
async function listAllWithdrawalsAdmin(limit = 200) {
  const snap = await db
    .collection(WITHDRAWALS_COLLECTION)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((doc) => doc.data());
}

async function markWithdrawalPaid(requestId) {
  const ref = db.collection(WITHDRAWALS_COLLECTION).doc(requestId);

  // Was a plain unconditional update before - nothing stopped a second
  // "Mark Paid" tap (or a request that had already been rejected) from
  // going through again and re-notifying the requester. Guarded the same
  // way rejectWithdrawal already was.
  const updated = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Withdrawal request not found");
    const data = snap.data();

    if (data.status !== WithdrawalStatus.PENDING) {
      throw new Error(`Cannot mark a request with status "${data.status}" as paid`);
    }

    tx.update(ref, {
      status: WithdrawalStatus.PAID,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ...data, status: WithdrawalStatus.PAID };
  });

  await notifyUser(updated.uid, {
    type: "withdrawal_paid",
    title: "Withdrawal paid",
    body: `Your ₦${(updated.amountKobo / 100).toFixed(2)} withdrawal to ${updated.bankName} has been paid.`,
    relatedType: "withdrawal",
    relatedId: requestId,
  }).catch((err) => console.error("notifyUser (withdrawal_paid) failed:", err));

  return updated;
}

async function rejectWithdrawal(requestId, reason) {
  const ref = db.collection(WITHDRAWALS_COLLECTION).doc(requestId);

  const updated = await db.runTransaction(async (tx) => {
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
    recordWalletTransaction(tx, {
      uid: data.uid,
      amountKobo: data.amountKobo,
      type: LEDGER_TYPES.WITHDRAWAL_REJECTED,
      reason: reason || "Withdrawal request rejected",
    });

    tx.update(ref, {
      status: WithdrawalStatus.REJECTED,
      rejectionReason: reason || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ...data, status: WithdrawalStatus.REJECTED };
  });

  await notifyUser(updated.uid, {
    type: "withdrawal_rejected",
    title: "Withdrawal rejected",
    body: reason
      ? `Your ₦${(updated.amountKobo / 100).toFixed(2)} withdrawal was rejected: ${reason}. It's been credited back to your wallet.`
      : `Your ₦${(updated.amountKobo / 100).toFixed(2)} withdrawal was rejected. It's been credited back to your wallet.`,
    relatedType: "withdrawal",
    relatedId: requestId,
  }).catch((err) => console.error("notifyUser (withdrawal_rejected) failed:", err));

  return updated;
}

module.exports = {
  WithdrawalStatus,
  ADMIN_WALLET_UID,
  getBalance,
  creditWallet,
  initiateDeposit,
  confirmDeposit,
  verifyDeposit,
  requestWithdrawal,
  listWithdrawalsForUser,
  listAllWithdrawalsAdmin,
  markWithdrawalPaid,
  rejectWithdrawal,
  // Own wallet history, and (admin-only, gated in the route) the admin
  // wallet's balance/history - same underlying ledger collection, just a
  // different uid.
  listTransactions: listWalletTransactions,
  getAdminWalletBalance: () => getBalance(ADMIN_WALLET_UID),
  listAdminWalletTransactions: (limit) => listWalletTransactions(ADMIN_WALLET_UID, limit),
};