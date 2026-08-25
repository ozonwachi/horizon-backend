const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { supabase } = require("../config/supabaseAdmin");
const { notifyUsers } = require("../services/notificationService");

const router = express.Router();
router.use(requireAuth);

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
// Every other participant on the conversation row gets notified. That
// alone covers the plain two-party case, and also covers a support
// conversation's buyer<->seller direction (whichever of the two didn't just
// send is the "other participant"). Admins are deliberately never listed in
// participant_ids (there's no single fixed admin uid - see
// conversationService.escrowConversationId), so when a buyer/seller posts
// into a support conversation, admins still need the separate
// notifyAdminsOfSupportMessage fan-out; and when an ADMIN posts here, their
// uid isn't in participant_ids either, so this route alone already notifies
// both buyer and seller - which is exactly the direction that had zero
// coverage before.
//
// Reads via the service_role client (bypasses RLS) since an admin posting
// into a support conversation isn't necessarily a row participant - same
// reasoning as conversationService.getEscrowConversation.
router.post("/:conversationId/notify", async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { text } = req.body;

    const { data: convo, error } = await supabase
      .from("conversations")
      .select("participant_ids, participant_names, related_item_title, is_support_conversation")
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw error;
    if (!convo) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const participantIds = convo.participant_ids || [];

    const isParticipant = participantIds.includes(req.user.uid);
    const isAdminInSupportConvo = req.user.isAdmin && convo.is_support_conversation === true;
    if (!isParticipant && !isAdminInSupportConvo) {
      return res.status(403).json({ error: "Not a participant in this conversation" });
    }

    const senderName =
      (convo.participant_names && convo.participant_names[req.user.uid]) ||
      (req.user.isAdmin ? "Admin" : "Someone");
    const preview = (text || "").slice(0, 120);
    const recipients = participantIds.filter((uid) => uid !== req.user.uid);

    await notifyUsers(recipients, {
      type: "new_message",
      title: convo.related_item_title ? `New message: ${convo.related_item_title}` : `New message from ${senderName}`,
      body: `${senderName}: ${preview}`,
      relatedType: "message",
      relatedId: conversationId,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Notify conversation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
