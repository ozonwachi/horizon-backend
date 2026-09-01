import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

const SETTINGS_TABLE = "platform_settings";
const COMMISSION_TABLE = "commission_rules";
const TIERS_TABLE = "commission_tiers";

export type PlatformSettings = {
  adminCommissionType: string;
  adminCommissionValue: number;
  referralCommissionType: string;
  referralCommissionValue: number;
  referralMaxPayoutsPerReferredUser: number;
  connectionFeeType: string;
  connectionFeeValue: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type CommissionRule = {
  id: string;
  type: string;
  category: string | null;
  mode: string;
  value: number;
  minKobo: number | null;
  maxKobo: number | null;
};

export type CommissionTier = {
  id: string;
  type: string;
  category: string | null;
  minAmountKobo: number;
  maxAmountKobo: number | null;
  mode: string;
  value: number;
};

// deno-lint-ignore no-explicit-any
function toSettings(row: any): PlatformSettings {
  return {
    adminCommissionType: row.admin_commission_type,
    adminCommissionValue: row.admin_commission_value,
    referralCommissionType: row.referral_commission_type,
    referralCommissionValue: row.referral_commission_value,
    referralMaxPayoutsPerReferredUser: row.referral_max_payouts_per_referred_user,
    connectionFeeType: row.connection_fee_type,
    connectionFeeValue: row.connection_fee_value,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

// deno-lint-ignore no-explicit-any
function toCommissionRule(row: any): CommissionRule {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    mode: row.mode,
    value: row.value,
    minKobo: row.min_kobo,
    maxKobo: row.max_kobo,
  };
}

// deno-lint-ignore no-explicit-any
function toCommissionTier(row: any): CommissionTier {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    minAmountKobo: row.min_amount_kobo,
    maxAmountKobo: row.max_amount_kobo,
    mode: row.mode,
    value: row.value,
  };
}

// Single-row table (id is always 1) that backs both the escrow commission
// calculation (escrowService's calculateCommission falls back to
// admin_commission_type/value whenever no commission_rules row matches a
// deal's type/category) and the referral payout math.
export async function getSettings(supabase: SupabaseClient): Promise<PlatformSettings> {
  const { data, error } = await supabase.from(SETTINGS_TABLE).select("*").eq("id", 1).single();
  if (error) throw error;
  return toSettings(data);
}

export async function listCommissionRules(supabase: SupabaseClient): Promise<CommissionRule[]> {
  const { data, error } = await supabase
    .from(COMMISSION_TABLE)
    .select("*")
    .order("type", { ascending: true });
  if (error) throw error;
  return (data || []).map(toCommissionRule);
}

export type SettingsChanges = {
  adminCommissionType?: string;
  adminCommissionValue?: number;
  referralCommissionType?: string;
  referralCommissionValue?: number;
  referralMaxPayoutsPerReferredUser?: number;
  connectionFeeType?: string;
  connectionFeeValue?: number;
  reason?: string | null;
};

// Admin-only. Every field is optional so the caller can patch just the
// referral settings, just the admin commission, or both in one call -
// `reason` is recorded on the audit log entry but the update itself
// doesn't require one to keep the settings screen simple to use.
export async function updateSettings(
  supabase: SupabaseClient,
  adminUid: string,
  changes: SettingsChanges
): Promise<PlatformSettings> {
  const before = await getSettings(supabase);

  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = { updated_at: new Date().toISOString(), updated_by: adminUid };
  if (changes.adminCommissionType !== undefined) patch.admin_commission_type = changes.adminCommissionType;
  if (changes.adminCommissionValue !== undefined) patch.admin_commission_value = changes.adminCommissionValue;
  if (changes.referralCommissionType !== undefined) patch.referral_commission_type = changes.referralCommissionType;
  if (changes.referralCommissionValue !== undefined)
    patch.referral_commission_value = changes.referralCommissionValue;
  if (changes.referralMaxPayoutsPerReferredUser !== undefined)
    patch.referral_max_payouts_per_referred_user = changes.referralMaxPayoutsPerReferredUser;
  if (changes.connectionFeeType !== undefined) patch.connection_fee_type = changes.connectionFeeType;
  if (changes.connectionFeeValue !== undefined) patch.connection_fee_value = changes.connectionFeeValue;

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .update(patch)
    .eq("id", 1)
    .select()
    .single();
  if (error) throw error;

  const after = toSettings(data);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "platform_settings_updated",
    targetType: "platformSettings",
    targetId: "1",
    previousValue: before,
    newValue: after,
    reason: changes.reason || null,
  }).catch((err) => console.error("recordAuditLog (platform_settings_updated) failed:", err));

  return after;
}

