import type { Next, Context } from "npm:hono@4";
import { getAdminClient } from "./supabaseAdmin.ts";

export type AuthedUser = {
  uid: string;
  email: string | null;
  isAdmin: boolean;
  accountStatus: string;
};

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

    const user: AuthedUser = {
      uid,
      email: data.user.email ?? null,
      isAdmin: profile?.is_admin === true,
      accountStatus,
    };
    c.set("user", user);
    await next();
  } catch (err) {
    console.error("Token verification failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// Must run after requireAuth (needs the user context var it sets).
export async function requireAdmin(c: AppContext, next: Next) {
  const user = c.get("user");
  if (!user?.isAdmin) {
    return c.json({ error: "Admin access required" }, 403);
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
