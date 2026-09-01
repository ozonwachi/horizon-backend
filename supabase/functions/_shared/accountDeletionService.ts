import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";
import { notifyUsers } from "./notificationService.ts";
import { listAdminUids } from "./conversationService.ts";

// ~100 years, mirrors moderationService.ts's BAN_DURATION - kept as its own
// constant rather than importing that one, since this file has no other
// reason to depend on moderationService.ts.
const BAN_DURATION = "876000h";

/// Requested feature: self-service account deletion. Distinct from
/// moderationService.setAccountStatus (which explicitly refuses to let an
/// admin moderate their own account) - this is the user acting on
/// themselves, not an admin acting on someone else, so it has its own
/// (much simpler) function rather than trying to force it through that
/// one. Locks the account the same way an admin 'deactivated' status does
/// (profile status + Supabase Auth login ban) but deliberately does NOT
/// erase any data automatically - see the admin-notification doc comment
/// below for why.
export async function requestAccountDeletion(
  supabase: SupabaseClient,
  uid: string,
  reason?: string | null
): Promise<void> {
  const { data: target, error: targetError } = await supabase
    .from("profiles")
    .select("uid, account_status, name")
    .eq("uid", uid)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw new Error("Account not found.");
  if (target.account_status === "deactivated") {
    throw new Error("This account is already deactivated.");
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      account_status: "deactivated",
      status_reason: reason?.trim() || "Self-service account deletion",
      status_changed_by: uid,
      status_changed_at: new Date().toISOString(),
    })
    .eq("uid", uid);
  if (error) throw error;

  try {
    await supabase.auth.admin.updateUserById(uid, { ban_duration: BAN_DURATION });
  } catch (authErr) {
    console.error("Profile deactivated but auth ban sync failed:", authErr);
    throw new Error(
      "Your account was deactivated, but signing your login out failed - please contact support."
    );
  }

  await recordAuditLog(supabase, {
    userId: uid,
    action: "account_self_deleted",
    targetType: "userAccount",
    targetId: uid,
    previousValue: { accountStatus: target.account_status },
    newValue: { accountStatus: "deactivated" },
    reason: reason || null,
  }).catch((err) => console.error("recordAuditLog (account_self_deleted) failed:", err));

  // This locks the account out immediately, same as an admin deactivation,
  // but does NOT erase any of the account's data - listings, messages,
  // wallet/escrow history, etc all stay intact, since a lot of it involves
  // other users (an open deal, a shared conversation) or needs to be kept
  // for the financial-record-retention reasons the Privacy Policy
  // describes. Flagging every admin here is what turns this into an actual
  // deletion over time - a human reviews what can safely be erased or
  // anonymized for this specific account, rather than an automated cascade
  // delete risking another user's data or breaking a still-open deal.
  const adminUids = await listAdminUids(supabase).catch((err) => {
    console.error("listAdminUids (account deletion request) failed:", err);
    return [] as string[];
  });
  await notifyUsers(supabase, adminUids, {
    type: "account_deletion_requested",
    title: "Account deletion requested",
    body: `${target.name || "A user"} (${uid}) requested account deletion and has been deactivated. Manual data-erasure review needed.`,
    relatedType: "userAccount",
    relatedId: uid,
  }).catch((err) => console.error("notifyUsers (account_deletion_requested) failed:", err));
}
