-- Task: admin platform build-out, part 1 — categories, regions, analytics.
-- Also fixes a real bug found while researching this: wallet_transactions'
-- type check constraint was never widened for 'connection_fee' (added in
-- migration_17's pay_connection_fee()), so every connection-fee payment has
-- been failing its insert since that migration landed. Fixed first, below.

-- ----------------------------------------------------------------------------
-- 0. Critical fix: allow 'connection_fee' as a wallet_transactions.type.
-- ----------------------------------------------------------------------------
alter table public.wallet_transactions drop constraint if exists wallet_transactions_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_type_check
  check (type in (
    'escrow_release', 'escrow_refund', 'escrow_payment', 'deposit',
    'withdrawal', 'withdrawal_rejected', 'admin_force_cancel',
    'referral_payout', 'referral_payout_debit', 'connection_fee'
  ));

-- ----------------------------------------------------------------------------
-- 1. Categories — until now, "Electronics/Vehicles/Property/Jobs/Services/
--    Logistics" was hardcoded in THREE separate places in the Flutter app
--    (category_selector.dart, sell_screen.dart's own dropdown - which was
--    even missing Logistics - and search_screen.dart's filter chips), each
--    a hand-copy of the others. This table becomes the one source of
--    truth; the app falls back to its old hardcoded list if this can't be
--    reached (see CategoryService's doc comment), so nothing breaks if a
--    device is offline the first time it loads.
-- ----------------------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  icon_name text not null default 'category',
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists categories_active_sort_idx on public.categories (active, sort_order);

insert into public.categories (name, icon_name, sort_order) values
  ('Electronics', 'devices', 1),
  ('Vehicles', 'directions_car', 2),
  ('Property', 'home', 3),
  ('Jobs', 'work', 4),
  ('Services', 'build', 5),
  ('Logistics', 'local_shipping', 6)
on conflict (name) do nothing;

alter table public.categories enable row level security;
grant select on public.categories to authenticated, anon;

drop policy if exists "active categories are publicly readable" on public.categories;
create policy "active categories are publicly readable" on public.categories
  for select using (active);

drop policy if exists "admins can read every category" on public.categories;
create policy "admins can read every category" on public.categories
  for select using (
    exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

-- No insert/update/delete policy: category management is admin-only and
-- goes through the `admin` Edge Function's service-role client, which
-- bypasses RLS entirely - matches how commission_rules/platform_settings
-- are managed.

-- ----------------------------------------------------------------------------
-- 2. Supported regions — a genuinely new concept (there was no curated
--    location list anywhere before this; every location field in the app
--    is free-form GPS/geocoding). This is a whitelist of the countries
--    Horizon is officially live in, editable from Admin Platform Settings'
--    sibling screen. An EMPTY table (the default/seed state) means "no
--    restriction anywhere" - notification_location_setup_screen.dart only
--    shows a soft "not fully available in your area yet" notice once an
--    admin has actually added at least one region. This is also the
--    control point item #94 ("lift the country-scoped nearby matching for
--    worldwide use") will eventually hang off of.
-- ----------------------------------------------------------------------------
create table if not exists public.supported_regions (
  id uuid primary key default gen_random_uuid(),
  country_code text not null unique, -- ISO 3166-1 alpha-2, e.g. 'NG'
  country_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.supported_regions enable row level security;
grant select on public.supported_regions to authenticated, anon;

drop policy if exists "active regions are publicly readable" on public.supported_regions;
create policy "active regions are publicly readable" on public.supported_regions
  for select using (active);

drop policy if exists "admins can read every region" on public.supported_regions;
create policy "admins can read every region" on public.supported_regions
  for select using (
    exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

-- ----------------------------------------------------------------------------
-- 3. Platform analytics — the admin dashboard has never shown a single
--    aggregate number (it's a pure navigation hub to filtered list
--    screens). One SQL function computing everything in a single round
--    trip, rather than a dozen separate count()/sum() queries from the
--    Edge Function - cheaper, and keeps "what counts as revenue" defined
--    in one place next to the tables it reads.
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
      'openBanEvasionFlags', (select count(*) from public.ban_evasion_flags where status = 'open')
    )
  );
$$;
