import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as paystackService from "./paystackService.ts";
import { notifyUser, notifyUsers } from "./notificationService.ts";
import { listAdminUids } from "./conversationService.ts";
import { getAdminWalletUid, TYPES as LEDGER_TYPES, listWalletTransactions } from "./walletLedgerService.ts";
import { recordAuditLog } from "./auditLogService.ts";

const WALLETS_TABLE = "wallets";
const WITHDRAWALS_TABLE = "withdrawal_requests";

export const WithdrawalStatus = {
  PENDING: "pending",
  PAID: "paid",
  REJECTED: "rejected",
} as const;

export type WithdrawalRequest = {
  id: string;
  uid: string;
  amountKobo: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
  status: string;
  createdAt: string;
  rejectionReason: string | null;
};

// Row -> the camelCase shape WithdrawalRequest.fromJson (Flutter) expects.
// deno-lint-ignore no-explicit-any
function toWithdrawalRequest(row: any): WithdrawalRequest {
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

export async function getBalance(supabase: SupabaseClient, uid: string): Promise<number> {
  const { data, error } = await supabase
    .from(WALLETS_TABLE)
    .select("balance_kobo")
    .eq("uid", uid)
    .maybeSingle();
  if (error) throw error;
  return data?.balance_kobo || 0;
}

export async function creditWallet(
  supabase: SupabaseClient,
  uid: string,
  amountKobo: number,
  { type = LEDGER_TYPES.DEPOSIT, reason }: { type?: string; reason?: string | null } = {}
): Promise<number> {
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
  return getBalance(supabase, uid);
}

// Requested feature: admin wallet credit - previously AdminWalletScreen was
// entirely read-only (see its doc comment: "no 'add money' ... on purpose",
// referring to the special admin commission-collection wallet). This is a
// different thing: crediting an ORDINARY user's wallet directly, for cases
// like a manual goodwill credit, a refund that didn't fit the normal escrow
// refund path, or paying out an off-platform-deal report reward (see
// offPlatformDealReportService.ts). Reuses creditWallet's existing
// wallet_adjust RPC (the only path that's allowed to move a wallet balance
// at all - RLS blocks a direct table write), just with an admin-specific
// ledger type and an audit trail, since unlike a deposit or an escrow
// payout this has no other transaction backing it.
export async function adminCreditWallet(
  supabase: SupabaseClient,
  adminUid: string,
  targetUid: string,
  amountKobo: number,
  reason: string,
  // Lets a more specific caller (e.g. off-platform-deal reward payouts)
  // tag the ledger row with its own type instead of the generic
  // ADMIN_CREDIT, so it's distinguishable in the recipient's transaction
  // history - defaults to the plain admin-credit case.
  ledgerType: string = LEDGER_TYPES.ADMIN_CREDIT
): Promise<number> {
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
    throw new Error("amountKobo must be a positive number.");
  }
  const trimmedReason = (reason || "").trim();
  if (!trimmedReason) {
    throw new Error("A reason is required for an admin wallet credit.");
  }

  const newBalance = await creditWallet(supabase, targetUid, amountKobo, {
    type: ledgerType,
    reason: trimmedReason,
  });

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "wallet_admin_credit",
    targetType: "userAccount",
    targetId: targetUid,
    newValue: { amountKobo, reason: trimmedReason },
    reason: trimmedReason,
  }).catch((err) => console.error("recordAuditLog (wallet_admin_credit) failed:", err));

  await notifyUser(supabase, targetUid, {
    type: "wallet_admin_credit",
    title: "Your wallet was credited",
    body: `An admin credited your wallet with ₦${(amountKobo / 100).toFixed(2)}: ${trimmedReason}`,
    relatedType: "wallet",
    relatedId: targetUid,
    important: true,
  }).catch((err) => console.error("notifyUser (wallet_admin_credit) failed:", err));

  return newBalance;
}

