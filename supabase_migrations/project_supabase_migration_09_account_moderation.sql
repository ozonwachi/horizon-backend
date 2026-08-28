-- Task: admin account moderation - ban, freeze, put a user "under
-- investigation" (blocks money movement only, login still works), and a
-- safe "delete account" that deactivates rather than erasing data (so a
-- wallet balance or an open escrow deal never gets orphaned). All four are
-- reversible via a single "release" action back to 'active'.
--
-- Enforcement lives in two places on the backend (see auth.ts /
-- moderationService.ts):
--   * banned / frozen / deactivated -> requireAuth rejects every request
--     outright (403), AND the Supabase Auth admin API bans the login
--     itself, so even an already-issued access token stops working once it
--     next refreshes.
--   * investigating -> requireAuth lets normal requests through (browsing,
--     messaging, posting), but a new requireActiveAccount middleware
--     rejects specifically the money-moving routes (fund/release/withdraw).
alter table public.profiles
  add column account_status text not null default 'active'
    check (account_status in ('active', 'banned', 'frozen', 'investigating', 'deactivated')),
  add column status_reason text not null default '',
  add column status_changed_by uuid references public.profiles(uid),
  add column status_changed_at timestamptz;

create index profiles_account_status_idx on public.profiles (account_status) where account_status <> 'active';
