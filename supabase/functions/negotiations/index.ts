import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import {
  proposeCommissionNegotiation,
  getCommissionNegotiation,
  respondToCommissionNegotiation,
} from "../_shared/commissionNegotiationService.ts";
import { rateLimitOrRespond } from "../_shared/rateLimitService.ts";

// Commission negotiation - a regular authenticated-user function (not
// admin-only), same shape as conversations/index.ts. See
// commissionNegotiationService.ts and migration_25 for the full design.
const app = new Hono<AppEnv>().basePath("/negotiations");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

app.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const limited = await rateLimitOrRespond(
    getAdminClient(),
    `negotiation-propose:${user.uid}`,
    { max: 20, windowSeconds: 3600 },
    c
  );
  if (limited) return limited;

  try {
    const negotiation = await proposeCommissionNegotiation(getAdminClient(), user.uid, {
      counterpartyUid: body?.counterpartyUid,
      amountKobo: Number(body?.amountKobo),
      proposedMode: body?.proposedMode,
      proposedValue: Number(body?.proposedValue),
      message: body?.message,
    });
    return c.json(negotiation, 201);
  } catch (err) {
    console.error("Propose commission negotiation failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  try {
    const negotiation = await getCommissionNegotiation(getAdminClient(), user.uid, id);
    return c.json(negotiation);
  } catch (err) {
    console.error("Get commission negotiation failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/:id/respond", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try {
    const negotiation = await respondToCommissionNegotiation(
      getAdminClient(),
      user.uid,
      id,
      !!body?.accept
    );
    return c.json(negotiation);
  } catch (err) {
    console.error("Respond to commission negotiation failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
