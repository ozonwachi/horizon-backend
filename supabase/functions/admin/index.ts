import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, requireAdmin, type AppEnv } from "../_shared/auth.ts";
import {
  getSettings,
  listCommissionRules,
  updateSettings,
  upsertCommissionRule,
  deleteCommissionRule,
  listCommissionTiers,
  createCommissionTier,
  deleteCommissionTier,
} from "../_shared/platformSettingsService.ts";
import { deleteReportedPost, listReports, updateReportStatus } from "../_shared/reportService.ts";
import { setAccountStatus, setTrustLevel } from "../_shared/moderationService.ts";
import {
  decideVerificationRequest,
  getVerificationRequestDetail,
  listVerificationRequests,
} from "../_shared/verificationService.ts";
import {
  listContactShareFlags,
  updateContactShareFlagStatus,
  getFlaggedConversation,
} from "../_shared/contactFlagService.ts";
import { listBanEvasionFlags, updateBanEvasionFlagStatus } from "../_shared/banEvasionService.ts";
import { listAllCategories, createCategory, updateCategory, deleteCategory } from "../_shared/categoryService.ts";
import { listAllRegions, createRegion, updateRegion, deleteRegion } from "../_shared/regionService.ts";
import { getPlatformAnalytics } from "../_shared/analyticsService.ts";
import { listBannedPhoneSnapshots } from "../_shared/bannedPhoneService.ts";
import { sendBroadcast } from "../_shared/broadcastService.ts";
import { adminCreditWallet } from "../_shared/walletService.ts";
import {
  listOffPlatformDealReports,
  updateOffPlatformDealReportStatus,
  payOffPlatformDealReportReward,
} from "../_shared/offPlatformDealReportService.ts";
import { rateLimitOrRespond } from "../_shared/rateLimitService.ts";

// Ported from src/routes/adminSettings.js. Every route here is admin-only.
const app = new Hono<AppEnv>().basePath("/admin");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);
app.use("*", requireAdmin);

