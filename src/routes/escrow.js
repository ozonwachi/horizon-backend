const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const escrowService = require("../services/escrowService");
const paystackService = require("../services/paystackService");
const { auth: firebaseAuth } = require("../config/firebaseAdmin");

const router = express.Router();

// ---------------------------------------------------------------------------
// Internal cron endpoint - NOT behind requireAuth (Render Cron has no
// Firebase user token to send). Protected instead by a shared secret set as
// an env var on both the web service and the cron job. Must be registered
// BEFORE `router.use(requireAuth)` below, since that applies to every route
// declared after it.
//
// Set CRON_SECRET in horizon-backend's Render environment variables, and
// pass the same value as a header from the Render Cron Job's command, e.g.:
//   curl -X POST https://horizon-backend-ufve.onrender.com/escrow/internal/flag-overdue-tranches \
//     -H "x-cron-secret: $CRON_SECRET"
// ---------------------------------------------------------------------------
router.post("/internal/flag-overdue-tranches", async (req, res) => {
  const provided = req.header("x-cron-secret");
  if (!provided || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const results = await escrowService.flagOverdueTranches();
    res.json(results);
  } catch (err) {
    console.error("flagOverdueTranches failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.use(requireAuth);

router.post("/agreements", async (req, res) => {
  try {
    const {
      sellerId,
      type,
      category,
      amountKobo,
      terms,
      referenceId,
      title,
      description,
      tranches,
    } = req.body;

    if (!sellerId || !type || !amountKobo) {
      return res
        .status(400)
        .json({ error: "sellerId, type, and amountKobo are required" });
    }

    const agreement = await escrowService.createAgreement({
      buyerId: req.user.uid,
      sellerId,
      type,
      category,
      amountKobo,
      terms,
      referenceId,
      title,
      description,
      tranches,
    });

    res.status(201).json(agreement);
  } catch (err) {
    console.error("Create agreement failed:", err);
    res.status(400).json({ error: err.message });
  }
});

router.post("/agreements/:id/pay", async (req, res) => {
  try {
    const agreement = await escrowService.getAgreement(req.params.id);
    if (!agreement) return res.status(404).json({ error: "Agreement not found" });
    if (agreement.buyerId !== req.user.uid) {
      return res.status(403).json({ error: "Not your agreement" });
    }

    const buyer = await firebaseAuth.getUser(req.user.uid);
    const reference = `horizon_${agreement.id}_${Date.now()}`;

    const tx = await paystackService.initializeTransaction({
      email: buyer.email,
      amountKobo: agreement.amountKobo + agreement.commissionKobo,
      reference,
      metadata: { agreementId: agreement.id, buyerId: req.user.uid },
    });

    res.json({ authorizationUrl: tx.authorization_url, reference: tx.reference });
  } catch (err) {
    console.error("Payment init failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/agreements/:id/pay-with-wallet", async (req, res) => {
  try {
    const updated = await escrowService.payFromWallet(req.params.id, req.user.uid);
    res.json(updated);
  } catch (err) {
    console.error("Pay with wallet failed:", err);
    res.status(400).json({ error: err.message });
  }
});

router.post("/agreements/:id/verify", async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: "reference is required" });

    const tx = await paystackService.verifyTransaction(reference);
    if (tx.status !== "success") {
      return res.status(400).json({ error: `Transaction status: ${tx.status}` });
    }

    const updated = await escrowService.markFunded(req.params.id, reference);
    res.json(updated);
  } catch (err) {
    console.error("Verify failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Legacy whole-agreement release - only valid for old single-tranche
// agreements. New tranche-based agreements use /release-tranche below.
router.post("/agreements/:id/release", async (req, res) => {
  try {
    const agreement = await escrowService.getAgreement(req.params.id);
    if (!agreement) return res.status(404).json({ error: "Agreement not found" });
    if (agreement.buyerId !== req.user.uid) {
      return res.status(403).json({ error: "Only the buyer can release funds" });
    }

    const updated = await escrowService.markReleased(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error("Release failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// Buyer confirms and releases a specific tranche. Works whether the
// tranche is a plain buyer_confirmation tranche, or a timed tranche the
// buyer wants to release early / after its window has passed - the timer
// only ever makes a tranche eligible, never releases it by itself.
router.post("/agreements/:id/tranches/:trancheId/release", async (req, res) => {
  try {
    const updated = await escrowService.confirmTrancheRelease(
      req.params.id,
      req.params.trancheId,
      req.user.uid
    );
    res.json(updated);
  } catch (err) {
    console.error("Tranche release failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// Seller marks a milestone reached (e.g. "delivered"), starting the
// countdown for a timed_from_milestone tranche.
router.post("/agreements/:id/tranches/:trancheId/milestone", async (req, res) => {
  try {
    const updated = await escrowService.markMilestoneReached(
      req.params.id,
      req.params.trancheId,
      req.user.uid
    );
    res.json(updated);
  } catch (err) {
    console.error("Mark milestone failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// Dispute a specific tranche (blocks only that tranche; others keep
// flowing normally). Either buyer or seller can raise this.
router.post("/agreements/:id/tranches/:trancheId/dispute", async (req, res) => {
  try {
    const updated = await escrowService.disputeTranche(
      req.params.id,
      req.params.trancheId,
      req.body.reason,
      req.user.uid
    );
    res.json(updated);
  } catch (err) {
    console.error("Tranche dispute failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// Legacy whole-agreement dispute (old agreements without tranches).
router.post("/agreements/:id/dispute", async (req, res) => {
  try {
    const agreement = await escrowService.getAgreement(req.params.id);
    if (!agreement) return res.status(404).json({ error: "Agreement not found" });
    if (![agreement.buyerId, agreement.sellerId].includes(req.user.uid)) {
      return res.status(403).json({ error: "Not a party to this agreement" });
    }

    const updated = await escrowService.markDisputed(
      req.params.id,
      req.body.reason,
      req.user.uid
    );
    res.json(updated);
  } catch (err) {
    console.error("Dispute failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Item 2: buyer can cancel unilaterally before funding; once funded, this
// requires a matching call from the other party to actually take effect
// (see requestOrConfirmCancel's doc comment in escrowService.js).
router.post("/agreements/:id/cancel", async (req, res) => {
  try {
    const updated = await escrowService.requestOrConfirmCancel(req.params.id, req.user.uid);
    res.json(updated);
  } catch (err) {
    console.error("Cancel failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// Item 3/4: generic admin edit (amount/commission/title/description), e.g.
// to correct a job-escrow amount after a dispute. requireAdmin checks the
// Firebase custom claim set via scripts/setAdminClaim.js.
router.patch("/agreements/:id/admin", requireAdmin, async (req, res) => {
  try {
    const { reason, ...changes } = req.body;
    const updated = await escrowService.adminUpdateAgreement(
      req.params.id,
      req.user.uid,
      changes,
      reason
    );
    res.json(updated);
  } catch (err) {
    console.error("Admin update failed:", err);
    res.status(400).json({ error: err.message });
  }
});

router.get("/agreements", async (req, res) => {
  try {
    const agreements = await escrowService.listForUser(req.user.uid);
    res.json(agreements);
  } catch (err) {
    console.error("List agreements failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/agreements/:id", async (req, res) => {
  try {
    const agreement = await escrowService.getAgreement(req.params.id);
    if (!agreement) return res.status(404).json({ error: "Agreement not found" });
    if (![agreement.buyerId, agreement.sellerId].includes(req.user.uid)) {
      return res.status(403).json({ error: "Not a party to this agreement" });
    }
    res.json(agreement);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;