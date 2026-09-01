import type { Next, Context } from "npm:hono@4";
import { getAdminClient } from "./supabaseAdmin.ts";

export type AuthedUser = {
  uid: string;
  email: string | null;
  isAdmin: boolean;
  accountStatus: string;
  // Security: admin 2FA (Supabase native TOTP MFA). `aal` is this
  // session's current Authenticator Assurance Level, read straight off the
  // JWT (Supabase mints "aal1" for a plain password sign-in, "aal2" once
  // an MFA challenge has also been completed) - getUser() itself doesn't
  // surface this, so requireAuth decodes it directly (safe: the token was
  // already cryptographically validated by the getUser() call above this).
  // `hasVerifiedMfaFactor` is whether this account has AT LEAST ONE
  // verified TOTP factor enrolled at all - see requireAdmin's doc comment
  // for why both are needed together.
  aal: string;
  hasVerifiedMfaFactor: boolean;
};

// Decodes (WITHOUT verifying - the token was already verified by the
// supabase.auth.getUser() call this is only ever used alongside) a JWT's
// payload to read the `aal` claim. Returns "aal1" if anything about the
// token looks unexpected, which is the conservative default (never
// silently grants aal2).
function decodeAalFromJwt(token: string): string {
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return "aal1";
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded));
    return typeof payload?.aal === "string" ? payload.aal : "aal1";
  } catch {
    return "aal1";
  }
}

// Kept in sync with moderationService.ts's LOGIN_BLOCKING_STATUSES -
// 'investigating' is deliberately excluded here (that one only blocks
// money movement via requireActiveAccount below, not the request itself).
const LOGIN_BLOCKING_STATUSES = ["banned", "frozen", "deactivated"];

// Shared Hono generic so every function's `new Hono<AppEnv>()` gets a
// correctly-typed `c.get("user")`/`c.set("user", ...)` instead of `never`.
export type AppEnv = { Variables: { user: AuthedUser } };

type AppContext = Context<AppEnv>;

// Ported 1:1 from src/middleware/auth.js's requireAuth. Deliberately does
// NOT use Supabase's platform-level JWT verification or the newer
// withSupabase() wrapper - every function in this project sets
// verify_jwt = false in config.toml and does its own verification here,
// exactly like the Express middleware did, so the authorization logic that
// was already reviewed for the Node backend carries over unchanged instead
// of being rewritten against a different abstraction.
//
// supabase.auth.getUser(token) round-trips to Supabase's Auth server to
// validate the token and return the user it belongs to.
export async function requireAuth(c: AppContext, next: Next) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return c.json({ error: "Missing Authorization bearer token" }, 401);
  }

  const supabase = getAdminClient();
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      throw error || new Error("No user returned for this token");
    }
    const uid = data.user.id;

    // Postgres has no equivalent of Firebase's admin custom claim riding
    // along inside the token itself - is_admin lives on the profiles table
    // instead, so this is one extra lookup per authenticated request. Same
    // cost every other handler already pays reading its own data.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("is_admin, account_status")
      .eq("uid", uid)
      .maybeSingle();
    if (profileError) throw profileError;

    const accountStatus = profile?.account_status ?? "active";

    // Belt-and-suspenders alongside the Supabase Auth-level ban that
    // setAccountStatus also applies: that ban stops new sign-ins and stops
    // an existing token once it refreshes, but a still-valid access token
    // can otherwise keep working for up to an hour. Checking the profile
    // status here closes that window immediately, for every route.
    if (LOGIN_BLOCKING_STATUSES.includes(accountStatus)) {
      return c.json(
        { error: "This account has been suspended. Contact support for details." },
        403
      );
    }

    const hasVerifiedMfaFactor = (data.user.factors || []).some((f) => f.status === "verified");

    const user: AuthedUser = {
      uid,
      email: data.user.email ?? null,
      isAdmin: profile?.is_admin === true,
      accountStatus,
      aal: decodeAalFromJwt(token),
      hasVerifiedMfaFactor,
    };
    c.set("user", user);
    await next();
  } catch (err) {
    console.error("Token verification failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// Must run after requireAuth (needs the user context var it sets).
//
// Security fix: admin 2FA. Once an admin account has enrolled a verified
// TOTP factor, every admin route requires the session to actually be at
// AAL2 (i.e. the MFA challenge was completed, not just password sign-in) -
// closes the gap where enrolling MFA in the app was purely cosmetic and a
// stolen password alone still fully worked. Deliberately opt-in rather
// than mandatory for every admin: an admin who hasn't enrolled a factor
// yet can still use their account (the Flutter app should nag them to set
// one up, not lock them out for not having one - see
// AdminMfaSetupScreen). MFA_REQUIRED is a distinct error code so the
// client can tell "you're not an admin" apart from "step up to aal2".
export async function requireAdmin(c: AppContext, next: Next) {
  const user = c.get("user");
  if (!user?.isAdmin) {
    return c.json({ error: "Admin access required" }, 403);
  }
  if (user.hasVerifiedMfaFactor && user.aal !== "aal2") {
    return c.json(
      {
        error: "This admin account requires 2FA verification for this session.",
        code: "MFA_REQUIRED",
      },
      401
    );
  }
  await next();
}

// Must run after requireAuth. By the time this runs, requireAuth has
// already rejected banned/frozen/deactivated accounts outright - so the
// only status this actually needs to catch is 'investigating', which
// requireAuth deliberately lets through for everything except money
// movement. Apply this only to routes that actually move money (fund,
// release, withdraw) - not to browsing/messaging/posting routes, which stay
// available while under investigation.
export async function requireActiveAccount(c: AppContext, next: Next) {
  const user = c.get("user");
  if (user?.accountStatus !== "active") {
    return c.json(
      {
        error:
          "Your account is under review, so money movement is temporarily paused. Contact support for details.",
      },
      403
    );
  }
  await next();
}
