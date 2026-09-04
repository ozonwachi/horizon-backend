-- Task: this session's second build pass -
--   1. Admin-editable FAQ (was a hardcoded list in help_center_screen.dart)
--   2. Commission negotiation reworked into "commission concerns" - a
--      buyer/seller flags a specific already-funded deal's commission as
--      too high; the deal is NOT paused or discounted (it already charged
--      the standard/tiered rate), admin reviews async and always replies,
--      and MAY issue a wallet refund for the difference at their own
--      judgment - never guaranteed. Replaces the old propose/accept flow
--      entirely (the seller never controlled commission, so having them
--      approve a rate change was the wrong design from the start).
--   3. get_platform_analytics() gains 3 more needsAttention counts so the
--      admin dashboard's red badge covers Deal Integrity Reports,
--      Withdrawals, and Commission Concerns - previously only Reports,
--      Identity Verification, Contact Share Flags, and Ban Evasion had one.
--   4. Migration hygiene: migration_23 added a new-signature overload of
--      match_job_notification_candidates instead of replacing migration_14's
--      version (different parameter list -> CREATE OR REPLACE couldn't
--      catch it), leaving a dead 6-arg version callable. Dropped here.
--
-- Run this in the Supabase SQL Editor after migration_27.
-- Safe to run once; re-running is guarded everywhere it matters.

-- ----------------------------------------------------------------------------
-- 1. FAQ - admin-editable, was static content baked into the Flutter app.
-- ----------------------------------------------------------------------------
create table if not exists public.faqs (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists faqs_sort_idx on public.faqs (sort_order);

alter table public.faqs enable row level security;
grant select on public.faqs to authenticated, anon;

drop policy if exists "faqs are publicly readable" on public.faqs;
create policy "faqs are publicly readable" on public.faqs for select using (true);

-- No insert/update/delete policy: management is admin-only through the
-- `admin` Edge Function's service-role client, same as categories/regions.

-- ----------------------------------------------------------------------------
-- 2. Commission concerns - replaces commission_negotiations entirely.
-- ----------------------------------------------------------------------------
drop table if exists public.commission_negotiations;

create table if not exists public.commission_concerns (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.escrow_agreements(id),
  raised_by_uid uuid not null references public.profiles(uid),
  note text not null,
  status text not null default 'open'
    check (status in ('open', 'replied')),
  admin_reply text,
  refunded_kobo integer check (refunded_kobo is null or refunded_kobo > 0),
  replied_by_uid uuid references public.profiles(uid),
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists commission_concerns_status_idx on public.commission_concerns (status, created_at desc);
create index if not exists commission_concerns_agreement_idx on public.commission_concerns (agreement_id);

alter table public.commission_concerns enable row level security;

-- No client-facing write policies: raising a concern and admin's reply
-- both go through Edge Functions (service-role) - same reasoning as
-- contact_share_flags/off_platform_deal_reports.
drop policy if exists "deal participants can read their own concerns" on public.commission_concerns;
create policy "deal participants can read their own concerns" on public.commission_concerns
  for select using (
    exists (
      select 1 from public.escrow_agreements a
      where a.id = commission_concerns.agreement_id
        and (a.buyer_id = auth.uid() or a.seller_id = auth.uid())
    )
  );

-- ----------------------------------------------------------------------------
-- 3. wallet_transactions gets a new ledger type for a concern refund.
-- ----------------------------------------------------------------------------
alter table public.wallet_transactions drop constraint if exists wallet_transactions_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_type_check
  check (type in (
    'escrow_release', 'escrow_refund', 'escrow_payment', 'deposit',
    'withdrawal', 'withdrawal_rejected', 'admin_force_cancel',
    'referral_payout', 'referral_payout_debit', 'connection_fee',
    'admin_credit', 'off_platform_reward', 'commission_refund'
  ));

-- ----------------------------------------------------------------------------
-- 4. get_platform_analytics(): 3 more needsAttention counts.
-- ----------------------------------------------------------------------------
create or replace function public.get_platform_analytics()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users', jsonb_build_object(
      'total', (select count(*) from public.profiles),
      'verified', (select count(*) from public.profiles where trust_level <> 'basic'),
      'signups7d', (select count(*) from public.profiles where created_at >= now() - interval '7 days'),
      'signups30d', (select count(*) from public.profiles where created_at >= now() - interval '30 days')
    ),
    'posts', jsonb_build_object(
      'listings', (select count(*) from public.listings),
      'jobs', (select count(*) from public.jobs where is_service_offer = false),
      'serviceOffers', (select count(*) from public.jobs where is_service_offer = true),
      'barters', (select count(*) from public.barter_posts)
    ),
    'escrow', jsonb_build_object(
      'totalDeals', (select count(*) from public.escrow_agreements),
      'byStatus', (
        select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
        from (select status, count(*) as n from public.escrow_agreements group by status) s
      ),
      'gmvKobo', (
        select coalesce(sum(amount_kobo), 0) from public.escrow_agreements
        where status in ('funded', 'partially_released', 'released')
      ),
      'commissionKobo', (
        select coalesce(sum(commission_kobo), 0) from public.escrow_agreements
        where status in ('partially_released', 'released')
      )
    ),
    'revenue', jsonb_build_object(
      'connectionFeeKobo', (
        select coalesce(sum(amount_kobo), 0) from public.wallet_transactions
        where type = 'connection_fee' and amount_kobo > 0
      ),
      'referralPayoutsKobo', (
        select coalesce(sum(amount_kobo), 0) from public.wallet_transactions
        where type = 'referral_payout'
      )
    ),
    'needsAttention', jsonb_build_object(
      'openReports', (select count(*) from public.reports where status = 'open'),
      'pendingVerifications', (select count(*) from public.verification_requests where status = 'pending'),
      'openContactShareFlags', (select count(*) from public.contact_share_flags where status = 'open'),
      'openBanEvasionFlags', (select count(*) from public.ban_evasion_flags where status = 'open'),
      'openOffPlatformDealReports', (select count(*) from public.off_platform_deal_reports where status = 'open'),
      'pendingWithdrawals', (select count(*) from public.withdrawal_requests where status = 'pending'),
      'openCommissionConcerns', (select count(*) from public.commission_concerns where status = 'open')
    )
  );
$$;

-- ----------------------------------------------------------------------------
-- 5. Drop the dead 6-arg match_job_notification_candidates overload from
--    migration_14, superseded by migration_23's 7-arg (added p_state)
--    version - CREATE OR REPLACE never caught this since the signatures
--    differ, so both were callable until now.
-- ----------------------------------------------------------------------------
drop function if exists public.match_job_notification_candidates(
  uuid, double precision, double precision, text, text, double precision
);
