const express = require("express");
const { requireAuth } = require("../middleware/auth");
const escrowService = require("../services/escrowService");
const paystackService = require("../services/paystackService");
const { auth: firebaseAuth } = require("../config/firebaseAdmin");

const router = express.Router();
router.use(requireAuth);

// POST /escrow/agreements
// Buyer creates an escrow agreement for a listing/job/barter before paying.
router.post("/agreements", async (req, res) => {
  try {
    const { sellerId, type, category, amountKobo, terms, referenceId } = req.body;

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
    });

    res.status(201).json(agreement);
  } catch (err) {
    console.error("Create agreement failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /escrow/agreements/:id/pay
// Starts the Paystack transaction for an existing agreement. Returns the
// authorization_url the Flutter app opens (via webview or browser launcher).
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

// POST /escrow/agreements/:id/verify
// Fallback route the app can call after redirect if you're not relying
// solely on the webhook (webhook is still the source of truth in prod).
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

// POST /escrow/agreements/:id/release
// Buyer confirms receipt/completion -> releases funds to seller.
// TODO: once seller payout details (bank account) are collected, wire this
// to paystackService.createTransferRecipient + initiateTransfer.
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
    res.status(500).json({ error: err.message });
  }
});

// POST /escrow/agreements/:id/dispute
router.post("/agreements/:id/dispute", async (req, res) => {
  try {
    const agreement = await escrowService.getAgreement(req.params.id);
    if (!agreement) return res.status(404).json({ error: "Agreement not found" });
    if (![agreement.buyerId, agreement.sellerId].includes(req.user.uid)) {
      return res.status(403).json({ error: "Not a party to this agreement" });
    }

    const updated = await escrowService.markDisputed(req.params.id, req.body.reason);
    res.json(updated);
  } catch (err) {
    console.error("Dispute failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /escrow/agreements/:id
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
