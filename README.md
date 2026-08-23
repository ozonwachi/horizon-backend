# Horizon Backend

Node/Express service that handles everything Project Horizon needs server-side
(tranche-based escrow, wallet, Paystack payments/webhooks, admin overrides,
in-app notifications) without touching Google Cloud Billing. Firebase Auth,
Firestore, and Storage stay exactly as they are on the **free Spark plan** -
this service just talks to Firestore using the Admin SDK from outside
Firebase's own Cloud Functions.

## Why this exists

Cloud Functions require the Blaze (pay-as-you-go) plan, which goes through
Google Cloud Billing card verification. This service is the workaround: same
Firestore data, same security rules, same Flutter app - just hosted on
Render instead of Cloud Functions.

## Project structure

```
horizon-backend/
  src/
    index.js                     # Express app entrypoint
    config/firebaseAdmin.js      # Firebase Admin SDK init
    middleware/auth.js           # Verifies Firebase ID tokens; requireAdmin checks the admin custom claim
    routes/escrow.js             # EscrowAgreement CRUD, payment, tranches, cancel, admin edit, cron hook
    routes/wallet.js             # Wallet balance, deposits, withdrawals
    routes/paystackWebhook.js    # Paystack webhook handler (signature-verified)
    services/escrowService.js    # EscrowAgreement + tranche + commission logic (Firestore)
    services/walletService.js    # Wallet balance/deposit/withdrawal logic (Firestore)
    services/paystackService.js  # Paystack API wrapper
    services/notificationService.js # Writes to the `notifications` collection the app reads
    services/auditLogService.js  # Writes to the `auditLogs` collection (admin actions)
  scripts/
    setAdminClaim.js             # CLI: grant/revoke the `admin: true` custom claim on a user
  .env.example
  package.json
```

## 1. Get your Firebase service account key

Firebase Console -> Project Settings -> Service Accounts -> **Generate new
private key**. This downloads a JSON file. You will paste its *entire
contents* as one environment variable - never commit this file.

## 2. Local setup

```bash
cd horizon-backend
npm install
cp .env.example .env
```

Edit `.env`:
- `FIREBASE_SERVICE_ACCOUNT_JSON` - paste the whole service account JSON as a single line
- `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` - from your Paystack dashboard (test keys first)
- `ALLOWED_ORIGINS` - for local testing this can stay loose; tighten for prod
- `CRON_SECRET` - any random string; shared between this service and the cron job that hits `/escrow/internal/flag-overdue-tranches`

Run it:
```bash
npm run dev
```

Check it's alive:
```bash
curl http://localhost:8080/health
```

## 3. Deploy to Render

1. Push this folder to GitHub (`https://github.com/ozonwachi/horizon-backend`, branch `main`).
2. Render dashboard -> **New -> Web Service** -> connect the repo.
3. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Environment tab -> add the same variables as your `.env` (see above).
5. Deploy. Render gives you a URL like `https://horizon-backend-ufve.onrender.com`.

Because Render auto-deploys on push to `main` by default, once you `git push`
your changes to GitHub, Render picks them up on its own - no manual deploy
needed unless auto-deploy is turned off for the service.

### Applying changes from this session

This copy came out of a Claude session, not a live `git clone` on your
machine. To actually ship it: clone the real repo fresh (`git clone
https://github.com/ozonwachi/horizon-backend.git`), copy the new/changed
files from this delivery into that clone at the same paths, then from inside
the clone:

```bash
git add -A
git commit -m "Add cancel flow, admin edit, notifications, audit log, requireAdmin"
git push
```

Claude has no GitHub push credentials in this environment, so this last step
is always yours to run.

### Cron: flagging overdue tranches

`POST /escrow/internal/flag-overdue-tranches` is not behind `requireAuth` -
it's protected by a shared secret header instead, since Render Cron Jobs
don't carry a Firebase user token. Set `CRON_SECRET` as an env var on both
the web service and the cron job, then point the cron job's command at:

```bash
curl -X POST https://horizon-backend-ufve.onrender.com/escrow/internal/flag-overdue-tranches \
  -H "x-cron-secret: $CRON_SECRET"
```

This never releases funds by itself - it only stamps overdue tranches so the
app can prompt the buyer to release. Money only ever moves when the buyer
explicitly confirms release, or an admin resolves a dispute.

### Granting an admin

Admin-only routes (generic escrow edit, and the future admin dispute UI)
check a Firebase custom claim, not a Firestore field. Grant one from your own
machine (needs the same `FIREBASE_SERVICE_ACCOUNT_JSON` in your `.env`):

```bash
node scripts/setAdminClaim.js <uid> grant
node scripts/setAdminClaim.js <uid> revoke
```

The affected user needs to sign out/in (or the app needs to force-refresh
their ID token) before `admin: true` shows up and unlocks admin UI in the
Flutter app.

## 4. Point Paystack webhooks here

Paystack Dashboard -> Settings -> API Keys & Webhooks -> Webhook URL:
```
https://horizon-backend-ufve.onrender.com/webhooks/paystack
```

## 5. Calling it from Flutter

