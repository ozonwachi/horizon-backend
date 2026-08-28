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
import { setAccountStatus } from "../_shared/moderationService.ts";

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

    await deleteReportedPost(supabase, report.target_type, report.target_id);
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

Deno.serve(app.fetch);
