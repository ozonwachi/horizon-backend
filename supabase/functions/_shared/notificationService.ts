import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendPushToUser } from "./pushService.ts";

const NOTIFICATIONS_TABLE = "notifications";

// Ported 1:1 from src/services/notificationService.js. Every in-app
// notification a function creates goes through here, so the Flutter app
// only ever has to know about one table shape. `type` is a short
// machine-readable tag the app switches on for icon/action (e.g.
// "escrow_opened", "escrow_funded", "escrow_released", "escrow_disputed",
// "escrow_cancel_requested", "escrow_cancelled", "escrow_admin_update",
// "escrow_support_message", "withdrawal_requested", "withdrawal_paid",
// "withdrawal_rejected", "new_message", "referral_payout").
export async function notifyUser(
  supabase: SupabaseClient,
  userId: string | null | undefined,
  payload: {
    type: string;
    title: string;
    body?: string;
    relatedType?: string | null;
    relatedId?: string | null;
  }
): Promise<void> {
  if (!userId) return;

  const { error } = await supabase.from(NOTIFICATIONS_TABLE).insert({
    user_id: userId,
    type: payload.type,
    title: payload.title,
    body: payload.body || "",
    related_type: payload.relatedType || null,
    related_id: payload.relatedId || null,
    read: false,
  });
  if (error) throw error;

  // Every in-app notification (new message, escrow update, withdrawal
  // status, referral payout, ...) also goes out as a real push notification
  // this same way - one hook point instead of duplicating this at every
  // call site. The in-app bell row above is the part that must succeed;
  // push is a bonus on top of it, so a push failure (no registered device,
  // FCM hiccup, etc.) is logged and swallowed here rather than failing the
  // notification that triggered it.
  try {
    await sendPushToUser(supabase, userId, {
      title: payload.title,
      body: payload.body || "",
      data: {
        type: payload.type,
        relatedType: payload.relatedType || "",
        relatedId: payload.relatedId || "",
      },
    });
  } catch (err) {
    console.error(`Push notification failed for user ${userId}:`, err);
  }
}

export async function notifyUsers(
  supabase: SupabaseClient,
  userIds: Array<string | null | undefined>,
  payload: { type: string; title: string; body?: string; relatedType?: string | null; relatedId?: string | null }
): Promise<void> {
  const unique = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  await Promise.all(unique.map((uid) => notifyUser(supabase, uid, payload)));
}
