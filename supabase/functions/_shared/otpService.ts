import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendEmail, simpleEmailHtml } from "./emailService.ts";
import { enforceRateLimit } from "./rateLimitService.ts";

// Email OTP step-up for money actions (see migration_27's doc comment for
// the table). This is a SEPARATE layer from admin TOTP MFA (auth.ts) - MFA
// gates "is this session provably the admin", this gates "does whoever is
// driving this specific request also control the account's inbox right
// now", which matters even for a non-admin user's own withdrawal (a
// stolen/leaked session token alone isn't enough to move money out).

const OTP_TABLE = "money_action_otps";
const CODE_TTL_SECONDS = 5 * 60;
const MAX_VERIFY_ATTEMPTS = 5;

async function hashCode(uid: string, action: string, code: string): Promise<string> {
  // Salted with uid+action so the same 6-digit code never hashes the same
  // way across two different users/actions - not that a stolen hash from
  // this table is useful for much anyway (5-minute expiry, single use).
  const bytes = new TextEncoder().encode(`${uid}:${action}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

/// Emails a fresh 6-digit code for [action] (e.g. "withdrawal") to [email],
/// and stores its hash so verifyOtp can later check a submitted code
/// against it. Rate-limited independently of any route-level limiter the
/// caller also applies - at most 3 codes per 10 minutes per uid+action, so
/// a script can't spam someone's inbox by hammering this endpoint.
export async function requestOtp(
  supabase: SupabaseClient,
  { uid, email, action }: { uid: string; email: string | null | undefined; action: string }
): Promise<{ sent: true; expiresInSeconds: number }> {
  if (!email) {
    throw new Error("No email address is on file for this account - can't send a verification code.");
  }

  await enforceRateLimit(supabase, `otp-request:${action}:${uid}`, { max: 3, windowSeconds: 600 });

  const code = generateCode();
  const codeHash = await hashCode(uid, action, code);
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();

  const { error } = await supabase.from(OTP_TABLE).insert({
    uid,
    action,
    code_hash: codeHash,
    expires_at: expiresAt,
  });
  if (error) throw error;

  await sendEmail({
    to: email,
    subject: "Your verification code",
    html: simpleEmailHtml({
      heading: "Your verification code",
      body:
        `Use this code to confirm your request: ${code}\n\n` +
        `It expires in 5 minutes. If you didn't request this, you can safely ignore this email - no action was taken.`,
    }),
  });

  return { sent: true, expiresInSeconds: CODE_TTL_SECONDS };
}

/// Throws if [code] doesn't match the newest unconsumed, unexpired code on
/// file for [uid]+[action]; marks it consumed (single-use) on success.
/// Callers should treat any throw here as "action not authorized" and stop
/// - never proceed on catch.
export async function verifyOtp(
  supabase: SupabaseClient,
  { uid, action, code }: { uid: string; action: string; code: string | null | undefined }
): Promise<void> {
  if (!code) {
    throw new Error("A verification code is required.");
  }

  const { data: row, error } = await supabase
    .from(OTP_TABLE)
    .select("*")
    .eq("uid", uid)
    .eq("action", action)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (!row) {
    throw new Error("No pending verification code for this request - please request a new one.");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new Error("That code has expired - please request a new one.");
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new Error("Too many incorrect attempts - please request a new code.");
  }

  const submittedHash = await hashCode(uid, action, code);
  if (submittedHash !== row.code_hash) {
    await supabase
      .from(OTP_TABLE)
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    throw new Error("Incorrect code - please try again.");
  }

  const { error: consumeError } = await supabase
    .from(OTP_TABLE)
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id);
  if (consumeError) throw consumeError;
}
