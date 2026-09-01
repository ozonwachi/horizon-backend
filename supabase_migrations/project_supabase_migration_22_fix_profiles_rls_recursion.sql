-- Bug fix: "infinite recursion detected in policy for relation profiles"
-- (Postgres error 42P17) on ANY read from public.profiles, including a
-- user reading their own row - reported as Profile screen (and other
-- screens that load a profile) hanging/erroring.
--
-- Root cause: migration_16_hide_contact_details.sql's SELECT policy on
-- public.profiles has, as part of its own USING clause, a subquery that
-- selects from public.profiles again:
--
--   create policy "users can read their own profile, admins can read any"
--     on public.profiles for select using (
--       auth.uid() = uid
--       or exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
--     );
--
-- Evaluating this policy requires evaluating the same policy again for the
-- inner subquery's scan of profiles, which requires evaluating it again,
-- forever - Postgres detects the cycle and raises 42P17 instead of
-- hanging. This isn't limited to the profiles screen either: every other
-- admin-gated policy added in migrations 17-21 (categories, regions,
-- ban_evasion_flags, connection fee/contact flags, job applications,
-- barter offers) checks admin status the same way, via a subquery against
-- profiles - each of those hits this same recursive profiles policy
-- underneath, so this single fix resolves all of them, not just profiles
-- itself.
--
-- Fix: move the admin check into a SECURITY DEFINER function. A function
-- like this runs as its owner, which - same as profiles_public and
-- search_profile_by_phone below it in migration_16 - bypasses row-level
-- security entirely for its own internal query (this schema never sets
-- FORCE ROW LEVEL SECURITY, so table owners/security-definer functions
-- are exempt from the RLS they'd otherwise be subject to). That breaks the
-- cycle: checking is_admin_user() from inside profiles' own policy no
-- longer re-triggers that same policy.
--
-- Run this in the Supabase SQL Editor after migration_21. Safe to run more
-- than once - CREATE OR REPLACE / DROP POLICY IF EXISTS throughout.

create or replace function public.is_admin_user(check_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_admin from public.profiles where uid = check_uid),
    false
  );
$$;

grant execute on function public.is_admin_user(uuid) to authenticated, anon;

drop policy if exists "users can read their own profile, admins can read any" on public.profiles;

create policy "users can read their own profile, admins can read any" on public.profiles
  for select using (
    auth.uid() = uid
    or public.is_admin_user(auth.uid())
  );
