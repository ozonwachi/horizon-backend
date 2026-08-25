const { supabase } = require("../config/supabaseAdmin");
const paystackService = require("./paystackService");
const { notifyUser, notifyUsers } = require("./notificationService");
const { listAdminUids } = require("./conversationService");
const { getAdminWalletUid, TYPES: LEDGER_TYPES, listWalletTransactions } = require("./walletLedgerService");

const WALLETS_TABLE = "wallets";
const WITHDRAWALS_TABLE = "withdrawal_requests";

const WithdrawalStatus = {
  PENDING: "pending",
  PAID: "paid",
  REJECTED: "rejected",
};

// Row -> the camelCase shape WithdrawalRequest.fromJson (Flutter) and the
// old Firestore doc.data() both used.
function toWithdrawalRequest(row) {
  return {
    id: row.id,
    uid: row.uid,
    amountKobo: row.amount_kobo,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountName: row.account_name,
    status: row.status,
    createdAt: row.created_at,
    rejectionReason: row.rejection_reason,
  };
}

async function getBalance(uid) {
  const { data, error } = await supabase
    .from(WALLETS_TABLE)
    .select("balance_kobo")
    .eq("uid", uid)
    .maybeSingle();
  if (error) throw error;
  return data?.balance_kobo || 0;
}

async function creditWallet(uid, amountKobo, { type = LEDGER_TYPES.DEPOSIT, reason } = {}) {
  const { error } = await supabase.rpc("wallet_adjust", {
    p_uid: uid,
    p_amount_kobo: amountKobo,
    p_type: type,
    p_agreement_id: null,
    p_tranche_id: null,
    p_reason: reason || null,
    p_recipient_role: null,
  });
  if (error) throw error;
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

async function requestWithdrawal({ uid, amountKobo, bankName, accountNumber, accountName }) {
  if (!amountKobo || amountKobo <= 0) {
    throw new Error("amountKobo must be greater than 0");
  }
  if (!bankName || !accountNumber || !accountName) {
    throw new Error("bankName, accountNumber, and accountName are required");
  }

  const { data: requestId, error } = await supabase.rpc("wallet_request_withdrawal", {
    p_uid: uid,
    p_amount_kobo: amountKobo,
    p_bank_name: bankName,
    p_account_number: accountNumber,
    p_account_name: accountName,
  });
  if (error) throw new Error(error.message);

  const { data: row, error: fetchError } = await supabase
    .from(WITHDRAWALS_TABLE)
    .select("*")
    .eq("id", requestId)
    .single();
  if (fetchError) throw fetchError;
  const request = toWithdrawalRequest(row);

  // Fire-and-forget, deliberately outside the RPC above (same reasoning as
  // before: a notify call shouldn't be able to make the transactional part
  // retry). Nothing previously told admins a withdrawal request existed at
  // all - it just sat pending until someone happened to look.
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
  const { data, error } = await supabase
    .from(WITHDRAWALS_TABLE)
    .select("*")
    .eq("uid", uid)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(toWithdrawalRequest);
}

// Admin-only: every withdrawal request across every user, newest first.
async function listAllWithdrawalsAdmin(limit = 200) {
  const { data, error } = await supabase
    .from(WITHDRAWALS_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(toWithdrawalRequest);
}

async function markWithdrawalPaid(requestId) {
  const { data: row, error } = await supabase.rpc("wallet_mark_withdrawal_paid", {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  const updated = toWithdrawalRequest(row);

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
  const { data: row, error } = await supabase.rpc("wallet_reject_withdrawal", {
    p_request_id: requestId,
    p_reason: reason || null,
  });
  if (error) throw new Error(error.message);
  const updated = toWithdrawalRequest(row);

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
  // wallet's balance/history - same underlying ledger table, just a
  // different uid. getAdminWalletUid() throws with a clear message if
  // ADMIN_WALLET_UID hasn't been configured yet - see walletLedgerService.js.
  listTransactions: listWalletTransactions,
  getAdminWalletBalance: () => getBalance(getAdminWalletUid()),
  listAdminWalletTransactions: (limit) => listWalletTransactions(getAdminWalletUid(), limit),
};
