-- Task: email-code login as a second factor, independent of (and
-- combinable with) the existing TOTP-based 2FA - a user can turn on
-- either, both, or neither.
--
-- Just one column - the actual code generation/verification reuses the
-- money_action_otps table + otpService.ts already built for withdrawal
-- step-up (migration_27), under a new "email_2fa" action. See
-- email2faService.ts and account/index.ts's /email-2fa/* routes, and
-- EmailCodeGate on the Flutter side for how this is enforced at login.
--
-- Run this in the Supabase SQL Editor after migration_33.
-- Safe to run once; re-running is a no-op via `if not exists`.

alter table public.profiles
  add column if not exists email_2fa_enabled boolean not null default false;
