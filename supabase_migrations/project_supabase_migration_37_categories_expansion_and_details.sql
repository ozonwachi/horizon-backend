-- ============================================================================
-- Category expansion + per-category structured details + a stricter
-- trust-level gate for high-value categories (Vehicles/Property).
--
-- Run this in the Supabase SQL Editor after migration_36.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Expand categories. 'Electronics' is deactivated rather than deleted
--    (existing listings already tagged 'Electronics' keep their text as-is
--    - category is a free-text column, not an FK - this only affects what
--    NEW posts can pick), split into 'Phones' and 'Computers & Accessories'.
--    Everything else is a new addition.
-- ----------------------------------------------------------------------------
update public.categories set active = false where name = 'Electronics';

insert into public.categories (name, icon_name, sort_order) values
  ('Phones', 'smartphone', 1),
  ('Computers & Accessories', 'computer', 2),
  ('Fashion', 'checkroom', 7),
  ('Furniture & Home', 'chair', 8),
  ('Beauty & Personal Care', 'spa', 9),
  ('Appliances', 'kitchen', 10),
  ('Other', 'category', 11)
on conflict (name) do update set active = true;

-- ----------------------------------------------------------------------------
-- 2. Flexible per-category structured fields. A jsonb bag rather than a
--    column per category per field - Vehicles gets {make, model, year,
--    mileage, vin}, Property gets {propertyType, bedrooms, bathrooms,
--    sizeSqm, titleDeedNumber}, Phones/Computers/Appliances get {brand,
--    model, condition} (+ storage for Phones, specs for Computers),
--    Fashion gets {size, brand, condition}, Beauty gets {brand,
--    expiryDate} - all just keys in the same column, validated app-side
--    (the Flutter form only shows/requires the fields relevant to the
--    selected category), not by Postgres. Everything else (Services,
--    Logistics, Other, Jobs, Barter with no special fields) just leaves
--    this null.
-- ----------------------------------------------------------------------------
alter table public.listings add column if not exists details jsonb;
alter table public.jobs add column if not exists details jsonb;
alter table public.barter_posts add column if not exists details jsonb;

-- ----------------------------------------------------------------------------
-- 2b. listings never got the denormalized trust-level snapshot jobs/
--     barter_posts already have (poster_trust_level) - OpportunityItem.
--     fromListing has been hardcoding 'basic' for every listing regardless
--     of the actual seller's trust level, which silently defeats any
--     trust-based ranking/display for listings specifically. Same pattern
--     as poster_trust_level: captured client-side at post time from the
--     poster's own known profile, informational only - the real posting
--     gate above is still enforced via a fresh subquery against
--     profiles.trust_level, not this column.
-- ----------------------------------------------------------------------------
alter table public.listings add column if not exists owner_trust_level text not null default 'basic';

-- ----------------------------------------------------------------------------
-- 3. Stricter posting gate for Vehicles/Property: trusted_business, not
--    just "not basic" - matches the "highest-value categories need the
--    highest trust tier" intent. Every other category keeps the existing
--    migration_15 baseline (trust_level <> 'basic'). Only listings carries
--    these two categories in practice (jobs/barter_posts don't offer
--    Vehicles/Property as a category in the app), so only that table's
--    policy needs the extra branch.
-- ----------------------------------------------------------------------------
drop policy if exists "verified owners can create listings" on public.listings;
create policy "verified owners can create listings" on public.listings
  for insert with check (
    auth.uid() = owner_id
    and exists (
      select 1 from public.profiles p
      where p.uid = auth.uid()
        and (
          (category not in ('Vehicles', 'Property') and p.trust_level <> 'basic')
          or (category in ('Vehicles', 'Property') and p.trust_level = 'trusted_business')
        )
    )
  );
