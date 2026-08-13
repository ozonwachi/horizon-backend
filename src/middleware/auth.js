const { auth } = require("../config/firebaseAdmin");

// Flutter app calls this backend with:
//   headers: { Authorization: "Bearer <firebase-id-token>" }
// where <firebase-id-token> comes from FirebaseAuth.instance.currentUser.getIdToken()
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization bearer token" });
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (err) {
    console.error("Token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { requireAuth };
