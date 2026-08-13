const crypto = require("crypto");
const fetch = require("node-fetch");

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function getSecretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set");
  return key;
}

// Starts a payment - call this when a buyer wants to fund an escrow.
// amountKobo must be in the smallest currency unit (kobo for NGN).
async function initializeTransaction({ email, amountKobo, reference, metadata }) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      metadata,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || "Paystack initialize failed");
  }
  return data.data; // { authorization_url, access_code, reference }
}

// Confirms a transaction actually succeeded - never trust the client's word
// for this, always verify server-side before releasing/crediting escrow.
async function verifyTransaction(reference) {
  const res = await fetch(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${getSecretKey()}` },
    }
  );

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || "Paystack verify failed");
  }
  return data.data; // includes status: "success" | "failed" | "abandoned"
}

// Sends money out to a bank account - used when releasing escrow funds to a
// seller. Requires the recipient to be created first via createTransferRecipient.
async function initiateTransfer({ amountKobo, recipientCode, reason, reference }) {
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

async function createTransferRecipient({ name, accountNumber, bankCode }) {
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
// webhook URL otherwise.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", getSecretKey())
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  initiateTransfer,
  createTransferRecipient,
  verifyWebhookSignature,
};
