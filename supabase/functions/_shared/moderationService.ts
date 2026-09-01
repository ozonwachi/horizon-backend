import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";
import { notifyUser } from "./notificationService.ts";

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
    .select("uid, is_admin, account_status")
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

  // Ban-evasion detection: snapshot the phone number this account was
  // banned with, so if it (or a new account) later shows up on a phone that
  // matches, the profiles trigger in
  // project_supabase_migration_18_ban_evasion_detection.sql can flag it for
  // review. Kept even if this profile's phone later changes or the account
  // is unbanned - the point is a durable record of "this number was once on
  // a banned account", not the current state of this profile.
  if (status === "banned" && data.phone) {
    const { error: banPhoneError } = await supabase
      .from("banned_phones")
      .insert({ phone: data.phone, banned_uid: targetUid });
    if (banPhoneError) {
      console.error("Snapshot banned phone failed:", banPhoneError);
    }
  }

  // Security fix: this - banning, freezing, or deactivating a user - is
  // arguably the single most consequential thing an admin can do to a
  // person, and it previously never landed in the audit_logs table the
  // Audit Log screen actually reads from (only escrow actions and
  // platform-settings changes did). The profile row itself still stamps
  // status_changed_by/status_changed_at, but that never surfaced anywhere
  // an admin reviewing "what did we do and why" would see it.
  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "account_status_changed",
    targetType: "userAccount",
    targetId: targetUid,
    previousValue: { accountStatus: target.account_status },
    newValue: { accountStatus: status, reason: status === "active" ? "" : reason ?? "" },
    reason,
  }).catch((err) => console.error("recordAuditLog (account status changed) failed:", err));

  // Security fix: previously the affected user had no way to find out their
  // account status changed except by trying to use the app and hitting a
  // wall - this is exactly the kind of "big thing done in the app" email
  // setup was requested for. Skips 'active' (a release back to normal isn't
  // something someone needs to be alarmed about the way a ban/freeze is,
  // and it's already implied by the app simply working again).
  const STATUS_COPY: Record<string, { title: string; body: string }> = {
    banned: {
      title: "Your account has been banned",
      body: reason
        ? `Your Horizon account was banned: ${reason}`
        : "Your Horizon account was banned for violating our terms.",
    },
    frozen: {
      title: "Your account has been frozen",
      body: reason
        ? `Your Horizon account was frozen and money movement is paused: ${reason}`
        : "Your Horizon account was frozen and money movement is paused.",
    },
    investigating: {
      title: "Your account is under review",
      body: reason
        ? `Your Horizon account is under review: ${reason}`
        : "Your Horizon account is under review. Browsing still works, but money movement is paused until this clears.",
    },
    deactivated: {
      title: "Your account has been deactivated",
      body: reason
        ? `Your Horizon account was deactivated: ${reason}`
        : "Your Horizon account was deactivated.",
    },
  };
  const statusCopy = STATUS_COPY[status];
  if (statusCopy) {
    await notifyUser(supabase, targetUid, {
      type: "account_status_changed",
      title: statusCopy.title,
      body: statusCopy.body,
      relatedType: "userAccount",
      relatedId: targetUid,
      important: true,
    }).catch((err) => console.error("notifyUser (account status changed) failed:", err));
  }

  return toModeratedProfile(data);
}

/// Grants or revokes the 'trusted_business' trust tier. Previously
/// unreachable anywhere - trust_level's schema allows three tiers
/// (basic/verified/trusted_business) but only basic->verified was ever set,
/// by identity-verification approval. This is the admin-side lever for the
/// third tier, since there's no automated signal for it (unlike
/// verification, which has a clear approve/reject flow) - it's a judgment
/// call an admin makes directly.
export async function setTrustLevel(
  supabase: SupabaseClient,
  adminUid: string,
  targetUid: string,
  trustLevel: "verified" | "trusted_business"
): Promise<{ uid: string; trustLevel: string }> {
  if (trustLevel !== "verified" && trustLevel !== "trusted_business") {
    throw new Error(`Unknown trust level "${trustLevel}"`);
  }

  const { data: target, error: targetError } = await supabase
    .from("profiles")
    .select("uid, trust_level")
    .eq("uid", targetUid)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw new Error("User not found.");

  const { data, error } = await supabase
    .from("profiles")
    .update({ trust_level: trustLevel })
    .eq("uid", targetUid)
    .select("uid, trust_level")
    .single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "trust_level_changed",
    targetType: "userAccount",
    targetId: targetUid,
    previousValue: { trustLevel: target.trust_level },
    newValue: { trustLevel },
  }).catch((err) => console.error("recordAuditLog (trust level changed) failed:", err));

  return { uid: data.uid, trustLevel: data.trust_level };
}
