const admin = require("firebase-admin");

// The whole service account JSON is stored as a single env var (Render/Railway
// friendly - no file uploads needed). Locally you can put it in .env, on Render
// you paste it into the dashboard's Environment tab.
function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not set. Copy your Firebase service " +
        "account JSON (Project Settings > Service Accounts > Generate new " +
        "private key) into your .env file or Render environment variables."
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Make sure you pasted " +
        "the entire file contents as a single line with no extra quoting."
    );
  }
}

if (!admin.apps.length) {
  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
