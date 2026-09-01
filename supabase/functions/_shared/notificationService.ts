import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendPushToUser } from "./pushService.ts";
import { sendEmail, simpleEmailHtml } from "./emailService.ts";

const NOTIFICATIONS_TABLE = "notifications";

export type NotifyPayload = {
  type: string;
  title: string;
  body?: string;
  relatedType?: string | null;
  relatedId?: string | null;
  // Email setup: most in-app notifications (a new chat message, a nearby
  // job alert, ...) are exactly the kind of thing a push notification
  // covers fine and an email would just be noise for. This flags the
  // minority that are worth also emailing - "any big thing done in the
  // app" per the original request: account status changes, escrow funded/
  // released/disputed, withdrawal paid/rejected, verification decided, and
  // similar. Defaults to false so every existing call site is unaffected
  // until deliberately opted in.
  important?: boolean;
};

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
  payload: NotifyPayload
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

  // Email setup - see NotifyPayload.important's doc comment. Same
  // fire-and-forget treatment as push: a Resend hiccup or an unset API key
  // must never fail the notification that triggered it.
  if (payload.important) {
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("email")
        .eq("uid", userId)
        .maybeSingle();
      if (profile?.email) {
        await sendEmail({
          to: profile.email,
          subject: payload.title,
          html: simpleEmailHtml({ heading: payload.title, body: payload.body || "" }),
        });
      }
    } catch (err) {
      console.error(`Email notification failed for user ${userId}:`, err);
    }
  }
}

export async function notifyUsers(
  supabase: SupabaseClient,
  userIds: Array<string | null | undefined>,
  payload: NotifyPayload
): Promise<void> {
  const unique = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  await Promise.all(unique.map((uid) => notifyUser(supabase, uid, payload)));
}
