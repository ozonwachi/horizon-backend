const { supabase } = require("../config/supabaseAdmin");

const NOTIFICATIONS_TABLE = "notifications";

// Every in-app notification the backend creates goes through here, so the
// Flutter app only ever has to know about one table shape. Matches the
// "Notifications" entry in PROJECT_BLUEPRINT.md's Core Data Model (stores
// reminders and system alerts).
//
// Moved from Firestore to Postgres alongside Task #27's Flutter migration:
// notification_service.dart's streamFor/unreadCountFor now read the
// Postgres `notifications` table via Supabase Realtime, so writes have to
// land there too or they'd be invisible to every client.
//
// type is a short machine-readable tag the app can switch on for icon/action
// (e.g. "escrow_opened", "escrow_funded", "escrow_released",
// "escrow_disputed", "escrow_cancel_requested", "escrow_cancelled",
// "escrow_admin_update", "escrow_support_message", "withdrawal_requested",
// "withdrawal_paid", "withdrawal_rejected", "new_message").
async function notifyUser(userId, { type, title, body, relatedType, relatedId }) {
  if (!userId) return;

  const { error } = await supabase.from(NOTIFICATIONS_TABLE).insert({
    user_id: userId,
    type,
    title,
    body: body || "",
    related_type: relatedType || null,
    related_id: relatedId || null,
    read: false,
  });
  if (error) throw error;
}

async function notifyUsers(userIds, payload) {
  await Promise.all(
    [...new Set(userIds.filter(Boolean))].map((uid) => notifyUser(uid, payload))
  );
}

module.exports = { notifyUser, notifyUsers };
