const express = require("express");
const { requireAuth } = require("../middleware/auth");
const walletService = require("../services/walletService");
const { auth: firebaseAuth } = require("../config/firebaseAdmin");

const router = express.Router();
router.use(requireAuth);

router.get("/balance", async (req, res) => {
  try {
    const balanceKobo = await walletService.getBalance(req.user.uid);
    res.json({ balanceKobo });
  } catch (err) {
    console.error("Get balance failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/deposits", async (req, res) => {
  try {
    const { amountKobo } = req.body;
    const user = await firebaseAuth.getUser(req.user.uid);

    const result = await walletService.initiateDeposit({
      uid: req.user.uid,
      email: user.email,
      amountKobo,
    });

    res.json(result);
  } catch (err) {
    console.error("Deposit init failed:", err);
    res.status(400).json({ error: err.message });
  }
});

router.post("/deposits/verify", async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: "reference is required" });

    const result = await walletService.verifyDeposit({
      uid: req.user.uid,
      reference,
    });
    res.json(result);
  } catch (err) {
    console.error("Deposit verify failed:", err);
    res.status(400).json({ error: err.message });
  }
});

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