import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Email-code second factor - independent of (and in addition to, if a user
// wants both) the TOTP-based MfaService already used for admin/regular 2FA.
// This file is deliberately tiny: the actual code send/verify goes through
// otpService.ts (the same building block that already backs withdrawal
// step-up) with a dedicated "email_2fa" action - all this adds is the one
// column tracking whether the account has it turned on. See
// account/index.ts's /email-2fa/* routes for how the pieces fit together,
// and EmailCodeGate (Flutter) for how a signed-in-but-unverified session is
// actually gated on this at login.

export async function setEmail2faEnabled(
  supabase: SupabaseClient,
  uid: string,
  enabled: boolean
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ email_2fa_enabled: enabled })
    .eq("uid", uid);
  if (error) throw error;
}