export async function initiateDeposit(
  _supabase: SupabaseClient,
  { uid, email, amountKobo }: { uid: string; email: string | null; amountKobo: number }
) {
  if (!amountKobo || amountKobo <= 0) {
    throw new Error("amountKobo must be greater than 0");
  }

  const reference = `horizon_deposit_${uid}_${Date.now()}`;

  const tx = await paystackService.initializeTransaction({
    email: email || "",
    amountKobo,
    reference,
    metadata: { type: "wallet_deposit", uid },
  });

  return { authorizationUrl: tx.authorization_url, reference: tx.reference };
}

export async function confirmDeposit(
  supabase: SupabaseClient,
  { uid, amountKobo, reference }: { uid: string; amountKobo: number; reference: string }
) {
  const newBalance = await creditWallet(supabase, uid, amountKobo);
  return { uid, amountKobo, reference, balanceKobo: newBalance };
}

export async function verifyDeposit(
  supabase: SupabaseClient,
  { uid, reference }: { uid: string; reference: string }
) {
  const tx = await paystackService.verifyTransaction(reference);
  if (tx.status !== "success") {
    throw new Error(`Transaction status: ${tx.status}`);
  }
  return confirmDeposit(supabase, { uid, amountKobo: tx.amount, reference });
}

export async function requestWithdrawal(
  supabase: SupabaseClient,
  {
    uid,
    amountKobo,
    bankName,
    accountNumber,
    accountName,
  }: { uid: string; amountKobo: number; bankName: string; accountNumber: string; accountName: string }
): Promise<WithdrawalRequest> {
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

  // Fire-and-forget, deliberately outside the RPC above (a notify call
  // shouldn't be able to make the transactional part retry). Nothing
  // previously told admins a withdrawal request existed at all - it just
  // sat pending until someone happened to look.
  const adminUids = await listAdminUids(supabase).catch((err) => {
    console.error("listAdminUids (withdrawal request) failed:", err);
    return [] as string[];
  });
  await notifyUsers(supabase, adminUids, {
    type: "withdrawal_requested",
    title: "New withdrawal request",
    body: `${accountName} requested ₦${(amountKobo / 100).toFixed(2)} to ${bankName} (${accountNumber}).`,
    relatedType: "withdrawal",
    relatedId: request.id,
  }).catch((err) => console.error("notifyUsers (withdrawal_requested) failed:", err));

  return request;
}

export async function listWithdrawalsForUser(supabase: SupabaseClient, uid: string): Promise<WithdrawalRequest[]> {
  const { data, error } = await supabase
    .from(WITHDRAWALS_TABLE)
    .select("*")
    .eq("uid", uid)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(toWithdrawalRequest);
}

// Admin-only: every withdrawal request across every user, newest first.
export async function listAllWithdrawalsAdmin(supabase: SupabaseClient, limit = 200): Promise<WithdrawalRequest[]> {
  const { data, error } = await supabase
    .from(WITHDRAWALS_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(toWithdrawalRequest);
}

export async function markWithdrawalPaid(
  supabase: SupabaseClient,
  requestId: string,
  adminUid: string
): Promise<WithdrawalRequest> {
  const { data: row, error } = await supabase.rpc("wallet_mark_withdrawal_paid", {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  const updated = toWithdrawalRequest(row);

  // Security fix: this was previously a real money-moving admin action with
  // no audit trail at all - every other admin override records one.
  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "withdrawal_marked_paid",
    targetType: "withdrawal_request",
    targetId: requestId,
    newValue: { amountKobo: updated.amountKobo, uid: updated.uid },
  }).catch((err) => console.error("recordAuditLog (withdrawal_marked_paid) failed:", err));

  await notifyUser(supabase, updated.uid, {
    type: "withdrawal_paid",
    title: "Withdrawal paid",
    body: `Your ₦${(updated.amountKobo / 100).toFixed(2)} withdrawal to ${updated.bankName} has been paid.`,
    relatedType: "withdrawal",
    relatedId: requestId,
    important: true,
  }).catch((err) => console.error("notifyUser (withdrawal_paid) failed:", err));

  return updated;
}

export async function rejectWithdrawal(
  supabase: SupabaseClient,
  requestId: string,
  reason: string | null | undefined,
  adminUid: string
): Promise<WithdrawalRequest> {
  const { data: row, error } = await supabase.rpc("wallet_reject_withdrawal", {
    p_request_id: requestId,
    p_reason: reason || null,
  });
  if (error) throw new Error(error.message);
  const updated = toWithdrawalRequest(row);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "withdrawal_rejected",
    targetType: "withdrawal_request",
    targetId: requestId,
    newValue: { amountKobo: updated.amountKobo, uid: updated.uid },
    reason: reason || null,
  }).catch((err) => console.error("recordAuditLog (withdrawal_rejected) failed:", err));

  await notifyUser(supabase, updated.uid, {
    type: "withdrawal_rejected",
    title: "Withdrawal rejected",
    body: reason
      ? `Your ₦${(updated.amountKobo / 100).toFixed(2)} withdrawal was rejected: ${reason}. It's been credited back to your wallet.`
      : `Your ₦${(updated.amountKobo / 100).toFixed(2)} withdrawal was rejected. It's been credited back to your wallet.`,
    relatedType: "withdrawal",
    relatedId: requestId,
    important: true,
  }).catch((err) => console.error("notifyUser (withdrawal_rejected) failed:", err));

  return updated;
}

