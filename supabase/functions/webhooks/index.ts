import { Hono } from "npm:hono@4";
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { verifyWebhookSignature } from "../_shared/paystackService.ts";
import { markFunded } from "../_shared/escrowService.ts";
import { confirmDeposit } from "../_shared/walletService.ts";
import { runInBackground } from "../_shared/backgroundTask.ts";

// Ported from src/routes/paystackWebhook.js. Public - Paystack has no
// Supabase JWT to send, so this function has verify_jwt = false in
// config.toml and does its own auth via the HMAC signature instead. No
// CORS needed either (server-to-server, not called from a browser).
//
// Paystack's webhook URL needs updating in the Paystack dashboard to point
// at this function once deployed:
//   https://<project-ref>.supabase.co/functions/v1/webhooks/paystack
const app = new Hono().basePath("/webhooks");

app.post("/paystack", async (c) => {
  const signature = c.req.header("x-paystack-signature") || null;
  // Must read as raw text (not c.req.json()) so the HMAC is computed over
  // the exact bytes Paystack signed - parsing to JSON first and
  // re-stringifying could produce different bytes (key order, whitespace)
  // and silently break every signature check.
  const rawBody = await c.req.text();

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn("Rejected webhook: bad signature");
    return c.text("Invalid signature", 401);
  }

  // deno-lint-ignore no-explicit-any
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.text("Bad JSON", 400);
  }

  // Ack Paystack immediately (same reasoning as the old Express handler's
  // res.sendStatus(200) before its try/catch) - Paystack retries on a slow
  // or non-2xx response, and none of the work below needs to finish before
  // we can safely tell them we got it. EdgeRuntime.waitUntil keeps this
  // function alive long enough to finish that work after the response has
  // already gone out.
  runInBackground(processEvent(event));

  return c.text("OK", 200);
});

// deno-lint-ignore no-explicit-any
async function processEvent(event: any): Promise<void> {
  try {
    if (event.event === "charge.success") {
      const { reference, metadata, amount } = event.data;
      const supabase = getAdminClient();

      if (metadata && metadata.agreementId) {
        await markFunded(supabase, metadata.agreementId, reference);
        console.log(`Escrow ${metadata.agreementId} funded via webhook (${reference})`);
      } else if (metadata && metadata.type === "wallet_deposit" && metadata.uid) {
        await confirmDeposit(supabase, { uid: metadata.uid, amountKobo: amount, reference });
        console.log(`Wallet deposit credited for ${metadata.uid} (${reference})`);
      }
    }
  } catch (err) {
    console.error("Error processing webhook event:", err);
  }
}

Deno.serve(app.fetch);
