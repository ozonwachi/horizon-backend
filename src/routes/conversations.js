const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { db } = require("../config/firebaseAdmin");
const { notifyUsers } = require("../services/notificationService");

const router = express.Router();
router.use(requireAuth);

// The Flutter app writes chat messages straight to Firestore (see
// MessageService.sendMessage) - there's no backend hook on that write, so
// nothing ever told the OTHER person a message had arrived unless they
// happened to have the chat open. This is that missing notify step: called
// right after a successful send, for every kind of conversation (a plain
// buyer/seller thread about a listing/job/barter, or the three-way escrow
// "Contact Admin" support thread) - not escrow-specific like
// /escrow/agreements/:id/support-messages/notify, which only covers fanning
// a support message out to admins.
//
// Every other participantId on the conversation doc gets notified. That
// alone covers the plain two-party case, and also covers a support
// conversation's buyer<->seller direction (whichever of the two didn't just
// send is the "other participant"). Admins are deliberately never listed in
// participantIds (there's no single fixed admin uid - see
// conversationService.escrowConversationId), so when a buyer/seller posts
// into a support conversation, admins still need the separate
// notifyAdminsOfSupportMessage fan-out; and when an ADMIN posts here, their
// uid isn't in participantIds either, so this route alone already notifies
// both buyer and seller - which is exactly the direction that had zero
// coverage before.
router.post("/:conversationId/notify", async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { text } = req.body;

    const convoRef = db.collection("conversations").doc(conversationId);
    const snap = await convoRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    const data = snap.data();
    const participantIds = data.participantIds || [];

    const isParticipant = participantIds.includes(req.user.uid);
    const isAdminInSupportConvo = req.user.isAdmin && data.supportConversation === true;
    if (!isParticipant && !isAdminInSupportConvo) {
      return res.status(403).json({ error: "Not a participant in this conversation" });
    }

    const senderName =
      (data.participantNames && data.participantNames[req.user.uid]) ||
      (req.user.isAdmin ? "Admin" : "Someone");
    const preview = (text || "").slice(0, 120);
    const recipients = participantIds.filter((uid) => uid !== req.user.uid);

    await notifyUsers(recipients, {
      type: "new_message",
      title: data.relatedItemTitle ? `New message: ${data.relatedItemTitle}` : `New message from ${senderName}`,
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