// Own wallet history, and (admin-only, gated in the route) the admin
// wallet's balance/history - same underlying ledger table, just a
// different uid. getAdminWalletUid() throws with a clear message if
// ADMIN_WALLET_UID hasn't been configured yet.
export const listTransactions = listWalletTransactions;

export function getAdminWalletBalance(supabase: SupabaseClient) {
  return getBalance(supabase, getAdminWalletUid());
}

export function listAdminWalletTransactions(supabase: SupabaseClient, limit?: number) {
  return listWalletTransactions(supabase, getAdminWalletUid(), limit);
}

// Self-serve "I took this deal off-platform, here's the connection fee"
// payment - see pay_connection_fee() in
// project_supabase_migration_17_connection_fee_and_contact_flags.sql for
// the actual atomic debit+credit. Debits the caller, credits the admin
// wallet, in one transaction; then lets admins know it happened (not
// urgent, just visible - same treatment as a withdrawal request).
export async function payConnectionFee(
  supabase: SupabaseClient,
  { uid, amountKobo, note }: { uid: string; amountKobo: number; note?: string | null }
): Promise<{ balanceKobo: number }> {
  if (!amountKobo || amountKobo <= 0) {
    throw new Error("amountKobo must be greater than 0");
  }

  const { error } = await supabase.rpc("pay_connection_fee", {
    p_uid: uid,
    p_amount_kobo: amountKobo,
    p_admin_wallet_uid: getAdminWalletUid(),
    p_note: note || null,
  });
  if (error) throw new Error(error.message);

  const balanceKobo = await getBalance(supabase, uid);

  const adminUids = await listAdminUids(supabase).catch((err) => {
    console.error("listAdminUids (connection fee) failed:", err);
    return [] as string[];
  });

  // Requested: identify the payer in the notification itself, the same way
  // requestWithdrawal() already interpolates accountName into its own
  // admin notification - previously this said only "A user paid...", so an
  // admin had to separately look the uid up in Profiles to know who paid.
  const { data: payerProfile } = await supabase
    .from("profiles")
    .select("name, email")
    .eq("uid", uid)
    .maybeSingle();
  const payerLabel = payerProfile?.name || payerProfile?.email || "A user";

  await notifyUsers(supabase, adminUids, {
    type: "connection_fee_paid",
    title: "Connection fee paid",
    body: `${payerLabel} paid a ₦${(amountKobo / 100).toFixed(2)} connection fee.${note ? ` Note: ${note}` : ""}`,
    relatedType: "wallet",
    relatedId: uid,
  }).catch((err) => console.error("notifyUsers (connection_fee_paid) failed:", err));

  return { balanceKobo };
}
