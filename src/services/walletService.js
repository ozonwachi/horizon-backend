const { db, admin } = require("../config/firebaseAdmin");
const paystackService = require("./paystackService");
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
    recordWalletTransaction(tx, {
      uid,
      amountKobo: -amountKobo,
      type: LEDGER_TYPES.WITHDRAWAL,
      reason: `Withdrawal to ${bankName} (${accountNumber})`,
    });

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

async function listWithdrawalsForUser(uid) {
  const snap = await db
    .collection(WITHDRAWALS_COLLECTION)
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((doc) => doc.data());
}

async function markWithdrawalPaid(requestId) {
  const ref = db.collection(WITHDRAWALS_COLLECTION).doc(requestId);
  await ref.update({
    status: WithdrawalStatus.PAID,
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return (await ref.get()).data();
}

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
  markWithdrawalPaid,
  rejectWithdrawal,
  // Own wallet history, and (admin-only, gated in the route) the admin
  // wallet's balance/history - same underlying ledger collection, just a
  // different uid.
  listTransactions: listWalletTransactions,
  getAdminWalletBalance: () => getBalance(ADMIN_WALLET_UID),
  listAdminWalletTransactions: (limit) => listWalletTransactions(ADMIN_WALLET_UID, limit),
};