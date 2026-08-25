const { supabase } = require("../config/supabaseAdmin");
const { notifyUser, notifyUsers } = require("./notificationService");

// Mirrors MessageService._conversationId in the Flutter app EXACTLY (sorted
// pair of uids + item type/id) - see lib/services/message_service.dart. Do
// not change this formula without changing it there too, or admins will
// look up the wrong conversation doc.
function escrowConversationId(buyerId, sellerId, agreementId) {
  const sorted = [buyerId, sellerId].sort();
  return `${sorted[0]}_${sorted[1]}_escrow_${agreementId}`;
}

// Postgres RLS on `conversations`/`messages` only lets the two participants
// read a conversation (see project_supabase_schema.sql) - an admin looking
// at a deal they're not a party to would get zero rows back going straight
// through the Flutter Supabase client. This reads it via the service_role
// client instead (bypasses RLS, same pattern as everything else admin-only
// in this backend) so the deal's "Evidence" panel can show what the buyer
// and seller actually agreed on before an admin acts.
//
// Moved from Firestore to Postgres alongside Task #27's Flutter migration -
// message_service.dart now reads/writes conversations/messages in Postgres,
// so this admin-only read has to follow or it would show stale/empty data.
async function getEscrowConversation(buyerId, sellerId, agreementId) {
  const conversationId = escrowConversationId(buyerId, sellerId, agreementId);

  const { data: convoRow, error: convoError } = await supabase
    .from("conversations")
    .select("participant_names")
    .eq("id", conversationId)
    .maybeSingle();
  if (convoError) throw convoError;

  if (!convoRow) {
    return { conversationId, exists: false, participantNames: {}, messages: [] };
  }

  const { data: messageRows, error: messagesError } = await supabase
    .from("messages")
    .select("id, sender_id, text, sent_at")
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true });
  if (messagesError) throw messagesError;

  const messages = (messageRows || []).map((m) => ({
    id: m.id,
    senderId: m.sender_id,
    text: m.text,
    sentAt: m.sent_at,
  }));

  return {
    conversationId,
    exists: true,
    participantNames: convoRow.participant_names || {},
    messages,
  };
}

// Finds every admin uid, so a buyer/seller messaging into a deal's support
// conversation (or a new withdrawal request) can notify all of them.
//
// Used to ask Firebase Auth for the "admin" custom claim, but admin status
// moved to profiles.is_admin in Postgres as part of the Supabase auth
// migration (Task #24) - a Firebase custom claim wouldn't reflect reality
// any more even for accounts that still had one. There's no separate
// "admins" roster table, so this just queries profiles directly. Fine at
// this platform's current scale; revisit with pagination if the admin list
// ever gets large.
async function listAdminUids() {
  const { data, error } = await supabase.from("profiles").select("uid").eq("is_admin", true);
  if (error) throw error;
  return data.map((row) => row.uid);
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