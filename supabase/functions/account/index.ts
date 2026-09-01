import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { requestAccountDeletion } from "../_shared/accountDeletionService.ts";

// Self-service account actions - currently just deletion. A regular
// authenticated-user function (not admin-only), same shape as
// negotiations/index.ts. See accountDeletionService.ts for the full design
// (deactivate + ban login now, admin does manual data-erasure review after).
const app = new Hono<AppEnv>().basePath("/account");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

app.post("/delete", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    await requestAccountDeletion(getAdminClient(), user.uid, body?.reason);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Account deletion request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
