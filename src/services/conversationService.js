const { db, auth } = require("../config/firebaseAdmin");
const { notifyUser, notifyUsers } = require("./notificationService");

// Mirrors MessageService._conversationId in the Flutter app EXACTLY (sorted
// pair of uids + item type/id) - see lib/services/message_service.dart. Do
// not change this formula without changing it there too, or admins will
// look up the wrong conversation doc.
function escrowConversationId(buyerId, sellerId, agreementId) {
  const sorted = [buyerId, sellerId].sort();
  return `${sorted[0]}_${sorted[1]}_escrow_${agreementId}`;
}

// Firestore's client-facing rules only let the two participants read a
// conversation's messages (see firestore.rules) - an admin looking at a
// deal they're not a party to would get permission-denied going straight
// through the Flutter Firestore SDK. This reads it via the Admin SDK
// instead (bypasses rules, same pattern as everything else admin-only in
// this backend) so the deal's "Evidence" panel can show what the buyer and
// seller actually agreed on before an admin acts.
async function getEscrowConversation(buyerId, sellerId, agreementId) {
  const conversationId = escrowConversationId(buyerId, sellerId, agreementId);
  const convoRef = db.collection("conversations").doc(conversationId);
  const convoSnap = await convoRef.get();

  if (!convoSnap.exists) {
    return { conversationId, exists: false, participantNames: {}, messages: [] };
  }

  const convoData = convoSnap.data();
  const messagesSnap = await convoRef.collection("messages").orderBy("sentAt", "asc").get();
  const messages = messagesSnap.docs.map((doc) => {
    const m = doc.data();
    return { id: doc.id, senderId: m.senderId, text: m.text, sentAt: m.sentAt };
  });

  return {
    conversationId,
    exists: true,
    participantNames: convoData.participantNames || {},
    messages,
  };
}

// Finds every uid with the admin custom claim, so a buyer/seller messaging
// into a deal's support conversation can notify all of them. There's no
// separate "admins" roster collection today, so this asks Firebase Auth
// directly. A single listUsers page (up to 1000 accounts) covers this
// platform's current scale - revisit with real pagination if that changes.
async function listAdminUids() {
  const page = await auth.listUsers(1000);
  return page.users
    .filter((u) => u.customClaims && u.customClaims.admin === true)
    .map((u) => u.uid);
}

// Called right after a buyer or seller posts into a deal's support
// conversation (the write itself happens straight from the Flutter app to
// Firestore - see MessageService.sendMessage - this is a notify-only
// follow-up). Fans a notification out to every admin, since there's no
// per-admin routing yet - whichever admin is around sees it.
async function notifyAdminsOfSupportMessage({ agreementId, senderName, senderRole, text }) {
  const adminUids = await listAdminUids();
  if (adminUids.length === 0) return;

  const preview = (text || "").slice(0, 120);
  await Promise.all(
    adminUids.map((uid) =>
      notifyUser(uid, {
        type: "escrow_support_message",
        title: `New message from the ${senderRole} on a deal`,
        body: `${senderName}: ${preview}`,
        relatedType: "escrow",
        relatedId: agreementId,
      }).catch((err) => console.error("notifyUser (support message) failed:", err))
    )
  );
}

// Called whenever a tranche or a whole agreement gets disputed
// (disputeTranche / markDisputed in escrowService.js) - previously only the
// OTHER party to the deal was notified, so a dispute could sit invisible
// until an admin happened to open the Admin Dashboard and check. Fans a
// notification out to every admin, same "whichever admin is around sees
// it" pattern as notifyAdminsOfSupportMessage above.
async function notifyAdminsOfDispute({ agreementId, reason }) {
  const adminUids = await listAdminUids();
  if (adminUids.length === 0) return;

  await notifyUsers(adminUids, {
    type: "escrow_disputed",
    title: "Deal disputed - needs review",
    body: reason ? `Reason: ${reason}` : "A deal was just disputed.",
    relatedType: "escrow",
    relatedId: agreementId,
  });
}

module.exports = {
  escrowConversationId,
  getEscrowConversation,
  listAdminUids,
  notifyAdminsOfSupportMessage,
  notifyAdminsOfDispute,
};