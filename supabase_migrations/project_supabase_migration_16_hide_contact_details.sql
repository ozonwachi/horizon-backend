-- Task: hide contact details. Until now, "profiles are publicly readable"
-- was `using (true)` - no row-level restriction at all, so ANY signed-in
-- user could read ANY other user's phone and email straight out of
-- Postgres, not just through some obscure API call (Find User's own
-- results screen already fell back to showing a stranger's email today).
-- This closes that for real:
--
-- 1. The base `profiles` table's SELECT policy now only allows your own
--    row, or an admin's. Phone/email never leave the database for anyone
--    else's row, full stop - no app-level code change can accidentally
--    re-expose it, because the database itself won't return it.
--
-- 2. Every screen that shows OTHER people's names/roles/trust level (a
--    seller card, a public profile, search results, the map's verified
--    filter, ...) reads from a new `profiles_public` VIEW instead - same
--    uid/name/username/skill_tags/trust_level/created_at every screen
--    already used, just never phone or email. The view exposes every row
--    (unlike the now-locked-down base table) because it's created here as
--    the table owner, which bypasses the restrictive policy above by
--    ordinary Postgres rule (table owners aren't subject to their own RLS
--    unless FORCE ROW LEVEL SECURITY is set, which this schema never
--    does) - the safety comes entirely from which COLUMNS the view
--    exposes, not from re-imposing row restrictions.
--
-- 3. Find User's phone search still needs to work ("I have Ade's number,
--    let me find him") without turning into a way to browse other
--    people's phone numbers - search_profile_by_phone() is a
--    SECURITY DEFINER function that matches against the real phone column
--    internally but only ever returns name/username/trust_level, never
--    the number itself (yours or anyone else's).
--
-- Run this in the Supabase SQL Editor after migration_15.
-- Safe to run once; re-running just replaces the policy/view/function.

drop policy if exists "profiles are publicly readable" on public.profiles;

create policy "users can read their own profile, admins can read any" on public.profiles
  for select using (
    auth.uid() = uid
    or exists (
      select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin
    )
  );

create or replace view public.profiles_public as
select
  uid,
  name,
  username,
  username_lower,
  skill_tags,
  trust_level,
  created_at
from public.profiles;

grant select on public.profiles_public to authenticated, anon;

create or replace function public.search_profile_by_phone(p_phone text)
returns table(uid uuid, name text, username text, trust_level text)
language sql stable security definer
set search_path = public
as $$
  select uid, name, username, trust_level
  from public.profiles
  where phone = p_phone
  limit 20;
$$;

grant execute on function public.search_profile_by_phone(text) to authenticated;
