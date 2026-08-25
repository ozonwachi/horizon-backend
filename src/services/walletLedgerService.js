const { supabase } = require("../config/supabaseAdmin");

// Every wallet balance change - release, refund, deposit, withdrawal,
// admin adjustment - writes one of these alongside it. The actual
// balance-write-plus-ledger-row pairing now happens atomically inside the
// Postgres wallet_adjust() function (see
// project_supabase_migration_02_escrow_wallet_functions.sql) rather than a
// Firestore transaction - the JS side just reads it back for display.
const LEDGER_TABLE = "wallet_transactions";

// A dedicated wallet for money an admin has explicitly decided doesn't
// belong to the buyer or the seller when force-cancelling a deal (see
// adminForceCancelDeal's split support in escrowService.js) - never
// created implicitly, never a place money ends up by accident.
//
// Firestore used a sentinel string ("_admin_wallet_") that could never
// collide with a real uid. Postgres needs a real row in auth.users to
// satisfy the wallets/wallet_transactions foreign keys, so this is now a
// real Supabase Auth uid - create that account once via the Supabase
// dashboard (Authentication > Users > Add user) and set its uuid as
// ADMIN_WALLET_UID in the backend's environment. See the schema file's
// seed note for the exact steps.
//
// Deliberately lazy (throws only when actually read) rather than crashing
// the whole server at startup, since most of the backend works fine before
// this one env var is set - only adminForceCancelDeal's "admin_wallet"
// split option and the admin wallet screen need it.
function getAdminWalletUid() {
  const uid = process.env.ADMIN_WALLET_UID;
  if (!uid) {
    throw new Error(
      "ADMIN_WALLET_UID is not set. Create a dedicated Supabase Auth user for " +
        "the platform wallet (Authentication > Users > Add user), insert a " +
        "matching row into public.profiles (is_admin = true) and public.wallets, " +
        "then set ADMIN_WALLET_UID to that user's uuid in your environment."
    );
  }
  return uid;
}

const TYPES = {
  ESCROW_RELEASE: "escrow_release", // seller credited when a tranche/deal releases
  ESCROW_REFUND: "escrow_refund", // buyer credited when a tranche/deal refunds
  ESCROW_PAYMENT: "escrow_payment", // buyer debited paying for a deal from wallet balance
  DEPOSIT: "deposit", // Paystack top-up landing in the wallet
  WITHDRAWAL: "withdrawal", // payout request debiting the wallet
  WITHDRAWAL_REJECTED: "withdrawal_rejected", // rejected request crediting it back
  ADMIN_FORCE_CANCEL: "admin_force_cancel", // a force-cancel split decision
};

// Row -> the same camelCase shape the Flutter WalletTransaction model and
// the old Firestore doc.data() both used, so nothing downstream has to
// change. createdAt is a plain ISO string - WalletTransaction._parseDate
// already accepts that (it was written to accept either an ISO string or
// Firestore's old {_seconds} shape).
function toWalletTransaction(row) {
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

async function listWalletTransactions(uid, limit = 100) {
  const { data, error } = await supabase
    .from(LEDGER_TABLE)
    .select("*")
    .eq("uid", uid)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(toWalletTransaction);
}

module.exports = {
  LEDGER_TABLE,
  getAdminWalletUid,
  TYPES,
  toWalletTransaction,
  listWalletTransactions,
};
