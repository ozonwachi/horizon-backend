import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, requireAdmin, requireActiveAccount, type AppEnv } from "../_shared/auth.ts";
import * as walletService from "../_shared/walletService.ts";
import { getSettings } from "../_shared/platformSettingsService.ts";
import * as otpService from "../_shared/otpService.ts";
import { rateLimitOrRespond } from "../_shared/rateLimitService.ts";

// Ported from src/routes/wallet.js.
const app = new Hono<AppEnv>().basePath("/wallet");

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "apikey"] }));
app.use("*", requireAuth);

app.get("/balance", async (c) => {
  const user = c.get("user");
  try {
    const balanceKobo = await walletService.getBalance(getAdminClient(), user.uid);
    return c.json({ balanceKobo });
  } catch (err) {
    console.error("Get balance failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/deposits", requireActiveAccount, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const limited = await rateLimitOrRespond(
    getAdminClient(),
    `deposit-init:${user.uid}`,
    { max: 10, windowSeconds: 3600 },
    c
  );
  if (limited) return limited;

  try {
    const result = await walletService.initiateDeposit(getAdminClient(), {
      uid: user.uid,
      email: user.email,
      amountKobo: body?.amountKobo,
    });
    return c.json(result);
  } catch (err) {
    console.error("Deposit init failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/deposits/verify", requireActiveAccount, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const reference = body?.reference;
  if (!reference) return c.json({ error: "reference is required" }, 400);

  try {
    const result = await walletService.verifyDeposit(getAdminClient(), { uid: user.uid, reference });
    return c.json(result);
  } catch (err) {
    console.error("Deposit verify failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Security: step-up verification for withdrawals (real money leaving the
// platform). The client must first call this to get a 6-digit code emailed
// to the account's address on file, then submit it as `otpCode` in the
// POST /withdrawals body below - see otpService.ts for why this exists
// alongside admin TOTP MFA rather than instead of it.
app.post("/withdrawals/request-otp", requireActiveAccount, async (c) => {
  const user = c.get("user");
  try {
    const result = await otpService.requestOtp(getAdminClient(), {
      uid: user.uid,
      email: user.email,
      action: "withdrawal",
    });
    return c.json(result);
  } catch (err) {
    console.error("Withdrawal OTP request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/withdrawals", requireActiveAccount, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const limited = await rateLimitOrRespond(
    getAdminClient(),
    `withdrawal-submit:${user.uid}`,
    { max: 5, windowSeconds: 3600 },
    c
  );
  if (limited) return limited;

  try {
    await otpService.verifyOtp(getAdminClient(), {
      uid: user.uid,
      action: "withdrawal",
      code: body?.otpCode,
    });
    const request = await walletService.requestWithdrawal(getAdminClient(), {
      uid: user.uid,
      amountKobo: body?.amountKobo,
      bankName: body?.bankName,
      accountNumber: body?.accountNumber,
      accountName: body?.accountName,
    });
    return c.json(request, 201);
  } catch (err) {
    console.error("Withdrawal request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get("/withdrawals", async (c) => {
  const user = c.get("user");
  try {
    const requests = await walletService.listWithdrawalsForUser(getAdminClient(), user.uid);
    return c.json(requests);
  } catch (err) {
    console.error("List withdrawals failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Every release, refund, payment, deposit, and withdrawal touching this
// user's wallet, newest first.
app.get("/transactions", async (c) => {
  const user = c.get("user");
  try {
    const transactions = await walletService.listTransactions(getAdminClient(), user.uid);
    return c.json(transactions);
  } catch (err) {
    console.error("List wallet transactions failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Read-only, any signed-in user (not admin-gated) - the current
// admin-configured connection fee, so the app can show a specific number in
// the off-platform-deal warning and pre-fill the "declare and pay" dialog,
// without exposing the rest of platform_settings (commission rates etc)
// which stays admin-only via /admin/settings.
app.get("/connection-fee-settings", async (c) => {
  try {
    const settings = await getSettings(getAdminClient());
    return c.json({
      connectionFeeType: settings.connectionFeeType,
      connectionFeeValue: settings.connectionFeeValue,
    });
  } catch (err) {
    console.error("Get connection fee settings failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Self-serve: a user declaring and paying the connection fee for a deal
// they took off-platform. Debits their wallet, credits the admin wallet -
// see pay_connection_fee() in
// project_supabase_migration_17_connection_fee_and_contact_flags.sql.
app.post("/connection-fee", requireActiveAccount, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  const limited = await rateLimitOrRespond(
    getAdminClient(),
    `connection-fee:${user.uid}`,
    { max: 10, windowSeconds: 3600 },
    c
  );
  if (limited) return limited;

  try {
    const result = await walletService.payConnectionFee(getAdminClient(), {
      uid: user.uid,
      amountKobo: body?.amountKobo,
      note: body?.note,
    });
    return c.json(result);
  } catch (err) {
    console.error("Pay connection fee failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Admin-only: the dedicated wallet that holds money from a force-cancel
// split an admin explicitly routed away from both buyer and seller - never
// funded any other way, so its balance and history are entirely money an
// admin will need to manually resolve later.
app.get("/admin-wallet/balance", requireAdmin, async (c) => {
  try {
    const balanceKobo = await walletService.getAdminWalletBalance(getAdminClient());
    return c.json({ balanceKobo });
  } catch (err) {
    console.error("Get admin wallet balance failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/admin-wallet/transactions", requireAdmin, async (c) => {
  try {
    const transactions = await walletService.listAdminWalletTransactions(getAdminClient());
    return c.json(transactions);
  } catch (err) {
    console.error("List admin wallet transactions failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Admin: process pending withdrawal requests.
app.get("/admin/withdrawals", requireAdmin, async (c) => {
  try {
    const requests = await walletService.listAllWithdrawalsAdmin(getAdminClient());
    return c.json(requests);
  } catch (err) {
    console.error("List all withdrawals failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/admin/withdrawals/:id/mark-paid", requireAdmin, async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id")!;
  try {
    const updated = await walletService.markWithdrawalPaid(getAdminClient(), id, admin.uid);
    return c.json(updated);
  } catch (err) {
    console.error("Mark withdrawal paid failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/admin/withdrawals/:id/reject", requireAdmin, async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  try {
    const updated = await walletService.rejectWithdrawal(getAdminClient(), id, body?.reason, admin.uid);
    return c.json(updated);
  } catch (err) {
    console.error("Reject withdrawal failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
