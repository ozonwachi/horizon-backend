require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const escrowRoutes = require("./routes/escrow");
const paystackWebhookRoutes = require("./routes/paystackWebhook");

const app = express();

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
  })
);

// Paystack webhook needs the RAW body for signature verification, so it's
// mounted BEFORE express.json() and given its own raw parser. Every other
// route below gets normal JSON parsing.
app.use("/webhooks/paystack", express.raw({ type: "application/json" }), paystackWebhookRoutes);

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "horizon-backend", time: new Date().toISOString() });
});

app.use("/escrow", escrowRoutes);

// Catch-all error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Horizon backend listening on port ${PORT}`);
});
