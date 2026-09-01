import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

// Admin-only review queue for messages the conversations Edge Function's
// contact-share detector flagged - see contact_share_flags in
// project_supabase_migration_17_connection_fee_and_contact_flags.sql and
// the insert in conversations/index.ts's /:conversationId/notify route.
// Mirrors reportService.ts's shape deliberately, since this is the same
// kind of "flag -> admin reviews -> marks reviewed/dismissed" workflow.

const TABLE = "contact_share_flags";

export type ContactShareFlag = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  matchedSnippet: string;
  relatedItemTitle: string | null;
  status: string;
  createdAt: string;
};

// deno-lint-ignore no-explicit-any
function toFlag(row: any): ContactShareFlag {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    matchedSnippet: row.matched_snippet,
    relatedItemTitle: row.related_item_title,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function listContactShareFlags(
  supabase: SupabaseClient,
  limit = 200
): Promise<ContactShareFlag[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(toFlag);
}

export async function updateContactShareFlagStatus(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  status: string
): Promise<ContactShareFlag> {
  if (!["open", "reviewed", "dismissed"].includes(status)) {
    throw new Error(`Unknown status "${status}"`);
  }
  const { data, error } = await supabase.from(TABLE).update({ status }).eq("id", id).select().single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "contact_share_flag_status_updated",
    targetType: "contact_share_flag",
    targetId: id,
    newValue: { status },
  }).catch((err) => console.error("recordAuditLog (contact_share_flag_status_updated) failed:", err));

  return toFlag(data);
}

export type FlaggedConversationMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: string;
};

export type FlaggedConversationView = {
  conversationId: string;
  relatedItemTitle: string | null;
  messages: FlaggedConversationMessage[];
};

// Requested feature: let an admin read the full thread a contact-share
// flag came from, not just the one matched snippet - makes it possible to
// tell a real off-platform-deal attempt from a false positive (e.g. someone
// typing a price that happens to look like a phone number) without leaving
// the admin dashboard. Read-only by design: the admin isn't a participant
// in this conversation, so there is deliberately no send capability here -
// service-role bypasses the "participants read their conversations" RLS
// policy that would otherwise hide it. [flagId] identifies which flag this
// view is for, purely to give a clear "not found" error if it's ever
// stale/deleted - the messages themselves come from the flag's
// conversationId.
export async function getFlaggedConversation(
  supabase: SupabaseClient,
  flagId: string
): Promise<FlaggedConversationView> {
  const { data: flag, error: flagError } = await supabase
    .from(TABLE)
    .select("conversation_id")
    .eq("id", flagId)
    .maybeSingle();
  if (flagError) throw flagError;
  if (!flag) throw new Error("Flag not found");

  const conversationId = flag.conversation_id as string;

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id, participant_names, related_item_title")
    .eq("id", conversationId)
    .maybeSingle();
  if (conversationError) throw conversationError;

  const { data: rows, error: messagesError } = await supabase
    .from("messages")
    .select("id, sender_id, text, sent_at")
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true });
  if (messagesError) throw messagesError;

  // deno-lint-ignore no-explicit-any
  const names: Record<string, string> = (conversation?.participant_names as any) || {};

  const messages: FlaggedConversationMessage[] = (rows || []).map((r) => ({
    id: r.id,
    senderId: r.sender_id,
    senderName: names[r.sender_id] || "(unknown)",
    text: r.text,
    sentAt: r.sent_at,
  }));

  return {
    conversationId,
    relatedItemTitle: conversation?.related_item_title ?? null,
    messages,
  };
}
