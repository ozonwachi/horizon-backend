import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser, notifyUsers } from "./notificationService.ts";
import { listAdminUids } from "./conversationService.ts";
import { recordAuditLog } from "./auditLogService.ts";

// "Contact Admin" on the Help Center screen (migration_31) - a general
// free-text channel to admins, separate from reports (which are always
// about a specific post) and the escrow support conversation (which is
// always about a specific deal). Filing snapshots the sender's name/email/
// phone at message time (same reasoning as reports.reporter_name), and
// fans a notification out to every admin the same way
// notifyAdminsOfSupportMessage/notifyAdminsOfDispute do. Replying notifies
// the sender back (important: true) since there's no "my messages" screen
// for them to go check - the notification is the only way they find out.

const TABLE = "admin_contact_messages";

export type AdminContactMessage = {
  id: string;
  senderUid: string;
  senderName: string;
  senderEmail: string | null;
  senderPhone: string | null;
  message: string;
  status: string;
  adminReply: string | null;
  repliedByUid: string | null;
  repliedAt: string | null;
  createdAt: string;
};

// deno-lint-ignore no-explicit-any
function toMessage(row: any): AdminContactMessage {
  return {
    id: row.id,
    senderUid: row.sender_uid,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    senderPhone: row.sender_phone,
    message: row.message,
    status: row.status,
    adminReply: row.admin_reply,
    repliedByUid: row.replied_by_uid,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
  };
}

export async function fileContactMessage(
  supabase: SupabaseClient,
  uid: string,
  message: string
): Promise<AdminContactMessage> {
  const trimmed = (message || "").trim();
  if (!trimmed) throw new Error("Enter a message before sending.");
  if (trimmed.length > 4000) throw new Error("That message is too long.");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("name, email, phone")
    .eq("uid", uid)
    .maybeSingle();
  if (profileError) throw profileError;

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      sender_uid: uid,
      sender_name: (profile?.name as string | undefined)?.trim() || "Unknown",
      sender_email: profile?.email ?? null,
      sender_phone: profile?.phone ?? null,
      message: trimmed,
    })
    .select()
    .single();
  if (error) throw error;
  const saved = toMessage(data);

  const adminUids = await listAdminUids(supabase);
  await notifyUsers(supabase, adminUids, {
    type: "admin_contact_message",
    title: `New message from ${saved.senderName}`,
    body: trimmed.slice(0, 120),
    relatedType: "admin_contact_message",
    relatedId: saved.id,
  });

  return saved;
}

export async function listContactMessages(supabase: SupabaseClient): Promise<AdminContactMessage[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("status", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map(toMessage);
}

export async function replyToContactMessage(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  reply: string
): Promise<AdminContactMessage> {
  const trimmed = (reply || "").trim();
  if (!trimmed) throw new Error("Enter a reply before sending.");

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      admin_reply: trimmed,
      status: "replied",
      replied_by_uid: adminUid,
      replied_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  const updated = toMessage(data);

  await notifyUser(supabase, updated.senderUid, {
    type: "admin_contact_reply",
    title: "Admin replied to your message",
    body: trimmed.slice(0, 160),
    relatedType: "admin_contact_message",
    relatedId: updated.id,
    important: true,
  });

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "admin_contact_message_replied",
    targetType: "admin_contact_message",
    targetId: id,
  }).catch((err) => console.error("recordAuditLog (admin_contact_message_replied) failed:", err));

  return updated;
}
