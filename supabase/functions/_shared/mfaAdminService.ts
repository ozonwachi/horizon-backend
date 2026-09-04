import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Bug fix: supabase-js's client-side `auth.mfa.unenroll()` requires the
// caller's session to already be at AAL2 (per Supabase's MFA guide: "users
// can only unenroll a factor after completing the enrollment flow and
// obtaining an aal2 JWT claim") - which is exactly what someone who
// abandoned an enrollment mid-way (copied the secret, backed out without
// ever entering a code) can never have, since they never verified
// anything on this account. That's a chicken-and-egg lock: the leftover
// UNVERIFIED factor blocks every future enroll() call with "a factor with
// the friendly name for this user already exists", and the obvious
// client-side fix (unenroll it first, tried in an earlier pass) throws on
// the AAL2 requirement before it ever gets there - so the popup just
// changes from one error to another, never actually recovering.
//
// The only way out is the service-role admin API, which isn't subject to
// the calling session's AAL at all - it operates on a target user by uid,
// same trust model as every other admin-privileged action in this
// backend, just self-targeted here (a user clearing their OWN stale
// factor, not an admin acting on someone else's). This is what
// AdminMfaSetupScreen's "Set up 2FA" button now calls (via
// POST /account/mfa/clear-unverified) right before MfaService.enroll()
// runs the normal client-side enroll.
export async function clearUnverifiedTotpFactors(supabase: SupabaseClient, uid: string): Promise<number> {
  const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId: uid });
  if (error) throw error;

  const stale = (data?.factors || []).filter((f) => f.factor_type === "totp" && f.status === "unverified");

  for (const f of stale) {
    const { error: deleteError } = await supabase.auth.admin.mfa.deleteFactor({ userId: uid, id: f.id });
    if (deleteError) throw deleteError;
  }

  return stale.length;
}
