# Backend Migration: Render → Supabase Edge Functions

The entire `horizon-backend-fresh` Express server has been rewritten as
Supabase Edge Functions (Deno + Hono), under a new `supabase/functions/`
folder in that same repo. Every route, every piece of business logic
(commission calculation, tranche release, referral payouts, force-cancel
splits, audit logging) is ported 1:1 - same behavior, same request/response
shapes, just running on Supabase instead of Render. The old `src/` Express
app is left in place untouched, as a rollback fallback until you've
verified the Edge Functions actually work.

Six functions, matching the six route groups the Express app had:
`escrow`, `wallet`, `conversations`, `referrals`, `admin`, `webhooks`.

## 1. Deploy

From `horizon-backend-fresh` on your machine (needs the Supabase CLI - `npm
install -g supabase` if you don't have it):

```
supabase login
supabase link --project-ref YOUR-PROJECT-REF
```

(`YOUR-PROJECT-REF` is the same one in your `SupabaseConfig.url` in the
Flutter app - the part before `.supabase.co`.)

Then set every secret the functions need. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are injected automatically - everything else
needs to be set explicitly:

```
supabase secrets set PAYSTACK_SECRET_KEY=sk_live_...
supabase secrets set ADMIN_WALLET_UID=<the uuid you set up earlier>
supabase secrets set CRON_SECRET=<make up a long random string>
supabase secrets set ALLOWED_ORIGINS=<comma-separated origins, or leave unset to allow all>
```

Then deploy everything:

```
supabase functions deploy
```

That deploys all six at once. Each one gets a URL like:

```
https://YOUR-PROJECT-REF.supabase.co/functions/v1/escrow
https://YOUR-PROJECT-REF.supabase.co/functions/v1/wallet
https://YOUR-PROJECT-REF.supabase.co/functions/v1/conversations
https://YOUR-PROJECT-REF.supabase.co/functions/v1/referrals
https://YOUR-PROJECT-REF.supabase.co/functions/v1/admin
https://YOUR-PROJECT-REF.supabase.co/functions/v1/webhooks
```

The Flutter app already points at these - every service file's `_baseUrl`
now reads `${SupabaseConfig.url}/functions/v1`, so as long as
`SupabaseConfig.url` is set correctly (it already is, from the original
Supabase setup), no further app changes are needed. Run `flutter pub get`
/ rebuild after pulling these changes just to be safe.

## 2. Point Paystack at the new webhook URL

In the Paystack dashboard, under Settings → API Keys & Webhooks, change the
webhook URL from the old Render one to:

```
https://YOUR-PROJECT-REF.supabase.co/functions/v1/webhooks/paystack
```

Until you do this, Paystack keeps POSTing to Render - harmless as long as
Render is still running (see the cutover plan below), but deposits and
escrow funding won't be confirmed through the new path until you switch it.

## 3. Replace the cron job

The old Render Cron Job hit `/escrow/internal/flag-overdue-tranches` on a
schedule, authenticated with a shared secret header. Render Cron goes away
with Render - you need a new scheduler pointed at the new URL. Two
reasonable options:

**Option A - keep it simple, use an external scheduler** (cron-job.org, a
GitHub Actions scheduled workflow, or anything else that can fire an HTTP
request on a timer):

```
curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/escrow/internal/flag-overdue-tranches \
  -H "x-cron-secret: <the CRON_SECRET you set above>"
```

Run it on whatever cadence the Render job used (check its old schedule in
the Render dashboard before you delete that service).

**Option B - do it inside Supabase**, using the `pg_cron` + `pg_net`
extensions (Database → Extensions in the Supabase dashboard) to schedule
that same HTTP POST directly from Postgres, with no external service
needed at all. This keeps everything on Supabase, at the cost of a bit
more setup (enabling both extensions, then a `cron.schedule(...)` call).
Worth doing later once the rest is confirmed working; not required for
initial cutover.

**Do not skip this step** - without it, overdue tranches never get
flagged, which means buyers never get prompted that a timed tranche is
ready to release. Nothing breaks loudly; it just quietly stops happening.

## 4. Test each function before switching the app over

A quick manual check per function - your own access token from a signed-in
session, or pull one from the app's local storage while testing:

```
curl https://YOUR-PROJECT-REF.supabase.co/functions/v1/wallet/balance \
  -H "Authorization: Bearer <your supabase access token>"
```

Repeat for a route on each of the other five functions. Watch each
function's logs in the Supabase dashboard (Edge Functions → [function
name] → Logs) while testing - that's where `console.error` calls from a
failed request show up.

## 5. Cutover plan - don't delete Render yet

Keep the Render service running and deployed exactly as it is until you've
confirmed the Edge Functions work end to end through the actual app (not
just curl) - create a deal, fund it, release a tranche, request a
withdrawal, check the admin dashboard. The Flutter app change already
points everything at Supabase, so Render will just sit there idle and
unused once that's live; it costs nothing extra to leave it running for a
few days as a safety net.

Once you're confident: cancel the Render service, and optionally delete
`src/` from `horizon-backend-fresh` (or just leave it - it does nothing
once nothing points at it, same as the Firebase leftovers from the earlier
migration).

## 6. Manual QA checklist (in addition to the Task #28-30 checklist already sent)

- [ ] Create a deal, fund it via Paystack, confirm the webhook lands
      (check the `webhooks` function's logs, and that the deal shows as
      funded in the app)
- [ ] Release a tranche as the buyer, confirm the seller's wallet credits
- [ ] Request a withdrawal, confirm it appears on the admin withdrawals
      screen, mark it paid, confirm the requester gets notified
- [ ] Trigger a dispute, resolve it as admin (both release and refund
      outcomes)
- [ ] Force-cancel a funded deal with a split decision
- [ ] Confirm a completed trade between a referred user and someone else
      still pays out the referrer (this exercises escrow → referrals
      cross-function logic, the trickiest thing to get right in this
      rewrite)
- [ ] Manually fire the cron endpoint once (per step 3) and confirm a
      genuinely overdue tranche gets `overdue_flagged_at` set