Every request needs the user's Firebase ID token:

```dart
final user = FirebaseAuth.instance.currentUser;
final idToken = await user?.getIdToken();

final response = await http.post(
  Uri.parse('https://horizon-backend-ufve.onrender.com/escrow/agreements'),
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

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/escrow/agreements` | user | Create a new EscrowAgreement (pending_payment) |
| POST | `/escrow/agreements/:id/pay` | user (buyer) | Get Paystack authorization URL to fund it |
| POST | `/escrow/agreements/:id/pay-with-wallet` | user (buyer) | Fund it instantly from wallet balance |
| POST | `/escrow/agreements/:id/verify` | user | Manually verify a Paystack transaction (fallback to webhook) |
| POST | `/escrow/agreements/:id/release` | user (buyer) | Legacy: release the whole (single-tranche) agreement |
| POST | `/escrow/agreements/:id/tranches/:trancheId/release` | user (buyer) | Buyer confirms/releases one tranche |
| POST | `/escrow/agreements/:id/tranches/:trancheId/milestone` | user (seller) | Seller marks a milestone reached, starting a timed tranche's countdown |
| POST | `/escrow/agreements/:id/tranches/:trancheId/dispute` | user (either party) | Dispute a single tranche |
| POST | `/escrow/agreements/:id/dispute` | user (either party) | Legacy: dispute a whole (single-tranche) agreement |
| POST | `/escrow/agreements/:id/cancel` | user (either party) | Buyer cancels unilaterally if unfunded; otherwise requires both parties to call this |
| PATCH | `/escrow/agreements/:id/admin` | **admin** | Edit amount/commission/title/description, with a required `reason`; audit-logged |
| GET | `/escrow/agreements/admin/all` | **admin** | List every agreement in the system (not just the caller's own) - powers the Admin Dashboard screen; optional `?status=disputed` to filter |
| POST | `/escrow/agreements/:id/tranches/:trancheId/admin-resolve` | **admin** | Resolve a disputed tranche - `{"outcome":"release"}` pays the seller, `{"outcome":"refund"}` pays the buyer back; audit-logged |
| POST | `/escrow/agreements/:id/tranches/:trancheId/admin-edit` | **admin** | Edit a tranche's `amountKobo`/`label`, with a required `reason` - only while it's still `pending`; audit-logged |
| POST | `/escrow/agreements/:id/admin-force-cancel` | **admin** | Ends a deal immediately - `{"decisions":{"<trancheId>":"release"\|"refund"},"reason":"..."}` must decide every still-open tranche; no formal dispute required first, no cap on amount; audit-logged |
| GET | `/escrow/agreements/admin/audit-log` | **admin** | List admin actions, most recent first; optional `?agreementId=...` to scope to one deal |
| GET | `/escrow/agreements/:id/admin-conversation` | **admin** | Read-only: the buyer/seller chat thread for this deal (evidence for what they agreed on) - reads via the Admin SDK since Firestore's client rules only let the two participants read it directly |
| GET | `/escrow/agreements` | user | List every agreement the caller is buyer or seller on |
| GET | `/escrow/agreements/:id` | user (buyer/seller) or admin | Fetch one agreement |
| POST | `/escrow/internal/flag-overdue-tranches` | `x-cron-secret` header | Cron hook - flags (does not release) overdue tranches |
| GET | `/wallet/balance` | user | Current wallet balance |
| POST | `/wallet/deposits` | user | Start a Paystack deposit into the wallet |
| POST | `/wallet/deposits/verify` | user | Verify a wallet deposit |
| POST | `/wallet/withdrawals` | user | Request a withdrawal to a bank account |
| GET | `/wallet/withdrawals` | user | List the caller's withdrawal requests |
| POST | `/webhooks/paystack` | signature-verified | Paystack webhook receiver |

## Firestore collections this expects

- `escrowAgreements` - created/managed entirely by this backend (Admin SDK bypasses Firestore rules; no client-facing rule needed - see `firestore.rules`)
- `wallets` - one doc per uid, `{ balanceKobo }`
- `withdrawalRequests` - created by `walletService.requestWithdrawal`
- `notifications` - written by `notificationService.notifyUser`/`notifyUsers`; the Flutter app reads/marks-read its own docs directly (rule allows `get`/`list`/limited `update` where `userId == request.auth.uid`)
- `auditLogs` - written by `auditLogService.recordAuditLog` on every admin override, now including a plain `agreementId` field (alongside `targetType`/`targetId`) so `listAuditLogs` can filter to one deal with a simple equality query; Admin-SDK-only, no client-facing rule
- `conversations` (+ `messages` subcollection) - owned by the Flutter app's `MessageService`, not this backend; `conversationService.getEscrowConversation` reads a deal's thread via the Admin SDK purely so an admin (not a participant) can view it as evidence - never writes to it
- `commissionRules` - seed manually in the Firestore console for now:
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
- Backend for the in-app "Message Admin" / "Open a Dispute" screen - currently frontend-only (captures locally, no backend call) by design, pending an actual admin support inbox
- Push notifications (current `notifications` collection only powers in-app bell/list, no FCM push yet)
