# Multi-currency roadmap (deferred - not being built now)

Recorded per your request: "the whole platform is based off of naira... I
want room for other countries as its supposed to be worldwide at full
service time... we will work on it but I want it added to memory and
anything created now should have room for it."

This is a note for the future, not a task in progress. Nothing here changes
current behavior - the platform is single-currency (NGN) today and stays
that way until this is picked up deliberately.

## Where NGN is baked in today

- Every money column across the schema is suffixed `_kobo` and is a bare
  integer (listings, escrow, wallet, withdrawals, commission_rules,
  commission_tiers, referral_earnings, platform_settings). There's no
  currency column anywhere - NGN/kobo is implicit.
- The Flutter side hardcodes the ₦ symbol and a `/100` naira conversion in
  many places (formatting helpers scattered per-screen rather than
  centralized).
- Paystack (the only payment gateway integrated) is NGN-first; other
  currencies/countries would need either Paystack's multi-currency support
  (where available) or a second gateway integration entirely.
- Commission tiers/rules and referral bonuses are amount-based in kobo, with
  no currency dimension.

## What "leaving room" means going forward (once this is picked up)

Not built now, but the shape to aim for when it is:

1. **Add a `currency` column** (ISO 4217 code, e.g. `'NGN'`, `'USD'`) to
   every table that has a `_kobo` amount, defaulting to `'NGN'` so it's a
   zero-downtime additive migration, not a breaking one.
2. **Keep amounts as integer minor units** (kobo, cents, etc.) - this part
   already generalizes fine, it just needs a currency tag alongside it. No
   need to rename `_kobo` columns; the column name becomes a historical
   detail once `currency` disambiguates it.
3. **Centralize money formatting** in the Flutter app into one helper that
   takes `(minorUnits, currencyCode)` and returns the right symbol/decimal
   convention, instead of the current pattern of each screen hardcoding
   `₦${(kobo / 100).toStringAsFixed(2)}`. That's the main refactor - once
   it exists, adding a currency is mostly "plug into the helper," not
   "find every screen."
4. **Commission tiers/rules and platform_settings** would need a `currency`
   column too (a tier ladder is naturally currency-specific - a ₦1,000
   threshold and a $1,000 threshold aren't the same tier). The existing
   per-type tier design (this session's commission-tiers feature) already
   scopes by (type, category, amount range) - currency would just become
   another dimension in that same key, not a redesign.
5. **Payment gateway per region** - Paystack covers NGN (and a handful of
   other African currencies); a US/EU launch would likely need a second
   gateway (Stripe, etc.) wired in behind the same escrow/wallet flow,
   selected by the user's region/currency rather than replacing Paystack.
6. **Wallets would need a currency each** - realistically a user's wallet
   balance is currency-specific, so multi-currency likely means a wallet
   *per currency* per user, not one wallet with a currency field that can
   change.

## Practical note for anything built between now and then

New tables/features (like the commission_tiers table added this session)
don't need currency support added preemptively - that would be premature
complexity for a single-currency platform. What matters is not making
currency *harder* to add later: keep amounts as plain integer minor units
(no floats), keep amount-scoped logic (tiers, rules) keyed in a way that a
currency column can slot into naturally, and avoid hardcoding "kobo" or "₦"
into shared business logic (the Edge Functions mostly already avoid this -
they just move integers around; it's the Flutter UI layer with scattered
formatting that will need the centralizing helper above).
