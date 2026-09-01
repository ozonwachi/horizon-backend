-- Task: security hardening, part 1 - rate limiting + platform_settings
-- input validation.
--
-- Run this in the Supabase SQL Editor after migration_25.
-- Safe to run once; re-running is guarded everywhere it matters.

-- ---------------------------------------------------------------------------
-- 1. Rate limiting. Edge Functions are stateless between invocations (a
--    warm instance's in-memory state can't be relied on - Supabase can and
--    does spin up fresh instances), so a durable counter needs to live in
--    Postgres. One row per (key, window); check_and_increment_rate_limit()
--    does the read-check-increment atomically in a single UPDATE...RETURNING
--    (falling back to INSERT for a first hit) so concurrent requests can't
--    race past the limit. See rateLimitService.ts for the caller side.
--
--    This covers every route THIS backend controls (admin actions, wallet
--    operations, escrow creation, broadcasts, ...). It does NOT and CANNOT
--    cover Supabase Auth's own login endpoint (email/password sign-in
--    happens directly against Supabase's GoTrue service, never through one
--    of our Edge Functions) - that's already rate-limited at the Supabase
--    platform level, outside this codebase's reach.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_counters (
  key text primary key,
  count integer not null default 0,
  window_start timestamptz not null default now()
);

create or replace function public.check_and_increment_rate_limit(
  p_key text,
  p_max integer,
  p_window_seconds integer
) returns boolean
language plpgsql as $$
declare
  v_count integer;
begin
  -- Reset-and-claim in one statement when the previous window has expired,
  -- otherwise just increment - either way this is a single atomic
  -- UPDATE...RETURNING per call, so two concurrent requests can't both read
  -- "1 under the limit" and both proceed.
  insert into public.rate_limit_counters (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update set
    count = case
      when public.rate_limit_counters.window_start < now() - make_interval(secs => p_window_seconds)
        then 1
      else public.rate_limit_counters.count + 1
    end,
    window_start = case
      when public.rate_limit_counters.window_start < now() - make_interval(secs => p_window_seconds)
        then now()
      else public.rate_limit_counters.window_start
    end
  returning count into v_count;

  return v_count <= p_max;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. platform_settings input validation - previously no bound at all on
--    admin_commission_value/referral_commission_value/connection_fee_value,
--    so a typo (or a malicious admin-token request bypassing the Flutter
--    UI's own input validation) could set e.g. a 500% commission with
--    nothing in the database stopping it. Conditional checks: the bound
--    only applies when that field's *_type is 'percentage' - a flat kobo
--    amount has no natural upper bound the database can enforce.
-- ---------------------------------------------------------------------------
alter table public.platform_settings drop constraint if exists platform_settings_admin_commission_check;
alter table public.platform_settings add constraint platform_settings_admin_commission_check
  check (admin_commission_type <> 'percentage' or admin_commission_value between 0 and 100);

alter table public.platform_settings drop constraint if exists platform_settings_referral_commission_check;
alter table public.platform_settings add constraint platform_settings_referral_commission_check
  check (referral_commission_type <> 'percentage' or referral_commission_value between 0 and 100);

alter table public.platform_settings drop constraint if exists platform_settings_connection_fee_check;
alter table public.platform_settings add constraint platform_settings_connection_fee_check
  check (connection_fee_type <> 'percentage' or connection_fee_value between 0 and 100);

-- Flat-mode values still can't be negative, regardless of type.
alter table public.platform_settings drop constraint if exists platform_settings_admin_commission_nonneg_check;
alter table public.platform_settings add constraint platform_settings_admin_commission_nonneg_check
  check (admin_commission_value >= 0);

alter table public.platform_settings drop constraint if exists platform_settings_referral_commission_nonneg_check;
alter table public.platform_settings add constraint platform_settings_referral_commission_nonneg_check
  check (referral_commission_value >= 0);

alter table public.platform_settings drop constraint if exists platform_settings_connection_fee_nonneg_check;
alter table public.platform_settings add constraint platform_settings_connection_fee_nonneg_check
  check (connection_fee_value >= 0);

-- Same percentage-mode bound for commission_rules/commission_tiers' `value`
-- column - previously only commission_tiers had a (min <= max) ordering
-- check, nothing bounding a percentage-mode value to a sane range.
alter table public.commission_rules drop constraint if exists commission_rules_value_percentage_check;
alter table public.commission_rules add constraint commission_rules_value_percentage_check
  check (mode <> 'percentage' or value between 0 and 100);

alter table public.commission_tiers drop constraint if exists commission_tiers_value_percentage_check;
alter table public.commission_tiers add constraint commission_tiers_value_percentage_check
  check (mode <> 'percentage' or value between 0 and 100);
