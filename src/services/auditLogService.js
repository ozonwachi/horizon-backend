const { db, admin } = require("../config/firebaseAdmin");

const AUDIT_LOG_COLLECTION = "auditLogs";

// Admin-SDK-only collection (no client-facing Firestore rule - see
// firestore.rules). Every admin override (generic escrow edit, tranche
// dispute resolution, etc.) should write one of these so there's a
// permanent record of who changed what and why.
async function recordAuditLog({
  userId,
  action,
  targetType,
  targetId,
  previousValue,
  newValue,
  reason,
}) {
  await db.collection(AUDIT_LOG_COLLECTION).add({
    userId,
    action,
    targetType,
    targetId,
    previousValue: previousValue === undefined ? null : previousValue,
    newValue: newValue === undefined ? null : newValue,
    reason: reason || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = { recordAuditLog };
