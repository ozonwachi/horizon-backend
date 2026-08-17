const express = require("express");
const paystackService = require("../services/paystackService");
const escrowService = require("../services/escrowService");
const walletService = require("../services/walletService");

const router = express.Router();

router.post("/", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.body;

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

  res.sendStatus(200);

  try {
    if (event.event === "charge.success") {
      const { reference, metadata, amount } = event.data;

      if (metadata && metadata.agreementId) {
        await escrowService.markFunded(metadata.agreementId, reference);
        console.log(`Escrow ${metadata.agreementId} funded via webhook (${reference})`);
      } else if (metadata && metadata.type === "wallet_deposit" && metadata.uid) {
        await walletService.confirmDeposit({
          uid: metadata.uid,
          amountKobo: amount,
          reference,
        });
        console.log(`Wallet deposit credited for ${metadata.uid} (${reference})`);
      }
    }
  } catch (err) {
    console.error("Error processing webhook event:", err);
  }
});

module.exports = router;