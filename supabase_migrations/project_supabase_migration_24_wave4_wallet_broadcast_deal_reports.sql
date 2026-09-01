-- Task: Wave 4 build-out - admin wallet credit, off-platform-deal reports
-- (with a reward payout), and the schema half of commission negotiation.
-- Broadcast notifications and email don't need any schema changes - they
-- reuse the existing notifications/profiles tables - so this migration is
-- just the two new wallet_transactions.type values and one new table.
--
-- Run this in the Supabase SQL Editor after migration_23.
-- Safe to run once; re-running is guarded everywhere it matters.

-- ---------------------------------------------------------------------------
-- 1. Widen wallet_transactions.type for the two new ledger entry kinds -
--    see walletLedgerService.ts's TYPES.ADMIN_CREDIT / OFF_PLATFORM_REWARD.
-- ---------------------------------------------------------------------------
alter table public.wallet_transactions drop constraint if exists wallet_transactions_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_type_check
  check (type in (
    'escrow_release', 'escrow_refund', 'escrow_payment', 'deposit',
    'withdrawal', 'withdrawal_rejected', 'admin_force_cancel',
    'referral_payout', 'referral_payout_debit', 'connection_fee',
    'admin_credit', 'off_platform_reward'
  ));

-- ---------------------------------------------------------------------------
-- 2. "Report a finished deal" - the wallet screen's new feature under the
--    connection-fee button, for a buyer/client to flag a seller who
--    completed a deal off-platform to dodge the connection fee. This is
--    NOT the same as `reports` (migration_08) - that table snapshots a
--    real listing/job/barter/user by id and owner uid; a seller reported
--    here is identified only by whatever username/phone the reporter
--    typed, since the whole point is they dodged paying, not that they
--    have some post/account on record for this deal. No debit, no
--    transaction effect - purely a lead for admin review. reward_kobo is
--    set by an admin only once/if they decide to pay out (20% of whatever
--    commission was actually recovered, per the original request - a
--    judgment call, not an automatic calculation, since "recovered" isn't
--    something the system can determine on its own).
-- ---------------------------------------------------------------------------
create table if not exists public.off_platform_deal_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_uid uuid not null references public.profiles(uid),
  reporter_name text not null default '',
  seller_username text not null default '',
  seller_phone text not null default '',
  deal_description text not null,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  reward_kobo integer,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(uid)
);

alter table public.off_platform_deal_reports enable row level security;

drop policy if exists "users file their own off-platform deal reports" on public.off_platform_deal_reports;
create policy "users file their own off-platform deal reports"
  on public.off_platform_deal_reports for insert
  with check (auth.uid() = reporter_uid);

-- No select/update policy for regular users, same as `reports` - filing is
-- one-way from the client; review happens through the admin Edge Function
-- (service-role, bypasses RLS) only.

create index if not exists off_platform_deal_reports_status_idx
  on public.off_platform_deal_reports (status, created_at desc);
