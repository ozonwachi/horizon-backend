const { db, admin } = require("../config/firebaseAdmin");

const AUDIT_LOG_COLLECTION = "auditLogs";

// Admin-SDK-only collection (no client-facing Firestore rule - see
// firestore.rules). Every admin override (generic escrow edit, tranche
// dispute resolution, force-cancel, tranche edit, etc.) should write one of
// these so there's a permanent record of who changed what and why.
//
// `agreementId` is always the escrow agreement an action relates to (set
// for both agreement-level and tranche-level actions), separate from
// `targetId` (which for a tranche action is `${agreementId}/${trancheId}`).
// Keeping a plain `agreementId` field lets listAuditLogs filter with a
// simple equality query instead of a targetId prefix hack.
async function recordAuditLog({
  userId,
  action,
  targetType,
  targetId,
  agreementId,
  previousValue,
  newValue,
  reason,
}) {
  await db.collection(AUDIT_LOG_COLLECTION).add({
    userId,
    action,
    targetType,
    targetId,
    agreementId: agreementId || null,
    previousValue: previousValue === undefined ? null : previousValue,
    newValue: newValue === undefined ? null : newValue,
    reason: reason || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Lists audit log entries, most recent first. Pass `agreementId` to scope
// to a single deal (powers the "evidence" panel on that deal's admin view);
// omit it to list every admin action platform-wide (powers the global Audit
// Log screen).
//
// NOTE: filtering by agreementId (equality) while ordering by createdAt
// (a different field) requires a Firestore composite index - Firestore will
// prompt with a direct console link the first time this runs with a filter,
// same as listAllAgreements in escrowService.js.
async function listAuditLogs({ agreementId, limit = 100 } = {}) {
  let query = db.collection(AUDIT_LOG_COLLECTION).orderBy("createdAt", "desc");
  if (agreementId) {
    query = query.where("agreementId", "==", agreementId);
  }
  query = query.limit(Math.min(limit, 500));
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

module.exports = { recordAuditLog, listAuditLogs };