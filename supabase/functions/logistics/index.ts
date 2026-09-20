import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { rateLimitOrRespond } from "../_shared/rateLimitService.ts";
import {
  applyAsPartner,
  getMyApplications,
  listNearbyPartners,
  listDeliveriesForPartner,
  listDeliveriesForAgreement,
  acceptDelivery,
  rejectDelivery,
  updateDeliveryStatus,
  setHandoverPhoto,
  getHandoverPhotoUrl,
  getDeliveryDetail,
} from "../_shared/logisticsService.ts";
import {
  requestDelivery,
  counterOffer,
  acceptCurrentOffer,
  declineDelivery,
  cancelDelivery,
} from "../_shared/deliveryNegotiationService.ts";

// Logistics Partner Network (user/partner-facing routes) - admin review of
// applications lives in admin/index.ts alongside the rest of the admin
// surface. See migration_39's doc comment for the overall design.
const app = new Hono<AppEnv>().basePath("/logistics");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

app.post("/apply", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const limited = await rateLimitOrRespond(supabase, `logistics-apply:${user.uid}`, { max: 5, windowSeconds: 86400 }, c);
  if (limited) return limited;

  try {
    const application = await applyAsPartner(supabase, user.uid, body || {});
    return c.json(application, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/my-applications", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  try {
    const applications = await getMyApplications(supabase, user.uid);
    return c.json(applications);
  } catch (err) {
    console.error("Get my logistics applications failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Powers the "pick a delivery partner" step when setting up a deal -
// approved partners only, nearest first if lat/lng are given.
app.get("/partners/nearby", async (c) => {
  const supabase = getAdminClient();
  const lat = c.req.query("lat");
  const lng = c.req.query("lng");
  try {
    const partners = await listNearbyPartners(supabase, {
      latitude: lat ? parseFloat(lat) : undefined,
      longitude: lng ? parseFloat(lng) : undefined,
    });
    return c.json(partners);
  } catch (err) {
    console.error("List nearby logistics partners failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// The partner-only "manage deliveries" screen's data. Any signed-in user
// can call this (it just returns an empty list for a non-partner - the
// Flutter app itself gates the screen behind profiles.is_logistics_partner,
// same "hide the affordance, but the route isn't a secret" posture as most
// of this app's own-data reads).
app.get("/my-deliveries", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const status = c.req.query("status");
  try {
    const deliveries = await listDeliveriesForPartner(supabase, user.uid, status || undefined);
    return c.json(deliveries);
  } catch (err) {
    console.error("List my deliveries failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// For EscrowDetailScreen to show delivery status to the buyer/seller on a
// deal that has one - service-role read, filtered to rows the caller is
// actually a party to (buyer/seller/partner), same as everywhere else in
// this backend that reads across RLS boundaries.
app.get("/agreements/:agreementId/deliveries", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const agreementId = c.req.param("agreementId")!;
  try {
    const deliveries = await listDeliveriesForAgreement(supabase, agreementId);
    const mine = deliveries.filter((d) => [d.buyerId, d.sellerId, d.partnerId].includes(user.uid));
    return c.json(mine);
  } catch (err) {
    console.error("List agreement deliveries failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// --- Price negotiation (migration_40) ---------------------------------------
// The buyer opens a request with a first offer; nothing is charged or added
// to any tranche until both sides agree a price.
app.post("/deliveries", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const limited = await rateLimitOrRespond(supabase, `delivery-request:${user.uid}`, { max: 30, windowSeconds: 3600 }, c);
  if (limited) return limited;

  try {
    const delivery = await requestDelivery(supabase, user.uid, {
      agreementId: body?.agreementId,
      partnerId: body?.partnerId,
      amountKobo: body?.amountKobo,
      note: body?.note,
    });
    return c.json(delivery, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/deliveries/:id", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  try {
    const delivery = await getDeliveryDetail(supabase, c.req.param("id")!, user.uid, user.isAdmin);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deliveries/:id/counter", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const delivery = await counterOffer(supabase, c.req.param("id")!, user.uid, body?.amountKobo, body?.note);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deliveries/:id/accept-offer", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  try {
    const delivery = await acceptCurrentOffer(supabase, c.req.param("id")!, user.uid);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deliveries/:id/decline", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const delivery = await declineDelivery(supabase, c.req.param("id")!, user.uid, body?.reason);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deliveries/:id/cancel", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  try {
    const delivery = await cancelDelivery(supabase, c.req.param("id")!, user.uid);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deliveries/:id/accept", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const id = c.req.param("id")!;
  try {
    const delivery = await acceptDelivery(supabase, id, user.uid);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deliveries/:id/reject", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  try {
    const delivery = await rejectDelivery(supabase, id, user.uid, body?.reason);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deliveries/:id/status", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const status = body?.status;
  if (!["picked_up", "in_transit", "delivered"].includes(status)) {
    return c.json({ error: 'status must be one of "picked_up", "in_transit", "delivered"' }, 400);
  }
  try {
    const delivery = await updateDeliveryStatus(supabase, id, user.uid, status);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// The seller uploads the photo straight to Storage client-side (private
// bucket, own-uid-prefixed path - see migration_39), then calls this to
// record the path against the delivery. Keeps the upload itself off this
// function's request size/timeout budget.
app.post("/deliveries/:id/handover-photo", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  if (!body?.photoPath) return c.json({ error: "photoPath is required" }, 400);
  try {
    const delivery = await setHandoverPhoto(supabase, id, user.uid, body.photoPath);
    return c.json(delivery);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/deliveries/:id/handover-photo-url", async (c) => {
  const supabase = getAdminClient();
  const user = c.get("user");
  const id = c.req.param("id")!;
  try {
    const url = await getHandoverPhotoUrl(supabase, id, user.uid, user.isAdmin);
    return c.json({ url });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