app.get("/settings", async (c) => {
  const supabase = getAdminClient();
  try {
    const [settings, commissionRules, commissionTiers] = await Promise.all([
      getSettings(supabase),
      listCommissionRules(supabase),
      listCommissionTiers(supabase),
    ]);
    return c.json({ settings, commissionRules, commissionTiers });
  } catch (err) {
    console.error("Get platform settings failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.patch("/settings", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const settings = await updateSettings(getAdminClient(), user.uid, body || {});
    return c.json(settings);
  } catch (err) {
    console.error("Update platform settings failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.put("/commission-rules", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const rule = await upsertCommissionRule(getAdminClient(), user.uid, body || {});
    return c.json(rule);
  } catch (err) {
    console.error("Upsert commission rule failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/commission-rules/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  try {
    await deleteCommissionRule(getAdminClient(), user.uid, id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Delete commission rule failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/commission-tiers", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const tier = await createCommissionTier(getAdminClient(), user.uid, body || {});
    return c.json(tier);
  } catch (err) {
    console.error("Create commission tier failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/commission-tiers/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  try {
    await deleteCommissionTier(getAdminClient(), user.uid, id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Delete commission tier failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/reports", async (c) => {
  const supabase = getAdminClient();
  try {
    const reports = await listReports(supabase);
    return c.json({ reports });
  } catch (err) {
    console.error("Get reports failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.patch("/reports/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const report = await updateReportStatus(getAdminClient(), user.uid, id, body?.status);
    return c.json(report);
  } catch (err) {
    console.error("Update report status failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/reports/:id/post", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  const supabase = getAdminClient();
  try {
    const { data: report, error: reportError } = await supabase
      .from("reports")
      .select("target_type, target_id")
      .eq("id", id)
      .maybeSingle();
    if (reportError) throw reportError;
    if (!report) return c.json({ error: "Report not found" }, 404);

    await deleteReportedPost(supabase, admin.uid, report.target_type, report.target_id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Delete reported post failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/users/:uid/status", async (c) => {
  const admin = c.get("user");
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => ({}));
  try {
    const profile = await setAccountStatus(
      getAdminClient(),
      admin.uid,
      uid,
      body?.status,
      body?.reason ?? ""
    );
    return c.json(profile);
  } catch (err) {
    console.error("Set account status failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Requested feature: grant/revoke the 'trusted_business' trust tier from
// the Admin Dashboard - previously nothing (UI or RPC) could ever set it,
// so it was a dead tier despite existing in the schema.
app.post("/users/:uid/trust-level", async (c) => {
  const admin = c.get("user");
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await setTrustLevel(getAdminClient(), admin.uid, uid, body?.trustLevel);
    return c.json(result);
  } catch (err) {
    console.error("Set trust level failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Requested feature: admin screen for banned_phones - phone + banned
// account's name + their identity card photo (if on file) + a search bar.
app.get("/banned-phones", async (c) => {
  const query = c.req.query("q") ?? undefined;
  try {
    const snapshots = await listBannedPhoneSnapshots(getAdminClient(), { query });
    return c.json({ snapshots });
  } catch (err) {
    console.error("List banned phones failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/verifications", async (c) => {
  const supabase = getAdminClient();
  try {
    const requests = await listVerificationRequests(supabase);
    return c.json({ requests });
  } catch (err) {
    console.error("List verification requests failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/verifications/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = getAdminClient();
  try {
    const detail = await getVerificationRequestDetail(supabase, id);
    if (!detail) return c.json({ error: "Verification request not found" }, 404);
    return c.json(detail);
  } catch (err) {
    console.error("Get verification request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.patch("/verifications/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const request = await decideVerificationRequest(
      getAdminClient(),
      user.uid,
      id,
      body?.status,
      body?.adminNotes ?? ""
    );
    return c.json(request);
  } catch (err) {
    console.error("Decide verification request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/contact-flags", async (c) => {
  const supabase = getAdminClient();
  try {
    const flags = await listContactShareFlags(supabase);
    return c.json({ flags });
  } catch (err) {
    console.error("List contact share flags failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.patch("/contact-flags/:id", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const flag = await updateContactShareFlagStatus(getAdminClient(), admin.uid, id, body?.status);
    return c.json(flag);
  } catch (err) {
    console.error("Update contact share flag failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/contact-flags/:id/conversation", async (c) => {
  const id = c.req.param("id");
  try {
    const view = await getFlaggedConversation(getAdminClient(), id);
    return c.json(view);
  } catch (err) {
    console.error("Get flagged conversation failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/ban-evasion-flags", async (c) => {
  const supabase = getAdminClient();
  try {
    const flags = await listBanEvasionFlags(supabase);
    return c.json({ flags });
  } catch (err) {
    console.error("List ban evasion flags failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.patch("/ban-evasion-flags/:id", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const flag = await updateBanEvasionFlagStatus(getAdminClient(), admin.uid, id, body?.status);
    return c.json(flag);
  } catch (err) {
    console.error("Update ban evasion flag failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/categories", async (c) => {
  try {
    const categories = await listAllCategories(getAdminClient());
    return c.json({ categories });
  } catch (err) {
    console.error("List categories failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/categories", async (c) => {
  const admin = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const category = await createCategory(getAdminClient(), admin.uid, body || {});
    return c.json(category, 201);
  } catch (err) {
    console.error("Create category failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.patch("/categories/:id", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const category = await updateCategory(getAdminClient(), admin.uid, id, body || {});
    return c.json(category);
  } catch (err) {
    console.error("Update category failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/categories/:id", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  try {
    await deleteCategory(getAdminClient(), admin.uid, id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Delete category failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/regions", async (c) => {
  try {
    const regions = await listAllRegions(getAdminClient());
    return c.json({ regions });
  } catch (err) {
    console.error("List regions failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/regions", async (c) => {
  const admin = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const region = await createRegion(getAdminClient(), admin.uid, body || {});
    return c.json(region, 201);
  } catch (err) {
    console.error("Create region failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.patch("/regions/:id", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const region = await updateRegion(getAdminClient(), admin.uid, id, body || {});
    return c.json(region);
  } catch (err) {
    console.error("Update region failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/regions/:id", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  try {
    await deleteRegion(getAdminClient(), admin.uid, id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Delete region failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/analytics", async (c) => {
  try {
    const analytics = await getPlatformAnalytics(getAdminClient());
    return c.json({ analytics });
  } catch (err) {
    console.error("Get platform analytics failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Task: admin listing management. Browsing itself needs no route -
// listings/jobs/barter_posts are already publicly readable, so the client
// queries them directly (see AdminListingsService.search). Deletion is the
// only part that needs the service-role client (an admin isn't the post's
// owner, so the normal "owners manage their own posts" RLS would block a
// plain client-side delete) - reuses deleteReportedPost() exactly as the
// report-triggered delete flow above does, just without requiring a report
// to exist first.
app.delete("/listings/:type/:id", async (c) => {
  const admin = c.get("user");
  const type = c.req.param("type");
  const id = c.req.param("id");
  try {
    await deleteReportedPost(getAdminClient(), admin.uid, type, id);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Delete listing failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Requested feature: admin broadcast to all users, or to whoever's listed a
// given skill/role - see broadcastService.ts's doc comment.
app.post("/broadcast", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  // A broadcast fans out to potentially every user on the platform - worth
  // a tight limit so a compromised admin session (or a fat-fingered retry
  // loop) can't spam the whole user base.
  const limited = await rateLimitOrRespond(
    getAdminClient(),
    `admin-broadcast:${user.uid}`,
    { max: 5, windowSeconds: 3600 },
    c
  );
  if (limited) return limited;

  try {
    const result = await sendBroadcast(getAdminClient(), user.uid, {
      title: body?.title,
      body: body?.body,
      skillTags: Array.isArray(body?.skillTags) ? body.skillTags : undefined,
      sendEmail: !!body?.sendEmail,
    });
    return c.json(result);
  } catch (err) {
    console.error("Send broadcast failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Requested feature: admin wallet credit - see walletService.ts's
// adminCreditWallet doc comment for why this is distinct from the
// read-only special "admin wallet" AdminWalletScreen already showed.
app.post("/users/:uid/wallet-credit", async (c) => {
  const user = c.get("user");
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => ({}));

  const limited = await rateLimitOrRespond(
    getAdminClient(),
    `admin-wallet-credit:${user.uid}`,
    { max: 20, windowSeconds: 3600 },
    c
  );
  if (limited) return limited;

  try {
    const amountKobo = Number(body?.amountKobo);
    const newBalanceKobo = await adminCreditWallet(
      getAdminClient(),
      user.uid,
      uid,
      amountKobo,
      body?.reason
    );
    return c.json({ ok: true, balanceKobo: newBalanceKobo });
  } catch (err) {
    console.error("Admin wallet credit failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// "Report a finished deal" (wallet screen) - admin review + reward payout
// half. Filing itself is a direct RLS insert from the client, no route
// needed for that - see off_platform_deal_reports' RLS policy in
// migration_24.
app.get("/off-platform-deal-reports", async (c) => {
  try {
    const reports = await listOffPlatformDealReports(getAdminClient());
    return c.json({ reports });
  } catch (err) {
    console.error("List off-platform deal reports failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.patch("/off-platform-deal-reports/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const report = await updateOffPlatformDealReportStatus(getAdminClient(), user.uid, id, body?.status);
    return c.json(report);
  } catch (err) {
    console.error("Update off-platform deal report failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/off-platform-deal-reports/:id/reward", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const rewardKobo = Number(body?.rewardKobo);
    const report = await payOffPlatformDealReportReward(getAdminClient(), user.uid, id, rewardKobo);
    return c.json(report);
  } catch (err) {
    console.error("Pay off-platform deal report reward failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
