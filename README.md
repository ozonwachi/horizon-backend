# Horizon Backend

Node/Express service that handles everything Project Horizon needs server-side
(escrow logic, Paystack payments/webhooks) without touching Google Cloud
Billing. Firebase Auth, Firestore, and Storage stay exactly as they are on
the **free Spark plan** — this service just talks to Firestore using the
Admin SDK from outside Firebase's own Cloud Functions.

## Why this exists

Cloud Functions require the Blaze (pay-as-you-go) plan, which goes through
Google Cloud Billing card verification. If that verification keeps failing
with your cards, this service is the workaround: same Firestore data, same
security rules, same Flutter app — just hosted on Render/Railway instead of
Cloud Functions.

## Project structure

```
horizon-backend/
  src/
    index.js                  # Express app entrypoint
    config/firebaseAdmin.js   # Firebase Admin SDK init
    middleware/auth.js        # Verifies Firebase ID tokens from the Flutter app
    routes/escrow.js          # EscrowAgreement CRUD + payment flow
    routes/paystackWebhook.js # Paystack webhook handler (signature-verified)
    services/escrowService.js   # EscrowAgreement + CommissionRule logic (Firestore)
    services/paystackService.js # Paystack API wrapper
  .env.example
  package.json
```

## 1. Get your Firebase service account key

Firebase Console → Project Settings → Service Accounts → **Generate new
private key**. This downloads a JSON file. You will paste its *entire
contents* as one environment variable — never commit this file.

## 2. Local setup

```bash
cd horizon-backend
npm install
cp .env.example .env
```

Edit `.env`:
- `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the whole service account JSON as a single line
- `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` — from your Paystack dashboard (test keys first)
- `ALLOWED_ORIGINS` — for local testing this can stay loose; tighten for prod

Run it:
```bash
npm run dev
```

Check it's alive:
```bash
curl http://localhost:8080/health
```

## 3. Deploy to Render

1. Push this folder to a GitHub repo (can be a subfolder of your main repo, or its own repo).
2. Render dashboard → **New → Web Service** → connect the repo.
3. Settings:
   - **Root Directory**: `horizon-backend` (if it's a subfolder)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (fine to start)
4. Environment tab → add the same variables as your `.env`:
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
   - `PAYSTACK_SECRET_KEY`
   - `PAYSTACK_PUBLIC_KEY`
   - `ALLOWED_ORIGINS` (set to your production Flutter web origin, if any)
5. Deploy. Render gives you a URL like `https://horizon-backend.onrender.com`.

Note: Render's free tier spins down after inactivity and takes ~30-60s to
wake up on the next request. Fine for development; worth upgrading to a paid
instance ($7/mo tier, generally easier card acceptance than Google Cloud
Billing) before real users hit it, so escrow payments aren't waiting on a
cold start.

## 4. Point Paystack webhooks here

Paystack Dashboard → Settings → API Keys & Webhooks → Webhook URL:
```
https://horizon-backend.onrender.com/webhooks/paystack
```

## 5. Calling it from Flutter

Every request needs the user's Firebase ID token:

```dart
final user = FirebaseAuth.instance.currentUser;
final idToken = await user?.getIdToken();

final response = await http.post(
  Uri.parse('https://horizon-backend.onrender.com/escrow/agreements'),
  headers: {
    'Authorization': 'Bearer $idToken',
    'Content-Type': 'application/json',
  },
  body: jsonEncode({
    'sellerId': sellerId,
    'type': 'listing',
    'category': category,
    'amountKobo': amountKobo,
    'referenceId': listingId,
  }),
);
```

## API reference (v1)

| Method | Path | Purpose |
|---|---|---|
| POST | `/escrow/agreements` | Create a new EscrowAgreement (pending_payment) |
| POST | `/escrow/agreements/:id/pay` | Get Paystack authorization URL to fund it |
| POST | `/escrow/agreements/:id/verify` | Manually verify a transaction (fallback to webhook) |
| POST | `/escrow/agreements/:id/release` | Buyer releases funds to seller |
| POST | `/escrow/agreements/:id/dispute` | Either party flags a dispute |
| GET | `/escrow/agreements/:id` | Fetch an agreement (buyer/seller only) |
| POST | `/webhooks/paystack` | Paystack webhook receiver (signature-verified) |

## Firestore collections this expects

- `escrowAgreements` — created/managed entirely by this backend
- `commissionRules` — you'll seed these manually in Firestore console for now:
  ```json
  {
    "type": "listing",
    "category": "electronics",
    "mode": "percentage",
    "value": 5,
    "minKobo": 5000,
    "maxKobo": 500000
  }
  ```

## Still TODO (not built yet)

- Seller payout collection UI (bank account + `createTransferRecipient` call) in Flutter
- Wiring `release` route to actually call `paystackService.initiateTransfer`
- Timed/conditional release terms (currently `terms` is stored but not enforced)
- Admin dispute resolution endpoints
