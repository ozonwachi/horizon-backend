import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { requireAuth, requireAdmin, type AppEnv } from "../_shared/auth.ts";
import * as walletService from "../_shared/walletService.ts";

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

app.post("/deposits", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
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

app.post("/deposits/verify", async (c) => {
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

app.post("/withdrawals", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
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
  const id = c.req.param("id")!;
  try {
    const updated = await walletService.markWithdrawalPaid(getAdminClient(), id);
    return c.json(updated);
  } catch (err) {
    console.error("Mark withdrawal paid failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/admin/withdrawals/:id/reject", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  try {
    const updated = await walletService.rejectWithdrawal(getAdminClient(), id, body?.reason);
    return c.json(updated);
  } catch (err) {
    console.error("Reject withdrawal failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

Deno.serve(app.fetch);
