import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type AccountStatus = "active" | "banned" | "frozen" | "investigating" | "deactivated";

const VALID_STATUSES: AccountStatus[] = ["active", "banned", "frozen", "investigating", "deactivated"];

// Statuses that fully lock a user out of the app (requireAuth rejects every
// request, and the Supabase Auth login itself is banned). 'investigating'
// is deliberately not here - that one only blocks money movement, not
// login/browsing/messaging/posting; see requireActiveAccount in auth.ts.
const LOGIN_BLOCKING_STATUSES: AccountStatus[] = ["banned", "frozen", "deactivated"];

// ~100 years - functionally permanent until explicitly released. Supabase's
// admin API bans by duration rather than "until further notice", so this is
// the practical equivalent; `release()` below sets it back to 'none'.
const BAN_DURATION = "876000h";

export type ModeratedProfile = {
  uid: string;
  accountStatus: AccountStatus;
  statusReason: string;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
};

// deno-lint-ignore no-explicit-any
function toModeratedProfile(row: any): ModeratedProfile {
  return {
    uid: row.uid,
    accountStatus: row.account_status,
    statusReason: row.status_reason ?? "",
    statusChangedBy: row.status_changed_by,
    statusChangedAt: row.status_changed_at,
  };
}

/// Sets a user's moderation status (ban/freeze/investigate/deactivate), or
/// releases them back to 'active'. Keeps the Postgres profiles row and the
/// Supabase Auth login state in sync: a login-blocking status also bans the
/// actual auth.users login (so an already-issued token stops working once
/// it refreshes, not just future sign-in attempts), and 'active' un-bans it.
///
/// Deliberately refuses to touch another admin's account - an admin who
/// turns hostile should be handled by revoking is_admin directly in the
/// database, not through this route, so a compromised/malicious admin
/// token can't lock out other admins.
export async function setAccountStatus(
  supabase: SupabaseClient,
  adminUid: string,
  targetUid: string,
  status: string,
  reason: string
): Promise<ModeratedProfile> {
  if (!VALID_STATUSES.includes(status as AccountStatus)) {
    throw new Error(`Unknown account status "${status}"`);
  }
  if (targetUid === adminUid) {
    throw new Error("You can't moderate your own account.");
  }

  const { data: target, error: targetError } = await supabase
    .from("profiles")
    .select("uid, is_admin")
    .eq("uid", targetUid)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw new Error("User not found.");
  if (target.is_admin) {
    throw new Error("Admins can't be moderated this way - revoke admin access first.");
  }

  const { data, error } = await supabase
    .from("profiles")
    .update({
      account_status: status,
      status_reason: status === "active" ? "" : reason ?? "",
      status_changed_by: adminUid,
      status_changed_at: new Date().toISOString(),
    })
    .eq("uid", targetUid)
    .select()
    .single();
  if (error) throw error;

  // Keep the actual login in sync with the moderation status. A failure
  // here shouldn't silently pretend the whole action succeeded, but it
  // also shouldn't leave the profile row updated with no idea the auth
  // side failed - surface it clearly either way.
  try {
    await supabase.auth.admin.updateUserById(targetUid, {
      ban_duration: LOGIN_BLOCKING_STATUSES.includes(status as AccountStatus) ? BAN_DURATION : "none",
    });
  } catch (authErr) {
    console.error("Profile status updated but auth ban sync failed:", authErr);
    throw new Error(
      "Account status was saved, but updating their login access failed - please try again."
    );
  }

  return toModeratedProfile(data);
}
