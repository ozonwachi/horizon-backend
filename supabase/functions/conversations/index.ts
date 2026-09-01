import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { notifyUsers } from "../_shared/notificationService.ts";
import { listAdminUids } from "../_shared/conversationService.ts";

// Ported from src/routes/conversations.js.
const app = new Hono<AppEnv>().basePath("/conversations");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

// Heuristic contact-info detector (Task: connection fee regulation). Not
// trying to be airtight - a determined evader can always obfuscate a
// number - just cheap enough to run on every message and catch the common,
// unthinking case ("here's my WhatsApp, 0801...") so it can be flagged for
// admin review and the sender can be shown the connection-fee warning.
// Deliberately does NOT block the message: a false positive (a listing
// title with a long reference number, say) blocking someone's message
// would be far worse than an occasional unnecessary flag.
const PHONE_REGEX = /(?:\+?\d[\s.-]?){7,}\d/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const CONTACT_KEYWORDS = [
  "whatsapp",
  "wa.me",
  "telegram",
  "t.me",
  "signal app",
  "instagram",
  "call me on",
  "text me on",
  "reach me on",
  "my number is",
  "contact me on",
  "outside the app",
  "off the app",
  "off-platform",
  "cash only",
];

function detectContactShare(text: string): string | null {
  if (!text) return null;
  if (EMAIL_REGEX.test(text)) return "email address";
  if (PHONE_REGEX.test(text)) return "phone number";
  const lower = text.toLowerCase();
  for (const kw of CONTACT_KEYWORDS) {
    if (lower.includes(kw)) return `mention of "${kw}"`;
  }
  return null;
}

// The Flutter app writes chat messages straight to Postgres (see
// MessageService.sendMessage) - there's no backend hook on that write, so
// nothing ever told the OTHER person a message had arrived unless they
// happened to have the chat open. This is that missing notify step: called
// right after a successful send, for every kind of conversation (a plain
// buyer/seller thread about a listing/job/barter, or the three-way escrow
// "Contact Admin" support thread) - not escrow-specific like
// /escrow/agreements/:id/support-messages/notify, which only covers fanning
// a support message out to admins.
//
// Every other participant on the conversation row gets notified. Admins
// are deliberately never listed in participant_ids (there's no single
// fixed admin uid), so when a buyer/seller posts into a support
// conversation, admins still need the separate notifyAdminsOfSupportMessage
// fan-out (see the escrow function); and when an ADMIN posts here, their
// uid isn't in participant_ids either, so this route alone already
// notifies both buyer and seller.
//
// Reads via the service_role client (bypasses RLS) since an admin posting
// into a support conversation isn't necessarily a row participant.
app.post("/:conversationId/notify", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json().catch(() => ({}));
  const text = body?.text as string | undefined;

  const supabase = getAdminClient();

  try {
    const { data: convo, error } = await supabase
      .from("conversations")
      .select("participant_ids, participant_names, related_item_title, is_support_conversation")
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw error;
    if (!convo) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const participantIds: string[] = convo.participant_ids || [];

    const isParticipant = participantIds.includes(user.uid);
    const isAdminInSupportConvo = user.isAdmin && convo.is_support_conversation === true;
    if (!isParticipant && !isAdminInSupportConvo) {
      return c.json({ error: "Not a participant in this conversation" }, 403);
    }

    const senderName =
      (convo.participant_names && convo.participant_names[user.uid]) ||
      (user.isAdmin ? "Admin" : "Someone");
    const preview = (text || "").slice(0, 120);
    const recipients = participantIds.filter((uid) => uid !== user.uid);

    await notifyUsers(supabase, recipients, {
      type: "new_message",
      title: convo.related_item_title
        ? `New message: ${convo.related_item_title}`
        : `New message from ${senderName}`,
      body: `${senderName}: ${preview}`,
      relatedType: "message",
      relatedId: conversationId,
    });

    // Contact-sharing check - runs after the message has already been
    // notified out, since it's informational, not a gate. The message
    // itself was already written straight to Postgres by the client before
    // this route was ever called, so there's nothing to "block" here even
    // if we wanted to.
    let contactShareMatch: string | null = null;
    const matched = detectContactShare(text || "");
    if (matched) {
      contactShareMatch = matched;
      const { data: flagRow, error: flagError } = await supabase
        .from("contact_share_flags")
        .insert({
          conversation_id: conversationId,
          sender_id: user.uid,
          sender_name: senderName,
          matched_snippet: (text || "").slice(0, 300),
          related_item_title: convo.related_item_title || null,
        })
        .select("id")
        .single();

      if (flagError) {
        console.error("Insert contact_share_flags failed:", flagError);
      } else {
        const adminUids = await listAdminUids(supabase).catch((err) => {
          console.error("listAdminUids (contact share) failed:", err);
          return [] as string[];
        });
        await notifyUsers(supabase, adminUids, {
          type: "contact_share_detected",
          title: "Possible contact info shared",
          body: `${senderName} may have shared a ${matched}${
            convo.related_item_title ? ` about "${convo.related_item_title}"` : ""
          }.`,
          relatedType: "contact_share_flag",
          relatedId: flagRow?.id || conversationId,
        }).catch((err) => console.error("notifyUsers (contact_share_detected) failed:", err));
      }
    }

    return c.json({ ok: true, contactShareFlagged: !!contactShareMatch, matched: contactShareMatch });
  } catch (err) {
    console.error("Notify conversation failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

Deno.serve(app.fetch);
