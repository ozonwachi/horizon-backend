import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as paystackService from "./paystackService.ts";
import { notifyUser, notifyUsers } from "./notificationService.ts";
import { listAdminUids } from "./conversationService.ts";
import { getAdminWalletUid, TYPES as LEDGER_TYPES, listWalletTransactions } from "./walletLedgerService.ts";

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

export async function markWithdrawalPaid(supabase: SupabaseClient, requestId: string): Promise<WithdrawalRequest> {
  const { data: row, error } = await supabase.rpc("wallet_mark_withdrawal_paid", {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  const updated = toWithdrawalRequest(row);

  await notifyUser(supabase, updated.uid, {
    type: "withdrawal_paid",
    title: "Withdrawal paid",
    body: `Your ₦${(updated.amountKobo / 100).toFixed(2)} withdrawal to ${updated.bankName} has been paid.`,
    relatedType: "withdrawal",
    relatedId: requestId,
  }).catch((err) => console.error("notifyUser (withdrawal_paid) failed:", err));

  return updated;
}

export async function rejectWithdrawal(
  supabase: SupabaseClient,
  requestId: string,
  reason?: string | null
): Promise<WithdrawalRequest> {
  const { data: row, error } = await supabase.rpc("wallet_reject_withdrawal", {
    p_request_id: requestId,
    p_reason: reason || null,
  });
  if (error) throw new Error(error.message);
  const updated = toWithdrawalRequest(row);

  await notifyUser(supabase, updated.uid, {
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
