import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

// Admin-only review queue for possible ban evasion - see
// ban_evasion_flags/banned_phones and the profiles trigger in
// project_supabase_migration_18_ban_evasion_detection.sql. A flag here
// means "this account's phone matches one that was on a banned account",
// not proof - an admin decides whether it's really the same person before
// acting.

const FLAGS_TABLE = "ban_evasion_flags";

export type BanEvasionFlag = {
  id: string;
  newUid: string;
  phone: string;
  matchedBannedUid: string;
  status: string;
  createdAt: string;
};

// deno-lint-ignore no-explicit-any
function toFlag(row: any): BanEvasionFlag {
  return {
    id: row.id,
    newUid: row.new_uid,
    phone: row.phone,
    matchedBannedUid: row.matched_banned_uid,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function listBanEvasionFlags(
  supabase: SupabaseClient,
  limit = 200
): Promise<BanEvasionFlag[]> {
  const { data, error } = await supabase
    .from(FLAGS_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(toFlag);
}

export async function updateBanEvasionFlagStatus(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  status: string
): Promise<BanEvasionFlag> {
  if (!["open", "reviewed", "dismissed"].includes(status)) {
    throw new Error(`Unknown status "${status}"`);
  }
  const { data, error } = await supabase
    .from(FLAGS_TABLE)
    .update({ status })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "ban_evasion_flag_status_updated",
    targetType: "ban_evasion_flag",
    targetId: id,
    newValue: { status },
  }).catch((err) => console.error("recordAuditLog (ban_evasion_flag_status_updated) failed:", err));

  return toFlag(data);
}
