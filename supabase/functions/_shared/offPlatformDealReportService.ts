import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";
import { adminCreditWallet } from "./walletService.ts";
import { TYPES as LEDGER_TYPES } from "./walletLedgerService.ts";

const TABLE = "off_platform_deal_reports";

// "Report a finished deal" - see migration_24's doc comment on this table
// for why it's separate from `reports`. Filing itself goes straight to
// Postgres via RLS from the client (mirrors ReportService.fileReport) -
// this module is only the admin-side review + reward payout half, same
// split as reportService.ts.

export type OffPlatformDealReport = {
  id: string;
  reporterUid: string;
  reporterName: string;
  sellerUsername: string;
  sellerPhone: string;
  dealDescription: string;
  status: string;
  rewardKobo: number | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

// deno-lint-ignore no-explicit-any
function toReport(row: any): OffPlatformDealReport {
  return {
    id: row.id,
    reporterUid: row.reporter_uid,
    reporterName: row.reporter_name,
    sellerUsername: row.seller_username,
    sellerPhone: row.seller_phone,
    dealDescription: row.deal_description,
    status: row.status,
    rewardKobo: row.reward_kobo,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

export async function listOffPlatformDealReports(
  supabase: SupabaseClient
): Promise<OffPlatformDealReport[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map(toReport);
}

export async function updateOffPlatformDealReportStatus(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  status: string
): Promise<OffPlatformDealReport> {
  if (!["open", "reviewed", "dismissed"].includes(status)) {
    throw new Error(`Unknown status "${status}"`);
  }
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: adminUid })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "off_platform_deal_report_status_updated",
    targetType: "off_platform_deal_report",
    targetId: id,
    newValue: { status },
  }).catch((err) => console.error("recordAuditLog (off_platform_deal_report_status_updated) failed:", err));

  return toReport(data);
}

/// Pays the reporter their reward (20% of whatever was actually recovered,
/// per the original request - the admin enters the final amount by hand,
/// since "recovered" depends on a real-world conversation/collection this
/// system has no visibility into) and marks the report reviewed in one
/// step. Credits straight to the reporter's wallet via the same
/// admin-credit primitive as a manual wallet credit, just tagged with its
/// own ledger type so it's distinguishable in their transaction history.
export async function payOffPlatformDealReportReward(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  rewardKobo: number
): Promise<OffPlatformDealReport> {
  if (!Number.isFinite(rewardKobo) || rewardKobo <= 0) {
    throw new Error("rewardKobo must be a positive number.");
  }

  const { data: existing, error: fetchError } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!existing) throw new Error("Report not found.");
  if (existing.reward_kobo != null) {
    throw new Error("A reward was already paid for this report.");
  }

  await adminCreditWallet(
    supabase,
    adminUid,
    existing.reporter_uid,
    rewardKobo,
    `Reward for reporting an off-platform deal (report ${id})`,
    LEDGER_TYPES.OFF_PLATFORM_REWARD
  );

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      reward_kobo: rewardKobo,
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: adminUid,
    })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "off_platform_deal_reward_paid",
    targetType: "offPlatformDealReport",
    targetId: id,
    newValue: { rewardKobo, ledgerType: LEDGER_TYPES.OFF_PLATFORM_REWARD },
  }).catch((err) => console.error("recordAuditLog (off_platform_deal_reward_paid) failed:", err));

  return toReport(data);
}
