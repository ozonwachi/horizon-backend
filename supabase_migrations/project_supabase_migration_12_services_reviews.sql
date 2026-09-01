-- Task: Services (skilled people listing what they do, including
-- logistics/delivery providers) + reviews & ratings.
--
-- Run this in the Supabase SQL Editor after migration_11.
-- Safe to run once; re-running is guarded everywhere it matters.

-- ----------------------------------------------------------------------------
-- Services: jobs.is_service_offer
-- ----------------------------------------------------------------------------
-- A "service offer" is stored in the same `jobs` table as a regular job
-- opening - same fields (title/description/skillTags/category/payRate/
-- location), same detail screen, same "Message" + "Pay with Escrow" flow
-- (a custom deal the skillsman edits with agreed terms, then the buyer
-- locks funds in escrow). The only thing that differs is who's asking: a
-- job opening is "I need this done" (posterId is the person who needs
-- work), a service offer is "I do this - book me" (posterId is the
-- skillsman who gets paid). This flag is purely presentational/for
-- filtering (the Services browse screen, a badge on the detail screen) -
-- it doesn't change any escrow/payment logic, which already always pays
-- job.posterId either way.
alter table public.jobs
  add column if not exists is_service_offer boolean not null default false;
create index if not exists jobs_is_service_offer_idx
  on public.jobs (is_service_offer, created_at desc) where is_service_offer;

-- 'Logistics' is a new category value alongside the existing fixed list
-- (Electronics/Vehicles/Property/Jobs/Services) - category is free text on
-- every post table, so no constraint change is needed here; the app just
-- adds it to CategorySelector.fixedCategories so it's spelled consistently
-- and the logistics warning banner (shown on any listing/job/barter whose
-- category is 'Logistics') fires reliably.

-- ----------------------------------------------------------------------------
-- Reviews & ratings
-- ----------------------------------------------------------------------------
-- One review per (author, target) pair - re-submitting an existing review
-- EDITS it in place (see the app's ReviewService.submitReview, which upserts
-- on this same unique constraint) rather than creating a second row. This is
-- what makes "the reviewer can edit their review if the seller clears up a
-- misunderstanding" work: there's only ever one row to edit, no separate
-- delete+repost dance.
--
-- rating is 1-5 stars. The app computes a reputation PERCENTAGE from these,
-- not stored here: reviews rated 4-5 count as "good", 1-2 as "bad", 3 is
-- neutral (counted in the average but not in the good/bad ratio) - see
-- ReviewService.summaryForUser's doc comment for the exact formula.
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  target_uid uuid not null references public.profiles(uid),
  author_uid uuid not null references public.profiles(uid),
  author_name text not null default '',
  rating int not null check (rating between 1 and 5),
  comment text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reviews_no_self_review check (author_uid <> target_uid),
  constraint reviews_one_per_author_target unique (author_uid, target_uid)
);
create index reviews_target_idx on public.reviews (target_uid, created_at desc);

alter table public.reviews enable row level security;

-- Reviews are meant to be seen by anyone who taps a profile - public read
-- for any signed-in user (this app has no genuinely anonymous/signed-out
-- browsing mode, so `to authenticated` covers every real reader).
create policy "signed-in users can read all reviews" on public.reviews
  for select to authenticated using (true);

-- Gated on having actually done business together: you can only review
-- someone you've completed (or partially completed) an escrow deal with,
-- as either the buyer or the seller. This is enforced here in RLS, not just
-- in the app, so it can't be bypassed by calling the insert directly.
create policy "users can review people they've completed a deal with"
  on public.reviews
  for insert
  with check (
    auth.uid() = author_uid
    and author_uid <> target_uid
    and exists (
      select 1 from public.escrow_agreements ea
      where ea.status in ('released', 'partially_released')
        and (
          (ea.buyer_id = auth.uid() and ea.seller_id = target_uid)
          or (ea.seller_id = auth.uid() and ea.buyer_id = target_uid)
        )
    )
  );

-- Editing (the explicitly requested "clear up a misunderstanding" flow) is
-- just "the author changes their own existing row" - no need to re-check
-- the deal still exists, it existed at insert time and escrow agreements
-- aren't deleted afterward.
create policy "authors can edit their own review" on public.reviews
  for update
  using (auth.uid() = author_uid)
  with check (auth.uid() = author_uid);

-- Deliberately no delete policy for regular users - editing is the
-- requested capability, not removal. An admin could still remove a review
-- later via the service-role client if genuinely needed (e.g. abuse), same
-- as every other admin-only action in this app.
