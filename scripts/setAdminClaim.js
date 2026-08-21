// One-off CLI to grant/revoke the `admin: true` Firebase custom claim used
// by requireAdmin (src/middleware/auth.js). Run it locally with the same
// FIREBASE_SERVICE_ACCOUNT_JSON env var the backend uses.
//
// Usage:
//   node scripts/setAdminClaim.js <uid> grant
//   node scripts/setAdminClaim.js <uid> revoke
//
// The user must sign out and back in (or call getIdToken(true) to force a
// refresh) before the new claim shows up in their ID token - see
// AuthService.isAdmin({forceRefresh: true}) on the Flutter side.
require("dotenv").config();
const { auth } = require("../src/config/firebaseAdmin");

async function main() {
  const [, , uid, action] = process.argv;

  if (!uid || !["grant", "revoke"].includes(action)) {
    console.error("Usage: node scripts/setAdminClaim.js <uid> <grant|revoke>");
    process.exit(1);
  }

  const user = await auth.getUser(uid);
  const existingClaims = user.customClaims || {};

  await auth.setCustomUserClaims(uid, {
    ...existingClaims,
    admin: action === "grant" ? true : false,
  });

  console.log(
    `${action === "grant" ? "Granted" : "Revoked"} admin claim for ${uid} (${
      user.email || "no email"
    }).`
  );
  console.log("They must sign out/in (or force-refresh their ID token) to see it take effect.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("setAdminClaim failed:", err);
    process.exit(1);
  });
