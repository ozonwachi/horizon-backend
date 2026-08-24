const { db, admin } = require("../config/firebaseAdmin");

// Every wallet balance change - release, refund, deposit, withdrawal,
// admin adjustment - writes one of these alongside it, in the same
// Firestore transaction as the balance write itself. Before this existed,
// a wallet's `balanceKobo` was the ONLY record of money moving through
// it: the number changed but nothing said why, so "wallet screen has no
// transaction history, the amount only adds" was a completely accurate
// complaint. This collection is that missing history.
const LEDGER_COLLECTION = "walletTransactions";

// A dedicated wallet for money an admin has explicitly decided doesn't
// belong to the buyer or the seller when force-cancelling a deal (see
// adminForceCancelDeal's split support in escrowService.js) - never
// created implicitly, never a place money ends up by accident. Not a
// real Firebase uid, so it can never collide with an actual user.
//
// NOT "__admin_wallet__" - Firestore reserves every document/collection id
// that both starts and ends with a double underscore for its own internal
// use, and rejects writes to one with "Resource id ... is invalid because
// it is reserved." Single leading/trailing underscores are fine.
const ADMIN_WALLET_UID = "_admin_wallet_";

// Call from inside an existing db.runTransaction(tx => ...), right
// alongside the tx.set(...) that actually changes the wallet's
// balanceKobo - never on its own, so a ledger entry can never exist
// without the balance change it's describing actually having happened
// (or vice versa).
//
// [amountKobo] is signed: positive for money landing in the wallet,
// negative for money leaving it (e.g. paying for a deal from wallet
// balance, or a withdrawal). [type] is a short machine-readable label -
// see the TYPES export below for the ones currently in use.
function recordWalletTransaction(
  tx,
  { uid, amountKobo, type, agreementId, trancheId, reason, recipientRole }
) {
  const ref = db.collection(LEDGER_COLLECTION).doc();
  tx.set(ref, {
    uid,
    amountKobo,
    type,
    agreementId: agreementId || null,
    trancheId: trancheId || null,
    reason: reason || null,
    recipientRole: recipientRole || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
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

async function listWalletTransactions(uid, limit = 100) {
  const snap = await db
    .collection(LEDGER_COLLECTION)
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

module.exports = {
  LEDGER_COLLECTION,
  ADMIN_WALLET_UID,
  TYPES,
  recordWalletTransaction,
  listWalletTransactions,
};