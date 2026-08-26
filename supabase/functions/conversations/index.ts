import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, type AppEnv } from "../_shared/auth.ts";
import { notifyUsers } from "../_shared/notificationService.ts";

// Ported from src/routes/conversations.js.
const app = new Hono<AppEnv>().basePath("/conversations");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

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

    return c.json({ ok: true });
  } catch (err) {
    console.error("Notify conversation failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

Deno.serve(app.fetch);
