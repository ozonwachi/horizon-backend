import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const AUDIT_LOG_TABLE = "audit_logs";

export type AuditLogEntry = {
  id: string;
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  agreementId: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  createdAt: string;
};

// Ported 1:1 from src/services/auditLogService.js. Admin-only table (no
// client-facing RLS write policy) - every admin override (generic escrow
// edit, tranche dispute resolution, force-cancel, tranche edit, etc.)
// writes one of these so there's a permanent record of who changed what
// and why.
export async function recordAuditLog(
  supabase: SupabaseClient,
  {
    userId,
    action,
    targetType,
    targetId,
    agreementId,
    previousValue,
    newValue,
    reason,
  }: {
    userId: string;
    action: string;
    targetType: string;
    targetId: string;
    agreementId?: string | null;
    previousValue?: unknown;
    newValue?: unknown;
    reason?: string | null;
  }
): Promise<void> {
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

// deno-lint-ignore no-explicit-any
function toAuditLogEntry(row: any): AuditLogEntry {
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

// Pass agreementId to scope to a single deal (powers the "evidence" panel);
// omit it to list every admin action platform-wide (Audit Log screen).
export async function listAuditLogs(
  supabase: SupabaseClient,
  { agreementId, limit = 100 }: { agreementId?: string; limit?: number } = {}
): Promise<AuditLogEntry[]> {
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
  return (data || []).map(toAuditLogEntry);
}
