const { db } = require("../config/firebaseAdmin");

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

module.exports = { escrowConversationId, getEscrowConversation };