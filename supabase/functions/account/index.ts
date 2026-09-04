import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { requestAccountDeletion } from "../_shared/accountDeletionService.ts";
import { clearUnverifiedTotpFactors } from "../_shared/mfaAdminService.ts";
import { fileContactMessage } from "../_shared/contactAdminService.ts";
import { setEmail2faEnabled } from "../_shared/email2faService.ts";
import * as otpService from "../_shared/otpService.ts";
import { listAdminUids } from "../_shared/conversationService.ts";
import { notifyUsers } from "../_shared/notificationService.ts";

// Self-service account actions - deletion, clearing a stuck MFA enrollment,
// and filing a "Contact Admin" message. A regular authenticated-user
// function (not admin-only), same shape as conversations/index.ts. See
// accountDeletionService.ts for the deletion design (deactivate + ban
// login now, admin does manual data-erasure review after),
// mfaAdminService.ts for why the MFA route exists (client-side unenroll
// can't remove an abandoned unverified factor - it requires an AAL2
// session the user can never have for a factor they never verified), and
// contactAdminService.ts for the Help Center "Contact Admin" flow.
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

// Clears any abandoned/unverified TOTP factor on the CALLING user's own
// account, self-targeted only (uses the caller's own uid, never a body
// param) - lets AdminMfaSetupScreen's enroll button always start clean,
// even after a previous attempt was abandoned mid-setup.
app.post("/mfa/clear-unverified", async (c) => {
  const user = c.get("user");
  try {
    const cleared = await clearUnverifiedTotpFactors(getAdminClient(), user.uid);
    return c.json({ cleared });
  } catch (err) {
    console.error("Clear unverified MFA factors failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// "Contact Admin" on the Help Center screen - LEGACY, no longer called by
// the app. This used to file a one-shot ticket (fileContactMessage,
// admin_contact_messages table) whose "conversation" died after an admin's
// first reply - there was nowhere in the app to keep talking. The Help
// Center's Contact Admin button now opens a real, ongoing two-way
// conversation instead (MessageService.startOrGetContactAdminConversation
// on the Flutter side, /contact-admin/notify below on this side) - same
// support-conversation infrastructure the escrow "Contact Admin" button
// already used. Left in place (unreachable from the current app) rather
// than deleted, purely so any pre-existing rows/routes referencing it don't
// 404 - see contactAdminService.ts.
app.post("/contact-admin", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const saved = await fileContactMessage(getAdminClient(), user.uid, body?.message);
    return c.json(saved);
  } catch (err) {
    console.error("File contact-admin message failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Fire-and-forget fan-out for the REBUILT Contact Admin conversation (see
// the doc comment above /contact-admin): called right after the filer
// sends a message into their own Contact Admin thread (MessageService.
// startOrGetContactAdminConversation) - the message itself already went
// straight to Postgres via MessageService.sendMessage, same as every other
// chat message. Mirrors escrow's /escrow/agreements/:id/support-messages/
// notify: admins are never a listed conversation participant (there's no
// single fixed admin uid), so the generic /conversations/:id/notify route
// can't reach them here either - only an admin's REPLY needs that generic
// route (the filer IS a listed participant, so it already works for that
// direction). Recomputes the conversation id from the caller's own uid
// rather than trusting a client-supplied id, matching
// startOrGetContactAdminConversation's `<uid>_contact_admin` formula
// exactly - keep the two in sync if that ever changes.
app.post("/contact-admin/notify", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const text = (body?.text as string | undefined) || "";
  const senderName = (body?.senderName as string | undefined) || "Someone";
  try {
    const conversationId = `${user.uid}_contact_admin`;
    const adminUids = await listAdminUids(getAdminClient());
    const preview = text.slice(0, 120);
    await notifyUsers(getAdminClient(), adminUids, {
      type: "admin_contact_message",
      title: "New Contact Admin message",
      body: `${senderName}: ${preview}`,
      relatedType: "message",
      relatedId: conversationId,
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error("Contact-admin notify failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Email-code second factor - see email2faService.ts's doc comment. Reuses
// otpService (same building block as withdrawal step-up) under one shared
// action string rather than a bespoke code table.
const EMAIL_2FA_ACTION = "email_2fa";

app.post("/email-2fa/request-code", async (c) => {
  const user = c.get("user");
  try {
    const result = await otpService.requestOtp(getAdminClient(), {
      uid: user.uid,
      email: user.email,
      action: EMAIL_2FA_ACTION,
    });
    return c.json(result);
  } catch (err) {
    console.error("Email 2FA code request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Turns email-code 2FA ON - requires actually proving the account's inbox
// is reachable first (same reasoning as BiometricLockService requiring a
// passed check before its toggle sticks) rather than just flipping a flag.
app.post("/email-2fa/enable", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    await otpService.verifyOtp(getAdminClient(), {
      uid: user.uid,
      action: EMAIL_2FA_ACTION,
      code: body?.code,
    });
    await setEmail2faEnabled(getAdminClient(), user.uid, true);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Email 2FA enable failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Turns it off - no code needed, same as turning off TOTP 2FA or the
// device biometric lock: removing a check doesn't need re-proving it.
app.post("/email-2fa/disable", async (c) => {
  const user = c.get("user");
  try {
    await setEmail2faEnabled(getAdminClient(), user.uid, false);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Email 2FA disable failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Step-up check at LOGIN time (see EmailCodeGate, Flutter) - just confirms
// the submitted code is right; unlike /enable above, this never writes to
// the database.
app.post("/email-2fa/verify", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    await otpService.verifyOtp(getAdminClient(), {
      uid: user.uid,
      action: EMAIL_2FA_ACTION,
      code: body?.code,
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error("Email 2FA verify failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
