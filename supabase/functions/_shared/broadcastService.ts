import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUsers } from "./notificationService.ts";
import { recordAuditLog } from "./auditLogService.ts";

// Requested feature: let an admin push a notification to every user, or to
// just whoever's listed a given skill/role (e.g. only "Plumber"s, for a
// platform-wide plumbing-category announcement) - previously the only way
// to reach users at all was per-event notifications triggered by something
// they did (a message, a job match, ...), never an admin-initiated blast.
// Reuses the exact same notifyUsers() pipeline (in-app + push, optionally
// + email) every other notification goes through - recipients see this
// exactly like any other notification, with no special "broadcast" styling
// needed client-side.

export type BroadcastResult = {
  notified: number;
};

export async function sendBroadcast(
  supabase: SupabaseClient,
  adminUid: string,
  {
    title,
    body,
    skillTags,
    sendEmail,
  }: {
    title: string;
    body: string;
    // Omit/empty = every user. Non-empty = only users whose own skill_tags
    // overlap this list (case-insensitive) - same targeting concept as
    // job-alert matching, just admin-driven instead of automatic.
    skillTags?: string[];
    // Broadcasts can reach a lot of people at once - unlike a single
    // escrow/withdrawal notification, this is opt-in per admin judgment
    // rather than always-on, so a routine announcement doesn't burn through
    // the Resend quota by default.
    sendEmail?: boolean;
  }
): Promise<BroadcastResult> {
  const trimmedTitle = (title || "").trim();
  const trimmedBody = (body || "").trim();
  if (!trimmedTitle) throw new Error("A title is required.");
  if (!trimmedBody) throw new Error("A message is required.");

  const cleanTags = (skillTags || []).map((t) => t.trim()).filter((t) => t.length > 0);

  let query = supabase.from("profiles").select("uid");
  if (cleanTags.length > 0) {
    query = query.overlaps("skill_tags", cleanTags);
  }
  const { data: rows, error } = await query;
  if (error) throw error;

  const uids = (rows || []).map((r: { uid: string }) => r.uid);

  await notifyUsers(supabase, uids, {
    type: "admin_broadcast",
    title: trimmedTitle,
    body: trimmedBody,
    relatedType: "broadcast",
    relatedId: null,
    important: !!sendEmail,
  });

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "broadcast_sent",
    targetType: "broadcast",
    targetId: crypto.randomUUID(),
    newValue: { title: trimmedTitle, body: trimmedBody, skillTags: cleanTags, sendEmail: !!sendEmail },
    reason: cleanTags.length > 0 ? `Targeted: ${cleanTags.join(", ")}` : "All users",
  }).catch((err) => console.error("recordAuditLog (broadcast_sent) failed:", err));

  return { notified: uids.length };
}
