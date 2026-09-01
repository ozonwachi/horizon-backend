import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

const REPORTS_TABLE = "reports";

export type Report = {
  id: string;
  targetType: string;
  targetId: string;
  targetTitle: string;
  targetOwnerUid: string;
  targetOwnerName: string;
  reporterUid: string;
  reporterName: string;
  reason: string;
  details: string;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

// deno-lint-ignore no-explicit-any
function toReport(row: any): Report {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    targetTitle: row.target_title,
    targetOwnerUid: row.target_owner_uid,
    targetOwnerName: row.target_owner_name,
    reporterUid: row.reporter_uid,
    reporterName: row.reporter_name,
    reason: row.reason,
    details: row.details,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

// Admin-only. Reports are filed directly by the client via RLS (see
// "users can file their own reports" in
// project_supabase_migration_08_reports.sql) - there's no client-facing
// route for submission, only for reading/reviewing them here, same pattern
// as the audit log.
export async function listReports(supabase: SupabaseClient): Promise<Report[]> {
  const { data, error } = await supabase
    .from(REPORTS_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map(toReport);
}

const TARGET_TABLES: Record<string, string> = {
  listing: "listings",
  job: "jobs",
  barter: "barter_posts",
};

/// Admin-only: deletes the actual post a report was filed against (e.g.
/// after review, the listing genuinely was a scam). Uses the service-role
/// client, so it bypasses the "owners manage their own listings"-style RLS
/// that would otherwise stop anyone but the poster from deleting it.
export async function deleteReportedPost(
  supabase: SupabaseClient,
  adminUid: string,
  targetType: string,
  targetId: string
): Promise<void> {
  const table = TARGET_TABLES[targetType];
  if (!table) throw new Error(`Unknown report target type "${targetType}"`);
  const { error } = await supabase.from(table).delete().eq("id", targetId);
  if (error) throw error;

  // Security fix: this is a destructive service-role delete of a user's
  // post (bypassing their own "owners manage their own listings" RLS) that
  // previously left no record of which admin did it or why.
  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "reported_post_deleted",
    targetType,
    targetId,
  }).catch((err) => console.error("recordAuditLog (reported_post_deleted) failed:", err));
}

export async function updateReportStatus(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  status: string
): Promise<Report> {
  if (!["open", "reviewed", "dismissed"].includes(status)) {
    throw new Error(`Unknown report status "${status}"`);
  }
  const { data, error } = await supabase
    .from(REPORTS_TABLE)
    .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: adminUid })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "report_status_updated",
    targetType: "report",
    targetId: id,
    newValue: { status },
  }).catch((err) => console.error("recordAuditLog (report_status_updated) failed:", err));

  return toReport(data);
}
