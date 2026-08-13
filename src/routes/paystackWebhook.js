const express = require("express");
const paystackService = require("../services/paystackService");
const escrowService = require("../services/escrowService");

const router = express.Router();

// IMPORTANT: this route needs the RAW request body to verify Paystack's
// signature correctly, which is why index.js mounts express.raw() only
// for this path, before the global express.json() parser runs.
router.post("/", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.body; // Buffer, thanks to express.raw()

  if (!signature || !paystackService.verifyWebhookSignature(rawBody, signature)) {
    console.warn("Rejected webhook: bad signature");
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    return res.status(400).send("Bad JSON");
  }

  // Always ack quickly - Paystack retries if you don't 200 in time.
  res.sendStatus(200);

  try {
    if (event.event === "charge.success") {
      const { reference, metadata } = event.data;
      const agreementId = metadata && metadata.agreementId;
      if (agreementId) {
        await escrowService.markFunded(agreementId, reference);
        console.log(`Escrow ${agreementId} funded via webhook (${reference})`);
      }
    }
    // Add more event types as needed: transfer.success, transfer.failed, etc.
  } catch (err) {
    // Webhook already ack'd - log for manual follow-up rather than retrying
    // Paystack, since a 200 was already sent.
    console.error("Error processing webhook event:", err);
  }
});

module.exports = router;