// Creates or updates the one commission_rules row for this (type, category)
// pair - category null means "the default for this type". Does a manual
// select-then-update-or-insert rather than relying on Postgrest's
// upsert(onConflict:) against commission_rules_type_category_idx, since
// that index is on (type, coalesce(category, '')) - an expression, not a
// plain column list, which onConflict can't target directly.
export async function upsertCommissionRule(
  supabase: SupabaseClient,
  adminUid: string,
  {
    type,
    category,
    mode,
    value,
    minKobo,
    maxKobo,
  }: { type: string; category?: string | null; mode: string; value: number; minKobo?: number | null; maxKobo?: number | null }
): Promise<CommissionRule> {
  if (!["listing", "job", "barter", "custom"].includes(type)) {
    throw new Error(`Unknown commission type "${type}"`);
  }
  if (!["flat", "percentage"].includes(mode)) {
    throw new Error(`Unknown commission mode "${mode}"`);
  }
  if (typeof value !== "number") {
    throw new Error("value must be a number");
  }

  let existingQuery = supabase.from(COMMISSION_TABLE).select("id").eq("type", type);
  existingQuery = category ? existingQuery.eq("category", category) : existingQuery.is("category", null);
  const { data: existingRows, error: existingError } = await existingQuery;
  if (existingError) throw existingError;

  const row = {
    type,
    category: category || null,
    mode,
    value,
    min_kobo: minKobo === undefined || minKobo === null ? null : minKobo,
    max_kobo: maxKobo === undefined || maxKobo === null ? null : maxKobo,
  };

  // deno-lint-ignore no-explicit-any
  let result: any;
  if (existingRows && existingRows.length > 0) {
    const { data, error } = await supabase
      .from(COMMISSION_TABLE)
      .update(row)
      .eq("id", existingRows[0].id)
      .select()
      .single();
    if (error) throw error;
    result = data;
  } else {
    const { data, error } = await supabase.from(COMMISSION_TABLE).insert(row).select().single();
    if (error) throw error;
    result = data;
  }

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "commission_rule_updated",
    targetType: "commissionRule",
    targetId: result.id,
    newValue: toCommissionRule(result),
    reason: null,
  }).catch((err) => console.error("recordAuditLog (commission_rule_updated) failed:", err));

  return toCommissionRule(result);
}

export async function deleteCommissionRule(supabase: SupabaseClient, adminUid: string, id: string): Promise<void> {
  const { error } = await supabase.from(COMMISSION_TABLE).delete().eq("id", id);
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "commission_rule_deleted",
    targetType: "commissionRule",
    targetId: id,
    reason: null,
  }).catch((err) => console.error("recordAuditLog (commission_rule_deleted) failed:", err));
}

// Task: amount-based commission tiers - see escrowService.calculateCommission
// for how these are actually applied. Unlike commission_rules (one row per
// type/category), a type/category can have many tiers - one per amount
// range - so these are plain create/delete, no upsert-by-key.
export async function listCommissionTiers(supabase: SupabaseClient): Promise<CommissionTier[]> {
  const { data, error } = await supabase
    .from(TIERS_TABLE)
    .select("*")
    .order("type", { ascending: true })
    .order("min_amount_kobo", { ascending: true });
  if (error) throw error;
  return (data || []).map(toCommissionTier);
}

export async function createCommissionTier(
  supabase: SupabaseClient,
  adminUid: string,
  {
    type,
    category,
    minAmountKobo,
    maxAmountKobo,
    mode,
    value,
  }: {
    type: string;
    category?: string | null;
    minAmountKobo: number;
    maxAmountKobo?: number | null;
    mode: string;
    value: number;
  }
): Promise<CommissionTier> {
  if (!["listing", "job", "barter", "custom"].includes(type)) {
    throw new Error(`Unknown commission type "${type}"`);
  }
  if (!["flat", "percentage"].includes(mode)) {
    throw new Error(`Unknown commission mode "${mode}"`);
  }
  if (typeof minAmountKobo !== "number" || typeof value !== "number") {
    throw new Error("minAmountKobo and value must be numbers");
  }
  if (maxAmountKobo != null && maxAmountKobo < minAmountKobo) {
    throw new Error("maxAmountKobo cannot be less than minAmountKobo");
  }

  const row = {
    type,
    category: category || null,
    min_amount_kobo: minAmountKobo,
    max_amount_kobo: maxAmountKobo === undefined ? null : maxAmountKobo,
    mode,
    value,
  };

  const { data, error } = await supabase.from(TIERS_TABLE).insert(row).select().single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "commission_tier_created",
    targetType: "commissionTier",
    targetId: data.id,
    newValue: toCommissionTier(data),
    reason: null,
  }).catch((err) => console.error("recordAuditLog (commission_tier_created) failed:", err));

  return toCommissionTier(data);
}

export async function deleteCommissionTier(supabase: SupabaseClient, adminUid: string, id: string): Promise<void> {
  const { error } = await supabase.from(TIERS_TABLE).delete().eq("id", id);
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "commission_tier_deleted",
    targetType: "commissionTier",
    targetId: id,
    reason: null,
  }).catch((err) => console.error("recordAuditLog (commission_tier_deleted) failed:", err));
}
