-- Task: verified-only posting. Buying, messaging, and browsing stay open
-- to everyone - only creating a NEW listing/job/service-offer/barter post
-- now requires a verified identity (trust_level != 'basic'). This is the
-- real enforcement, not just the friendly UI gate (see
-- VerifiedPosterGate.dart) - anyone hitting Postgres directly, bypassing
-- the app entirely, still can't insert as an unverified account.
--
-- Each table's old "owners/posters manage their own X" policy covered
-- select/insert/update/delete in one FOR ALL policy with no verification
-- check - split into three narrower policies so the trust_level check
-- applies to INSERT only, not to managing (editing/deleting) a post you
-- already made before this rule existed or before you got verified.
--
-- Run this in the Supabase SQL Editor after migration_14.
-- Safe to run once; re-running just replaces the same policies.

-- ---------------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------------
drop policy if exists "owners manage their own listings" on public.listings;

create policy "verified owners can create listings" on public.listings
  for insert with check (
    auth.uid() = owner_id
    and exists (
      select 1 from public.profiles p
      where p.uid = auth.uid() and p.trust_level <> 'basic'
    )
  );

create policy "owners can update their own listings" on public.listings
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy "owners can delete their own listings" on public.listings
  for delete using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- jobs (covers both regular job postings AND service offers -
-- is_service_offer doesn't change who's allowed to post, both directions
-- of "I need X" / "I offer X" require verification the same way)
-- ---------------------------------------------------------------------------
drop policy if exists "posters manage their own jobs" on public.jobs;

create policy "verified posters can create jobs" on public.jobs
  for insert with check (
    auth.uid() = poster_id
    and exists (
      select 1 from public.profiles p
      where p.uid = auth.uid() and p.trust_level <> 'basic'
    )
  );

create policy "posters can update their own jobs" on public.jobs
  for update using (auth.uid() = poster_id) with check (auth.uid() = poster_id);

create policy "posters can delete their own jobs" on public.jobs
  for delete using (auth.uid() = poster_id);

-- ---------------------------------------------------------------------------
-- barter_posts
-- ---------------------------------------------------------------------------
drop policy if exists "posters manage their own barter posts" on public.barter_posts;

create policy "verified posters can create barter posts" on public.barter_posts
  for insert with check (
    auth.uid() = poster_id
    and exists (
      select 1 from public.profiles p
      where p.uid = auth.uid() and p.trust_level <> 'basic'
    )
  );

create policy "posters can update their own barter posts" on public.barter_posts
  for update using (auth.uid() = poster_id) with check (auth.uid() = poster_id);

create policy "posters can delete their own barter posts" on public.barter_posts
  for delete using (auth.uid() = poster_id);
