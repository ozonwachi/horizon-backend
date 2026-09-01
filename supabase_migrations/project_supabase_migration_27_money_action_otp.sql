-- Task: security hardening, part 2 - email OTP step-up for money actions.
--
-- Run this in the Supabase SQL Editor after migration_26.
-- Safe to run once; re-running is guarded everywhere it matters.
--
-- Design: a short-lived, single-use 6-digit code emailed to the user before
-- a sensitive money action (currently: withdrawal requests) is allowed to
-- go through. Only the SHA-256 hash of the code is ever stored - see
-- otpService.ts, which is the only thing that reads/writes this table
-- (always via the service-role client, same as rate_limit_counters and
-- audit_logs - no end-user RLS policy is needed or added).
create table if not exists public.money_action_otps (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references public.profiles(uid) on delete cascade,
  action text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- otpService.verifyOtp looks up "the newest unconsumed code for this
-- uid+action", so a (uid, action, created_at) index covers that lookup
-- directly instead of a full table scan.
create index if not exists money_action_otps_uid_action_idx
  on public.money_action_otps (uid, action, created_at desc);

-- Old rows (expired, consumed, or abandoned) have no reason to accumulate
-- forever - this is a manual cleanup helper an admin/cron can call
-- periodically; nothing in the app calls it automatically, so it's
-- optional and safe to ignore.
create or replace function public.purge_old_money_action_otps() returns void
language sql as $$
  delete from public.money_action_otps where created_at < now() - interval '7 days';
$$;
