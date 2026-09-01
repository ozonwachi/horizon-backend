import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, requireAdmin, requireActiveAccount, type AppEnv } from "../_shared/auth.ts";
import * as escrowService from "../_shared/escrowService.ts";
import * as paystackService from "../_shared/paystackService.ts";
import { listAuditLogs } from "../_shared/auditLogService.ts";
import { getEscrowConversation, notifyAdminsOfSupportMessage } from "../_shared/conversationService.ts";
import { rateLimitOrRespond } from "../_shared/rateLimitService.ts";

// Ported from src/routes/escrow.js. Unlike every other function in this
// project, requireAuth is applied per-route rather than via a blanket
// `app.use("*", requireAuth)` - the cron endpoint below deliberately has
// no Supabase auth at all (Render Cron/pg_cron has no user token to send;
// it's protected by a shared secret instead), and needs to stay exempt.
const app = new Hono<AppEnv>().basePath("/escrow");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey", "x-cron-secret"] }));

// ---------------------------------------------------------------------------
// Internal cron endpoint - NOT behind requireAuth. Protected instead by a
// shared secret set as a Supabase secret (`supabase secrets set
// CRON_SECRET=...`) and passed as a header from whatever now triggers this
// on a schedule (e.g. Supabase's own pg_cron + pg_net, or an external
// scheduler) - same shared-secret pattern the Render Cron Job used to
// hit this on the old backend, just pointed at the new function URL:
//   curl -X POST https://<project-ref>.supabase.co/functions/v1/escrow/internal/flag-overdue-tranches \
//     -H "x-cron-secret: $CRON_SECRET"
// ---------------------------------------------------------------------------
app.post("/internal/flag-overdue-tranches", async (c) => {
  const provided = c.req.header("x-cron-secret");
  if (!provided || provided !== Deno.env.get("CRON_SECRET")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const results = await escrowService.flagOverdueTranches(getAdminClient());
    return c.json(results);
  } catch (err) {
    console.error("flagOverdueTranches failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/agreements", requireAuth, requireActiveAccount, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const {
    sellerId,
    type,
    category,
    amountKobo,
    terms,
    referenceId,
    title,
    description,
    tranches,
    negotiationId,
  } = body || {};

  if (!sellerId || !type || !amountKobo) {
    return c.json({ error: "sellerId, type, and amountKobo are required" }, 400);
  }

  const limited = await rateLimitOrRespond(
    getAdminClient(),
    `escrow-create:${user.uid}`,
    { max: 30, windowSeconds: 3600 },
    c
  );
  if (limited) return limited;

  try {
    const agreement = await escrowService.createAgreement(getAdminClient(), {
      buyerId: user.uid,
      sellerId,
      type,
      category,
      amountKobo,
      terms,
      referenceId,
      title,
      description,
      tranches,
      negotiationId,
    });
    return c.json(agreement, 201);
  } catch (err) {
    console.error("Create agreement failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/agreements/:id/pay", requireAuth, requireActiveAccount, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  try {
    const agreement = await escrowService.getAgreement(getAdminClient(), id);
    if (!agreement) return c.json({ error: "Agreement not found" }, 404);
    if (agreement.buyerId !== user.uid) {
      return c.json({ error: "Not your agreement" }, 403);
    }

    const reference = `horizon_${agreement.id}_${Date.now()}`;

    const tx = await paystackService.initializeTransaction({
      email: user.email || "",
      amountKobo: agreement.amountKobo + agreement.commissionKobo,
      reference,
      metadata: { agreementId: agreement.id, buyerId: user.uid },
    });

    return c.json({ authorizationUrl: tx.authorization_url, reference: tx.reference });
  } catch (err) {
    console.error("Payment init failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/agreements/:id/pay-with-wallet", requireAuth, requireActiveAccount, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  try {
    const updated = await escrowService.payFromWallet(getAdminClient(), id, user.uid);
    return c.json(updated);
  } catch (err) {
    console.error("Pay with wallet failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/agreements/:id/verify", requireAuth, requireActiveAccount, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const reference = body?.reference;
  if (!reference) return c.json({ error: "reference is required" }, 400);

  try {
    const tx = await paystackService.verifyTransaction(reference);
    if (tx.status !== "success") {
      return c.json({ error: `Transaction status: ${tx.status}` }, 400);
    }

    const updated = await escrowService.markFunded(getAdminClient(), id, reference);
    return c.json(updated);
  } catch (err) {
    console.error("Verify failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Legacy whole-agreement release - only valid for old single-tranche
// agreements. New tranche-based agreements use /release-tranche below.
app.post("/agreements/:id/release", requireAuth, requireActiveAccount, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  try {
    const agreement = await escrowService.getAgreement(getAdminClient(), id);
    if (!agreement) return c.json({ error: "Agreement not found" }, 404);
    if (agreement.buyerId !== user.uid) {
      return c.json({ error: "Only the buyer can release funds" }, 403);
    }

    const updated = await escrowService.markReleased(getAdminClient(), id);
    return c.json(updated);
  } catch (err) {
    console.error("Release failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Buyer confirms and releases a specific tranche. Works whether the
// tranche is a plain buyer_confirmation tranche, or a timed tranche the
// buyer wants to release early / after its window has passed - the timer
// only ever makes a tranche eligible, never releases it by itself.
app.post("/agreements/:id/tranches/:trancheId/release", requireAuth, requireActiveAccount, async (c) => {
  const user = c.get("user");
  try {
    const updated = await escrowService.confirmTrancheRelease(
      getAdminClient(),
      c.req.param("id")!,
      c.req.param("trancheId")!,
      user.uid
    );
    return c.json(updated);
  } catch (err) {
    console.error("Tranche release failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Seller marks a milestone reached (e.g. "delivered"), starting the
// countdown for a timed_from_milestone tranche.
app.post("/agreements/:id/tranches/:trancheId/milestone", requireAuth, async (c) => {
  const user = c.get("user");
  try {
    const updated = await escrowService.markMilestoneReached(
      getAdminClient(),
      c.req.param("id")!,
      c.req.param("trancheId")!,
      user.uid
    );
    return c.json(updated);
  } catch (err) {
    console.error("Mark milestone failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Dispute a specific tranche (blocks only that tranche; others keep
// flowing normally). Either buyer or seller can raise this.
app.post("/agreements/:id/tranches/:trancheId/dispute", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const updated = await escrowService.disputeTranche(
      getAdminClient(),
      c.req.param("id")!,
      c.req.param("trancheId")!,
      body?.reason,
      user.uid
    );
    return c.json(updated);
  } catch (err) {
    console.error("Tranche dispute failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Legacy whole-agreement dispute (old agreements without tranches).
app.post("/agreements/:id/dispute", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  try {
    const agreement = await escrowService.getAgreement(getAdminClient(), id);
    if (!agreement) return c.json({ error: "Agreement not found" }, 404);
    if (![agreement.buyerId, agreement.sellerId].includes(user.uid)) {
      return c.json({ error: "Not a party to this agreement" }, 403);
    }

    const updated = await escrowService.markDisputed(getAdminClient(), id, body?.reason, user.uid);
    return c.json(updated);
  } catch (err) {
    console.error("Dispute failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Buyer can cancel unilaterally before funding; once funded, this
// requires a matching call from the other party to actually take effect.
app.post("/agreements/:id/cancel", requireAuth, async (c) => {
  const user = c.get("user");
  try {
    const updated = await escrowService.requestOrConfirmCancel(getAdminClient(), c.req.param("id")!, user.uid);
    return c.json(updated);
  } catch (err) {
    console.error("Cancel failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Generic admin edit (amount/commission/title/description), e.g. to
// correct a job-escrow amount after a dispute.
app.patch("/agreements/:id/admin", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const { reason, ...changes } = body || {};
  try {
    const updated = await escrowService.adminUpdateAgreement(getAdminClient(), id, user.uid, changes, reason);
    return c.json(updated);
  } catch (err) {
    console.error("Admin update failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Admin dashboard: browse every agreement, not just ones the caller is a
// party to. Optional ?status=disputed (etc.) to triage.
app.get("/agreements/admin/all", requireAuth, requireAdmin, async (c) => {
  const status = c.req.query("status");
  const limit = c.req.query("limit");
  try {
    const agreements = await escrowService.listAllAgreements(getAdminClient(), {
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return c.json(agreements);
  } catch (err) {
    console.error("Admin list all agreements failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Admin resolves a disputed tranche: "release" credits the seller as
// normal, "refund" credits the buyer instead.
app.post("/agreements/:id/tranches/:trancheId/admin-resolve", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const { outcome, reason } = body || {}; // "release" | "refund", reason optional
  try {
    const updated = await escrowService.adminResolveTranche(
      getAdminClient(),
      c.req.param("id")!,
      c.req.param("trancheId")!,
      outcome,
      user.uid,
      reason
    );
    return c.json(updated);
  } catch (err) {
    console.error("Admin resolve tranche failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Admin edits a single tranche's amount/label - only while it's still
// PENDING.
app.post("/agreements/:id/tranches/:trancheId/admin-edit", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const { changes, reason } = body || {};
  try {
    const updated = await escrowService.adminUpdateTranche(
      getAdminClient(),
      c.req.param("id")!,
      c.req.param("trancheId")!,
      user.uid,
      changes || {},
      reason
    );
    return c.json(updated);
  } catch (err) {
    console.error("Admin edit tranche failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Admin force-cancels a deal: decides release-or-refund for every tranche
// still open (pending or disputed), then marks the deal cancelled.
app.post("/agreements/:id/admin-force-cancel", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const { decisions, reason } = body || {};
  try {
    const updated = await escrowService.adminForceCancelDeal(getAdminClient(), id, user.uid, decisions || {}, reason);
    return c.json(updated);
  } catch (err) {
    console.error("Admin force-cancel failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Lists admin audit log entries, most recent first. Pass ?agreementId=...
// to scope to one deal; omit it to list every admin action platform-wide.
app.get("/agreements/admin/audit-log", requireAuth, requireAdmin, async (c) => {
  const agreementId = c.req.query("agreementId");
  const limit = c.req.query("limit");
  try {
    const entries = await listAuditLogs(getAdminClient(), {
      agreementId: agreementId || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return c.json(entries);
  } catch (err) {
    console.error("Admin list audit log failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Admin-only read of the buyer/seller chat thread tied to this deal.
app.get("/agreements/:id/admin-conversation", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  try {
    const agreement = await escrowService.getAgreement(getAdminClient(), id);
    if (!agreement) return c.json({ error: "Agreement not found" }, 404);
    const convo = await getEscrowConversation(getAdminClient(), agreement.buyerId, agreement.sellerId, agreement.id);
    return c.json(convo);
  } catch (err) {
    console.error("Admin conversation fetch failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Buyer/seller send their support-conversation messages straight to
// Postgres from the Flutter app - this is a notify-only follow-up call
// right after that write, so an admin actually finds out a message came
// in instead of only seeing it if they happen to open the deal.
app.post("/agreements/:id/support-messages/notify", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  try {
    const agreement = await escrowService.getAgreement(getAdminClient(), id);
    if (!agreement) return c.json({ error: "Agreement not found" }, 404);

    const isParty = [agreement.buyerId, agreement.sellerId].includes(user.uid);
    if (!isParty) {
      return c.json({ error: "Not a party to this agreement" }, 403);
    }

    const senderRole = user.uid === agreement.buyerId ? "buyer" : "seller";
    const { text, senderName } = body || {};

    await notifyAdminsOfSupportMessage(getAdminClient(), {
      agreementId: id,
      senderName: senderName || senderRole,
      senderRole,
      text,
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("Support-message admin notify failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/agreements", requireAuth, async (c) => {
  const user = c.get("user");
  try {
    const agreements = await escrowService.listForUser(getAdminClient(), user.uid);
    return c.json(agreements);
  } catch (err) {
    console.error("List agreements failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/agreements/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  try {
    const agreement = await escrowService.getAgreement(getAdminClient(), id);
    if (!agreement) return c.json({ error: "Agreement not found" }, 404);
    const isParty = [agreement.buyerId, agreement.sellerId].includes(user.uid);
    // Admins can view any agreement (needed for the Admin Dashboard
    // drill-in), not just the ones they're a buyer/seller on.
    if (!isParty && !user.isAdmin) {
      return c.json({ error: "Not a party to this agreement" }, 403);
    }
    return c.json(agreement);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

Deno.serve(app.fetch);
