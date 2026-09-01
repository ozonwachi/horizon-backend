import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requireSecret } from "./supabaseAdmin.ts";

// Every wallet balance change - release, refund, deposit, withdrawal, admin
// adjustment - writes one of these alongside it. The actual
// balance-write-plus-ledger-row pairing happens atomically inside the
// Postgres wallet_adjust() function; this module just reads it back for
// display and resolves the admin wallet uid.
export const LEDGER_TABLE = "wallet_transactions";

// A dedicated wallet for money an admin has explicitly decided doesn't
// belong to the buyer or the seller when force-cancelling a deal - never
// created implicitly, never a place money ends up by accident. Needs a real
// Supabase Auth uid (Authentication > Users > Add user) with a matching
// profiles/wallets row - see the schema file's seed note.
//
// Deliberately lazy (throws only when actually read) rather than crashing
// on cold start, since most of this backend works fine before this one
// secret is set - only adminForceCancelDeal's "admin_wallet" split option,
// the admin wallet screen, and referral payouts need it.
export function getAdminWalletUid(): string {
  return requireSecret("ADMIN_WALLET_UID");
}

export const TYPES = {
  ESCROW_RELEASE: "escrow_release", // seller credited when a tranche/deal releases
  ESCROW_REFUND: "escrow_refund", // buyer credited when a tranche/deal refunds
  ESCROW_PAYMENT: "escrow_payment", // buyer debited paying for a deal from wallet balance
  DEPOSIT: "deposit", // Paystack top-up landing in the wallet
  WITHDRAWAL: "withdrawal", // payout request debiting the wallet
  WITHDRAWAL_REJECTED: "withdrawal_rejected", // rejected request crediting it back
  ADMIN_FORCE_CANCEL: "admin_force_cancel", // a force-cancel split decision
  CONNECTION_FEE: "connection_fee", // a user self-declaring/paying a fee for a deal taken off-platform
  ADMIN_CREDIT: "admin_credit", // an admin manually crediting a user's wallet
  OFF_PLATFORM_REWARD: "off_platform_reward", // reward paid for a validated off-platform-deal report
} as const;

export type WalletTransaction = {
  id: string;
  uid: string;
  amountKobo: number;
  type: string;
  agreementId: string | null;
  trancheId: string | null;
  reason: string | null;
  recipientRole: string | null;
  createdAt: string;
};

// Row -> the same camelCase shape the Flutter WalletTransaction model
// expects. createdAt is a plain ISO string.
// deno-lint-ignore no-explicit-any
function toWalletTransaction(row: any): WalletTransaction {
  return {
    id: row.id,
    uid: row.uid,
    amountKobo: row.amount_kobo,
    type: row.type,
    agreementId: row.agreement_id,
    trancheId: row.tranche_id,
    reason: row.reason,
    recipientRole: row.recipient_role,
    createdAt: row.created_at,
  };
}

export async function listWalletTransactions(
  supabase: SupabaseClient,
  uid: string,
  limit = 100
): Promise<WalletTransaction[]> {
  const { data, error } = await supabase
    .from(LEDGER_TABLE)
    .select("*")
    .eq("uid", uid)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(toWalletTransaction);
}
