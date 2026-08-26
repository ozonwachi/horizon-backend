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
} from "../_shared/platformSettingsService.ts";

// Ported from src/routes/adminSettings.js. Every route here is admin-only.
const app = new Hono<AppEnv>().basePath("/admin");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);
app.use("*", requireAdmin);

app.get("/settings", async (c) => {
  const supabase = getAdminClient();
  try {
    const [settings, commissionRules] = await Promise.all([
      getSettings(supabase),
      listCommissionRules(supabase),
    ]);
    return c.json({ settings, commissionRules });
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

Deno.serve(app.fetch);
