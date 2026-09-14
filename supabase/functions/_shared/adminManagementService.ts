import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

const PROFILES_TABLE = "profiles";

export type StaffMember = {
  uid: string;
  name: string;
  email: string;
  staffRole: string;
};

// deno-lint-ignore no-explicit-any
function toStaffMember(row: any): StaffMember {
  return {
    uid: row.uid,
    name: row.name,
    email: row.email,
    staffRole: row.staff_role,
  };
}

// Lets the dashboard resolve "who is this" by email instead of requiring
// the admin to already know a raw uuid (uid is what every mutating admin
// action actually takes - Postgres has no notion of "the user with this
// email" built in, so this is the one lookup step that bridges the two).
// Any admin can use this - it's a read-only lookup, not a privileged
// action; the actual mutations it feeds into (grant staff, set status,
// credit wallet) are gated wherever they already were.
export async function findUserByEmail(
  supabase: SupabaseClient,
  email: string
): Promise<{ uid: string; name: string; email: string } | null> {
  const trimmed = (email || "").trim();
  if (!trimmed) throw new Error("email is required");
  const { data, error } = await supabase
    .from("profiles")
    .select("uid, name, email")
    .ilike("email", trimmed)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listStaff(supabase: SupabaseClient): Promise<StaffMember[]> {
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select("uid, name, email, staff_role")
    .eq("is_admin", true)
    .order("staff_role", { ascending: true });
  if (error) throw error;
  return (data || []).map(toStaffMember);
}

// Owner-only (gated by requireOwnerRole in the route). Grants staff access
// to an existing user account - there's no separate "create an admin"
// flow, since every account already exists via normal signup; this just
// promotes one. role is 'admin' (owner) or 'worker'.
export async function grantStaffRole(
  supabase: SupabaseClient,
  { targetUid, role, actorUid }: { targetUid: string; role: "admin" | "worker"; actorUid: string }
): Promise<StaffMember> {
  if (!["admin", "worker"].includes(role)) {
    throw new Error(`Unknown staff role "${role}"`);
  }

  const { data: before } = await supabase
    .from(PROFILES_TABLE)
    .select("is_admin, staff_role")
    .eq("uid", targetUid)
    .maybeSingle();

  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .update({ is_admin: true, staff_role: role })
    .eq("uid", targetUid)
    .select("uid, name, email, staff_role")
    .single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: actorUid,
    action: "staff_role_granted",
    targetType: "userAccount",
    targetId: targetUid,
    previousValue: before || null,
    newValue: { isAdmin: true, staffRole: role },
  }).catch((err) => console.error("recordAuditLog (staff_role_granted) failed:", err));

  return toStaffMember(data);
}

// Owner-only. Fully removes staff access (is_admin=false, staff_role=null)
// - not the same as suspending an ordinary user's account (that's
// moderationService.setAccountStatus); this only touches staff standing.
export async function revokeStaffRole(
  supabase: SupabaseClient,
  { targetUid, actorUid }: { targetUid: string; actorUid: string }
): Promise<void> {
  if (targetUid === actorUid) {
    throw new Error("You cannot revoke your own staff access.");
  }

  const { data: before } = await supabase
    .from(PROFILES_TABLE)
    .select("is_admin, staff_role")
    .eq("uid", targetUid)
    .maybeSingle();

  const { error } = await supabase
    .from(PROFILES_TABLE)
    .update({ is_admin: false, staff_role: null })
    .eq("uid", targetUid);
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: actorUid,
    action: "staff_role_revoked",
    targetType: "userAccount",
    targetId: targetUid,
    previousValue: before || null,
    newValue: { isAdmin: false, staffRole: null },
  }).catch((err) => console.error("recordAuditLog (staff_role_revoked) failed:", err));
}
