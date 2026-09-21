import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { rateLimitOrRespond } from "../_shared/rateLimitService.ts";
import {
  SosError,
  addContact,
  listCircle,
  respondToInvite,
  removeContact,
  activateSos,
  addLocationUpdate,
  getAlert,
  getMyActiveAlert,
  listAlertsForRecipient,
  acknowledgeAlert,
  contactAction,
  cancelAlert,
  resolveAlert,
} from "../_shared/sosService.ts";

// Horizon SOS + Security Circle. Every route requires a signed-in user; the
// service layer then enforces verification (activation / circle) and, for
// reading an alert, that the caller is the owner or a circle member that was
// snapshotted onto that alert. See migration_44.
// Routes are mounted under BOTH /security-circle and /sos, so one function
// serves both prefixes from the spec.
const app = new Hono<AppEnv>().basePath("/sos");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

// deno-lint-ignore no-explicit-any
function fail(c: any, err: unknown) {
  if (err instanceof SosError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  console.error("SOS route failed:", err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
}

// ---- Security Circle -------------------------------------------------------

app.get("/circle", async (c) => {
  try {
    return c.json(await listCircle(getAdminClient(), c.get("user").uid));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/circle/contacts", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const limited = await rateLimitOrRespond(supabase, `sos-add-contact:${user.uid}`, { max: 20, windowSeconds: 3600 }, c);
  if (limited) return limited;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await addContact(supabase, user.uid, body || {}), 201);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/circle/contacts/:id", async (c) => {
  try {
    return c.json(await removeContact(getAdminClient(), c.get("user").uid, c.req.param("id")!));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/circle/respond", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  // Invite codes are guessable-in-principle, so throttle attempts hard.
  const limited = await rateLimitOrRespond(supabase, `sos-respond:${user.uid}`, { max: 20, windowSeconds: 3600 }, c);
  if (limited) return limited;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(
      await respondToInvite(supabase, user.uid, {
        contactId: body?.contactId,
        inviteCode: body?.inviteCode,
        accept: body?.accept === true,
      })
    );
  } catch (err) {
    return fail(c, err);
  }
});

// ---- Alerts ----------------------------------------------------------------

app.post("/activate", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const limited = await rateLimitOrRespond(supabase, `sos-activate:${user.uid}`, { max: 20, windowSeconds: 3600 }, c);
  if (limited) return limited;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(
      await activateSos(supabase, user.uid, {
        emergencyType: body?.emergencyType,
        location: body?.location,
        deviceInfo: body?.deviceInfo,
        method: body?.method,
      }),
      201
    );
  } catch (err) {
    return fail(c, err);
  }
});

// Mine (owner) - lets the app resume the active screen after a restart.
app.get("/active", async (c) => {
  try {
    return c.json({ alert: await getMyActiveAlert(getAdminClient(), c.get("user").uid) });
  } catch (err) {
    return fail(c, err);
  }
});

// Open alerts where I'm someone's emergency contact (drives the banner).
app.get("/incoming", async (c) => {
  try {
    return c.json({ alerts: await listAlertsForRecipient(getAdminClient(), c.get("user").uid) });
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/:id", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  // Recipients poll this every few seconds while watching; generous but bounded.
  const limited = await rateLimitOrRespond(supabase, `sos-get:${user.uid}`, { max: 600, windowSeconds: 3600 }, c);
  if (limited) return limited;
  try {
    return c.json(await getAlert(supabase, user.uid, c.req.param("id")!));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/location", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const limited = await rateLimitOrRespond(supabase, `sos-location:${user.uid}`, { max: 1200, windowSeconds: 3600 }, c);
  if (limited) return limited;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await addLocationUpdate(supabase, user.uid, c.req.param("id")!, body || {}));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/acknowledge", async (c) => {
  try {
    return c.json(await acknowledgeAlert(getAdminClient(), c.get("user").uid, c.req.param("id")!));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/contact-action", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await contactAction(getAdminClient(), c.get("user").uid, c.req.param("id")!, String(body?.action || "")));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await cancelAlert(getAdminClient(), c.get("user").uid, c.req.param("id")!, body?.confirm === true));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/:id/resolve", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await resolveAlert(getAdminClient(), c.get("user").uid, c.req.param("id")!, body?.note));
  } catch (err) {
    return fail(c, err);
  }
});

Deno.serve(app.fetch);
