import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { linkReferral, getReferralSummary } from "../_shared/referralService.ts";

// Ported from src/routes/referrals.js. Every route here requires auth (the
// Express version applied `router.use(requireAuth)` once for the whole
// router - Hono needs it per-route or via app.use, done below).
const app = new Hono<AppEnv>().basePath("/referrals");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

// Called once, right after a brand-new signup, if the person entered a
// referral code. Not fatal to the caller's flow either way - by the time
// this runs the account already exists, so a bad/reused code just means no
// referral relationship gets recorded, not a failed signup.
app.post("/link", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const referralCode = body?.referralCode;
  if (!referralCode) {
    return c.json({ error: "referralCode is required" }, 400);
  }

  try {
    await linkReferral(getAdminClient(), user.uid, referralCode);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Everything the "My Referrals" screen needs: the user's own code, who
// they've referred, and how much they've earned.
app.get("/me", async (c) => {
  const user = c.get("user");
  try {
    const summary = await getReferralSummary(getAdminClient(), user.uid);
    return c.json(summary);
  } catch (err) {
    console.error("Get referral summary failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

Deno.serve(app.fetch);
