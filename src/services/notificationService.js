const { db, admin } = require("../config/firebaseAdmin");

const NOTIFICATIONS_COLLECTION = "notifications";

// Every in-app notification the backend creates goes through here, so the
// Flutter app only ever has to know about one collection shape. Matches the
// "Notifications" entry in PROJECT_BLUEPRINT.md's Core Data Model (stores
// reminders and system alerts).
//
// type is a short machine-readable tag the app can switch on for icon/action
// (e.g. "escrow_opened", "escrow_funded", "escrow_released",
// "escrow_disputed", "escrow_cancel_requested", "escrow_cancelled",
// "escrow_admin_update").
async function notifyUser(userId, { type, title, body, relatedType, relatedId }) {
  if (!userId) return;

  await db.collection(NOTIFICATIONS_COLLECTION).add({
    userId,
    type,
    title,
    body: body || "",
    relatedType: relatedType || null,
    relatedId: relatedId || null,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function notifyUsers(userIds, payload) {
  await Promise.all(
    [...new Set(userIds.filter(Boolean))].map((uid) => notifyUser(uid, payload))
  );
}

module.exports = { notifyUser, notifyUsers };
