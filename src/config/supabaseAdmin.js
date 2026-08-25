const { createClient } = require("@supabase/supabase-js");

// The service_role key bypasses Row Level Security entirely - this is the
// backend's equivalent of firebaseAdmin.js's Admin SDK access, and the
// reason it must NEVER end up in the Flutter app (only the anon/public key
// does, if the app ever talks to Supabase directly). Locally this goes in
// .env; on Render it's pasted into the dashboard's Environment tab -
// same pattern as FIREBASE_SERVICE_ACCOUNT_JSON before it.
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to your .env file locally, and to Render's ` +
        "Environment tab in production (Project Settings > API in Supabase " +
        "is where these three values come from)."
    );
  }
  return value;
}

const supabaseUrl = requireEnv("SUPABASE_URL");
const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// autoRefreshToken/persistSession are meaningless for a long-lived backend
// service (they exist for browser/mobile clients that need to keep a user
// session alive) - explicitly off so nothing tries to manage a session that
// was never there.
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabase };
