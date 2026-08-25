const { supabase } = require("../config/supabaseAdmin");

const AUDIT_LOG_TABLE = "audit_logs";

// Admin-SDK-only table (no client-facing RLS write policy - see
// project_supabase_schema.sql). Every admin override (generic escrow edit,
// tranche dispute resolution, force-cancel, tranche edit, etc.) writes one
// of these so there's a permanent record of who changed what and why.
//
// `agreementId` is always the escrow agreement an action relates to (set
// for both agreement-level and tranche-level actions), separate from
// `targetId` (which for a tranche action is `${agreementId}/${trancheId}`).
// Keeping a plain agreement_id column lets listAuditLogs filter with a
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
  const { error } = await supabase.from(AUDIT_LOG_TABLE).insert({
    user_id: userId,
    action,
    target_type: targetType,
    target_id: targetId,
    agreement_id: agreementId || null,
    previous_value: previousValue === undefined ? null : previousValue,
    new_value: newValue === undefined ? null : newValue,
    reason: reason || null,
  });
  if (error) throw error;
}

function toAuditLogEntry(row) {
  return {
    id: row.id,
    userId: row.user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    agreementId: row.agreement_id,
    previousValue: row.previous_value,
    newValue: row.new_value,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

// Lists audit log entries, most recent first. Pass `agreementId` to scope
// to a single deal (powers the "evidence" panel on that deal's admin view);
// omit it to list every admin action platform-wide (powers the global Audit
// Log screen).
async function listAuditLogs({ agreementId, limit = 100 } = {}) {
  let query = supabase
    .from(AUDIT_LOG_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 500));
  if (agreementId) {
    query = query.eq("agreement_id", agreementId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data.map(toAuditLogEntry);
}

module.exports = { recordAuditLog, listAuditLogs };
