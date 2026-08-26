import { createHmac, timingSafeEqual } from "node:crypto";
import { requireSecret } from "./supabaseAdmin.ts";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function getSecretKey(): string {
  return requireSecret("PAYSTACK_SECRET_KEY");
}

// Ported from src/services/paystackService.js. `fetch` is a Deno global -
// no node-fetch import needed, unlike the Express version.

// Starts a payment - call this when a buyer wants to fund an escrow.
// amountKobo must be in the smallest currency unit (kobo for NGN).
export async function initializeTransaction({
  email,
  amountKobo,
  reference,
  metadata,
}: {
  email: string;
  amountKobo: number;
  reference: string;
  // deno-lint-ignore no-explicit-any
  metadata?: any;
}) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, amount: amountKobo, reference, metadata }),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || "Paystack initialize failed");
  }
  return data.data; // { authorization_url, access_code, reference }
}

// Confirms a transaction actually succeeded - never trust the client's word
// for this, always verify server-side before releasing/crediting escrow.
export async function verifyTransaction(reference: string) {
  const res = await fetch(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${getSecretKey()}` } }
  );

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || "Paystack verify failed");
  }
  return data.data; // includes status: "success" | "failed" | "abandoned"
}

// Sends money out to a bank account - used when releasing escrow funds to a
// seller. Requires the recipient to be created first via
// createTransferRecipient.
export async function initiateTransfer({
  amountKobo,
  recipientCode,
  reason,
  reference,
}: {
  amountKobo: number;
  recipientCode: string;
  reason?: string;
  reference: string;
}) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transfer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "balance",
      amount: amountKobo,
      recipient: recipientCode,
      reason,
      reference,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || "Paystack transfer failed");
  }
  return data.data;
}

export async function createTransferRecipient({
  name,
  accountNumber,
  bankCode,
}: {
  name: string;
  accountNumber: string;
  bankCode: string;
}) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transferrecipient`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || "Paystack recipient creation failed");
  }
  return data.data; // includes recipient_code
}

// Paystack signs webhook bodies with your secret key (HMAC SHA512). Always
// verify this before trusting a webhook payload - anyone can POST to your
// webhook URL otherwise. Upgraded from the Express version's plain `===`
// string compare to a constant-time comparison (timingSafeEqual) while
// porting - closes a (pre-existing, low-severity) timing side-channel for
// free since this code was already being touched.
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", getSecretKey()).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const gotBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}
