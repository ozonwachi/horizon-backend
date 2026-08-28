-- Task: amount-based commission tiers. Lets an admin charge a different
-- commission rate depending on how large a deal is (e.g. 1% for deals
-- 1,000-10,000 kobo, 2% for deals 10,001-100,000 kobo), on top of the
-- existing per-type/category commission_rules override and the
-- platform-wide default in platform_settings.
--
-- Additive and fully backward compatible: when no tiers are defined for a
-- (type, category) pair, calculateCommission() in escrowService.ts falls
-- straight through to commission_rules, then platform_settings, exactly as
-- it did before this migration - every deal type that never gets tiers
-- configured behaves identically to today.
--
-- Design choices (per product decision):
--   - Tiers are scoped per (type, category), matching commission_rules -
--     each deal type can have its own independent ladder of ranges.
--   - An amount outside every defined range extends to the NEAREST tier
--     (the lowest tier for amounts below its minimum, the highest tier for
--     amounts above its maximum or falling in a gap between tiers) rather
--     than falling back to the platform default - so once any tier exists
--     for a type, every deal of that type is covered by it.

create table public.commission_tiers (
  id uuid primary key default gen_random_uuid(),
  type text not null,        -- 'listing' | 'job' | 'barter' | 'custom'
  category text,             -- null = applies to every category of this type
  min_amount_kobo bigint not null,
  max_amount_kobo bigint,    -- null = open-ended (no upper bound on this tier)
  mode text not null check (mode in ('flat', 'percentage')),
  value numeric not null,    -- kobo if flat, 0-100 if percentage
  created_at timestamptz not null default now(),
  constraint commission_tiers_range_check check (max_amount_kobo is null or max_amount_kobo >= min_amount_kobo)
);
create index commission_tiers_type_category_idx
  on public.commission_tiers (type, coalesce(category, ''), min_amount_kobo);

alter table public.commission_tiers enable row level security;

-- Same shape as commission_rules/platform_settings: publicly readable (so
-- the app could show "you'll pay X% commission" before a deal is created),
-- writable only through the admin Edge Function's service-role client - no
-- insert/update/delete policy needed for that, same as those two tables.
create policy "commission tiers are readable" on public.commission_tiers for select using (true);
