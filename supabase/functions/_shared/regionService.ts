import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

// Admin-only CRUD for supported_regions (migration_19) - the whitelist of
// countries Horizon is officially live in. An empty table means "no
// restriction anywhere" (see the migration's doc comment); the app reads
// active regions directly via RLS, this is only for the admin screen.

const TABLE = "supported_regions";

export type Region = {
  id: string;
  countryCode: string;
  countryName: string;
  active: boolean;
  createdAt: string;
};

// deno-lint-ignore no-explicit-any
function toRegion(row: any): Region {
  return {
    id: row.id,
    countryCode: row.country_code,
    countryName: row.country_name,
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listAllRegions(supabase: SupabaseClient): Promise<Region[]> {
  const { data, error } = await supabase.from(TABLE).select("*").order("country_name", { ascending: true });
  if (error) throw error;
  return (data || []).map(toRegion);
}

export async function createRegion(
  supabase: SupabaseClient,
  adminUid: string,
  { countryCode, countryName }: { countryCode: string; countryName: string }
): Promise<Region> {
  if (!countryCode || countryCode.trim().length !== 2) {
    throw new Error("countryCode must be a 2-letter ISO code");
  }
  if (!countryName || !countryName.trim()) throw new Error("countryName is required");

  const { data, error } = await supabase
    .from(TABLE)
    .insert({ country_code: countryCode.trim().toUpperCase(), country_name: countryName.trim() })
    .select()
    .single();
  if (error) throw error;
  const region = toRegion(data);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "region_created",
    targetType: "region",
    targetId: region.id,
    newValue: region,
  }).catch((err) => console.error("recordAuditLog (region_created) failed:", err));

  return region;
}

export async function updateRegion(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  changes: { countryName?: string; active?: boolean }
): Promise<Region> {
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = {};
  if (changes.countryName !== undefined) patch.country_name = changes.countryName.trim();
  if (changes.active !== undefined) patch.active = changes.active;

  const { data, error } = await supabase.from(TABLE).update(patch).eq("id", id).select().single();
  if (error) throw error;
  const region = toRegion(data);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "region_updated",
    targetType: "region",
    targetId: id,
    newValue: changes,
  }).catch((err) => console.error("recordAuditLog (region_updated) failed:", err));

  return region;
}

export async function deleteRegion(supabase: SupabaseClient, adminUid: string, id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "region_deleted",
    targetType: "region",
    targetId: id,
  }).catch((err) => console.error("recordAuditLog (region_deleted) failed:", err));
}
