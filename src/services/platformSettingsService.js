const { supabase } = require("../config/supabaseAdmin");
const { recordAuditLog } = require("./auditLogService");

const SETTINGS_TABLE = "platform_settings";
const COMMISSION_TABLE = "commission_rules";

function toSettings(row) {
  return {
    adminCommissionType: row.admin_commission_type,
    adminCommissionValue: row.admin_commission_value,
    referralCommissionType: row.referral_commission_type,
    referralCommissionValue: row.referral_commission_value,
    referralMaxPayoutsPerReferredUser: row.referral_max_payouts_per_referred_user,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function toCommissionRule(row) {
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

// Single-row table (id is always 1 - see project_supabase_schema.sql) that
// backs both the escrow commission calculation (escrowService's
// calculateCommission falls back to admin_commission_type/value whenever
// no commission_rules row matches a deal's type/category) and the
// referral payout math (referralService.processReferralPayoutsForAgreement,
// via referral_payout_process).
async function getSettings() {
  const { data, error } = await supabase.from(SETTINGS_TABLE).select("*").eq("id", 1).single();
  if (error) throw error;
  return toSettings(data);
}

async function listCommissionRules() {
  const { data, error } = await supabase
    .from(COMMISSION_TABLE)
    .select("*")
    .order("type", { ascending: true });
  if (error) throw error;
  return data.map(toCommissionRule);
}

// Admin-only. Every field is optional so the caller can patch just the
// referral settings, just the admin commission, or both in one call -
// [reason] is recorded on the audit log entry (item: "Commission changes"
// in PROJECT_BLUEPRINT.md's audit log list) but the update itself doesn't
// require one to keep the settings screen simple to use.
async function updateSettings(adminUid, changes) {
  const before = await getSettings();

  const patch = { updated_at: new Date().toISOString(), updated_by: adminUid };
  if (changes.adminCommissionType !== undefined) patch.admin_commission_type = changes.adminCommissionType;
  if (changes.adminCommissionValue !== undefined) patch.admin_commission_value = changes.adminCommissionValue;
  if (changes.referralCommissionType !== undefined) patch.referral_commission_type = changes.referralCommissionType;
  if (changes.referralCommissionValue !== undefined)
    patch.referral_commission_value = changes.referralCommissionValue;
  if (changes.referralMaxPayoutsPerReferredUser !== undefined)
    patch.referral_max_payouts_per_referred_user = changes.referralMaxPayoutsPerReferredUser;

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .update(patch)
    .eq("id", 1)
    .select()
    .single();
  if (error) throw error;

  const after = toSettings(data);

  await recordAuditLog({
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
async function upsertCommissionRule(adminUid, { type, category, mode, value, minKobo, maxKobo }) {
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

  let result;
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

  await recordAuditLog({
    userId: adminUid,
    action: "commission_rule_updated",
    targetType: "commissionRule",
    targetId: result.id,
    newValue: toCommissionRule(result),
    reason: null,
  }).catch((err) => console.error("recordAuditLog (commission_rule_updated) failed:", err));

  return toCommissionRule(result);
}

async function deleteCommissionRule(adminUid, id) {
  const { error } = await supabase.from(COMMISSION_TABLE).delete().eq("id", id);
  if (error) throw error;

  await recordAuditLog({
    userId: adminUid,
    action: "commission_rule_deleted",
    targetType: "commissionRule",
    targetId: id,
    reason: null,
  }).catch((err) => console.error("recordAuditLog (commission_rule_deleted) failed:", err));
}

module.exports = {
  getSettings,
  listCommissionRules,
  updateSettings,
  upsertCommissionRule,
  deleteCommissionRule,
};
