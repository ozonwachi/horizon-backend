const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const platformSettingsService = require("../services/platformSettingsService");

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

router.get("/settings", async (req, res) => {
  try {
    const [settings, commissionRules] = await Promise.all([
      platformSettingsService.getSettings(),
      platformSettingsService.listCommissionRules(),
    ]);
    res.json({ settings, commissionRules });
  } catch (err) {
    console.error("Get platform settings failed:", err);
    res.status(500).json({ error: err.message });
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const settings = await platformSettingsService.updateSettings(req.user.uid, req.body || {});
    res.json(settings);
  } catch (err) {
    console.error("Update platform settings failed:", err);
    res.status(400).json({ error: err.message });
  }
});

router.put("/commission-rules", async (req, res) => {
  try {
    const rule = await platformSettingsService.upsertCommissionRule(req.user.uid, req.body || {});
    res.json(rule);
  } catch (err) {
    console.error("Upsert commission rule failed:", err);
    res.status(400).json({ error: err.message });
  }
});

router.delete("/commission-rules/:id", async (req, res) => {
  try {
    await platformSettingsService.deleteCommissionRule(req.user.uid, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete commission rule failed:", err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
