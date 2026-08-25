const express = require("express");
const { requireAuth } = require("../middleware/auth");
const referralService = require("../services/referralService");

const router = express.Router();
router.use(requireAuth);

// Called once, right after a brand-new signup, if the person entered a
// referral code (see signup_screen.dart's optional field). Not fatal to
// the caller's flow either way - by the time this runs the account already
// exists, so a bad/reused code just means no referral relationship gets
// recorded, not a failed signup.
router.post("/link", async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ error: "referralCode is required" });

    await referralService.linkReferral(req.user.uid, referralCode);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Everything the "My Referrals" screen needs: the user's own code, who
// they've referred, and how much they've earned.
router.get("/me", async (req, res) => {
  try {
    const summary = await referralService.getReferralSummary(req.user.uid);
    res.json(summary);
  } catch (err) {
    console.error("Get referral summary failed:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
