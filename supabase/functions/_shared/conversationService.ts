import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser, notifyUsers } from "./notificationService.ts";

// Mirrors MessageService._conversationId in the Flutter app EXACTLY (sorted
// pair of uids + item type/id) - see lib/services/message_service.dart. Do
// not change this formula without changing it there too, or admins will
// look up the wrong conversation row.
export function escrowConversationId(buyerId: string, sellerId: string, agreementId: string): string {
  const sorted = [buyerId, sellerId].sort();
  return `${sorted[0]}_${sorted[1]}_escrow_${agreementId}`;
}

export type EscrowConversation = {
  conversationId: string;
  exists: boolean;
  participantNames: Record<string, string>;
  messages: Array<{ id: string; senderId: string; text: string; sentAt: string }>;
};

// Postgres RLS on `conversations`/`messages` only lets the two participants
// read a conversation - an admin looking at a deal they're not a party to
// would get zero rows back going straight through the Flutter Supabase
// client. This reads it via the service_role client instead (bypasses RLS,
// same pattern as everything else admin-only in this backend) so the
// deal's "Evidence" panel can show what the buyer and seller actually
// agreed on before an admin acts.
export async function getEscrowConversation(
  supabase: SupabaseClient,
  buyerId: string,
  sellerId: string,
  agreementId: string
): Promise<EscrowConversation> {
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
// conversation (or a new withdrawal request) can notify all of them. No
// separate "admins" roster table - just queries profiles.is_admin
// directly. Fine at this platform's current scale; revisit with pagination
// if the admin list ever gets large.
export async function listAdminUids(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from("profiles").select("uid").eq("is_admin", true);
  if (error) throw error;
  return (data || []).map((row) => row.uid);
}

// Called right after a buyer or seller posts into a deal's support
// conversation (the write itself happens straight from the Flutter app to
// Postgres - this is a notify-only follow-up). Fans a notification out to
// every admin, since there's no per-admin routing yet.
export async function notifyAdminsOfSupportMessage(
  supabase: SupabaseClient,
  {
    agreementId,
    senderName,
    senderRole,
    text,
  }: { agreementId: string; senderName: string; senderRole: string; text?: string }
): Promise<void> {
  const adminUids = await listAdminUids(supabase);
  if (adminUids.length === 0) return;

  const preview = (text || "").slice(0, 120);
  await Promise.all(
    adminUids.map((uid) =>
      notifyUser(supabase, uid, {
        type: "escrow_support_message",
        title: `New message from the ${senderRole} on a deal`,
        body: `${senderName}: ${preview}`,
        relatedType: "escrow",
        relatedId: agreementId,
      }).catch((err) => console.error("notifyUser (support message) failed:", err))
    )
  );
}

// Called whenever a tranche or a whole agreement gets disputed. Fans a
// notification out to every admin, same "whichever admin is around sees
// it" pattern as notifyAdminsOfSupportMessage above.
export async function notifyAdminsOfDispute(
  supabase: SupabaseClient,
  { agreementId, reason }: { agreementId: string; reason?: string | null }
): Promise<void> {
  const adminUids = await listAdminUids(supabase);
  if (adminUids.length === 0) return;

  await notifyUsers(supabase, adminUids, {
    type: "escrow_disputed",
    title: "Deal disputed - needs review",
    body: reason ? `Reason: ${reason}` : "A deal was just disputed.",
    relatedType: "escrow",
    relatedId: agreementId,
  });
}
