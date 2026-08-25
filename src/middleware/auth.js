const { supabase } = require("../config/supabaseAdmin");

// Flutter app calls this backend with:
//   headers: { Authorization: "Bearer <supabase-access-token>" }
// where <supabase-access-token> comes from
// Supabase.instance.client.auth.currentSession?.accessToken (set once the
// Flutter app itself is migrated to supabase_flutter - see Task #26).
//
// supabase.auth.getUser(token) round-trips to Supabase's Auth server to
// validate the token and return the user it belongs to - the direct
// equivalent of Firebase Admin's auth.verifyIdToken(token) before it.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization bearer token" });
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      throw error || new Error("No user returned for this token");
    }
    const uid = data.user.id;

    // Postgres has no equivalent of Firebase's admin custom claim riding
    // along inside the token itself - is_admin lives on the profiles table
    // instead (see supabase_schema.sql), so this is one extra lookup per
    // authenticated request. Same cost every other route handler already
    // pays reading its own data; not worth caching before it's measured.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("uid", uid)
      .maybeSingle();
    if (profileError) throw profileError;

    req.user = {
      uid,
      email: data.user.email || null,
      isAdmin: profile?.is_admin === true,
    };
    next();
  } catch (err) {
    console.error("Token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Must run after requireAuth (needs req.user). Blocks any route it guards
// for non-admins with a 403. Unchanged from the Firebase version - nothing
// downstream of req.user.isAdmin needed to know which auth provider set it.
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
