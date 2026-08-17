const express = require("express");
const { requireAuth } = require("../middleware/auth");
const walletService = require("../services/walletService");

const router = express.Router();
router.use(requireAuth);

// GET /wallet/balance
router.get("/balance", async (req, res) => {
  try {
    const balanceKobo = await walletService.getBalance(req.user.uid);
    res.json({ balanceKobo });
  } catch (err) {
    console.error("Get balance failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /wallet/withdrawals
// Seller requests a payout. Deducts from their balance immediately so it
// can't be requested twice; you pay them manually outside the app and
// then mark the request paid (see markWithdrawalPaid - no admin UI yet,
// call it from a quick script or Firestore console update for now).
router.post("/withdrawals", async (req, res) => {
  try {
    const { amountKobo, bankName, accountNumber, accountName } = req.body;
    const request = await walletService.requestWithdrawal({
      uid: req.user.uid,
      amountKobo,
      bankName,
      accountNumber,
      accountName,
    });
    res.status(201).json(request);
  } catch (err) {
    console.error("Withdrawal request failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// GET /wallet/withdrawals
router.get("/withdrawals", async (req, res) => {
  try {
    const requests = await walletService.listWithdrawalsForUser(req.user.uid);
    res.json(requests);
  } catch (err) {
    console.error("List withdrawals failed:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;