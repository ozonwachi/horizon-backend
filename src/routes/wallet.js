const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const walletService = require("../services/walletService");

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

    const result = await walletService.initiateDeposit({
      uid: req.user.uid,
      email: req.user.email,
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

// Item: the wallet screen used to only ever show a single number that
// changed - no record of why. This is that record: every release,
// refund, payment, deposit, and withdrawal touching this user's wallet,
// newest first.
router.get("/transactions", async (req, res) => {
  try {
    const transactions = await walletService.listTransactions(req.user.uid);
    res.json(transactions);
  } catch (err) {
    console.error("List wallet transactions failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin-only: the dedicated wallet that holds money from a force-cancel
// split an admin explicitly routed away from both buyer and seller (see
// adminForceCancelDeal) - never funded any other way, so its balance and
// history are entirely money an admin will need to manually resolve later.
router.get("/admin-wallet/balance", requireAdmin, async (req, res) => {
  try {
    const balanceKobo = await walletService.getAdminWalletBalance();
    res.json({ balanceKobo });
  } catch (err) {
    console.error("Get admin wallet balance failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/admin-wallet/transactions", requireAdmin, async (req, res) => {
  try {
    const transactions = await walletService.listAdminWalletTransactions();
    res.json(transactions);
  } catch (err) {
    console.error("List admin wallet transactions failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: process pending withdrawal requests. Before this existed, nothing
// in the app could ever move a request out of "pending" - the functions
// underneath were already there, just never wired to a route or a screen.
router.get("/admin/withdrawals", requireAdmin, async (req, res) => {
  try {
    const requests = await walletService.listAllWithdrawalsAdmin();
    res.json(requests);
  } catch (err) {
    console.error("List all withdrawals failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/withdrawals/:id/mark-paid", requireAdmin, async (req, res) => {
  try {
    const updated = await walletService.markWithdrawalPaid(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error("Mark withdrawal paid failed:", err);
    res.status(400).json({ error: err.message });
  }
});

router.post("/admin/withdrawals/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const updated = await walletService.rejectWithdrawal(req.params.id, reason);
    res.json(updated);
  } catch (err) {
    console.error("Reject withdrawal failed:", err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;