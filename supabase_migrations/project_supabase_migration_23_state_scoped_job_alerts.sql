-- Task: "jobs notification to skillsman should only be within same state
-- and not outside that state, a person in abuja should not see a job in
-- lagos unless they change location to lagos." migration_13/14 scoped job
-- alerts to a fixed 30km radius from the candidate's notify_lat/notify_lng
-- - usually enough to keep Abuja/Lagos apart, but not a real guarantee (and
-- not what was actually asked for: a hard state boundary, not a distance).
--
-- Adds a state/province column to profiles (mirrors notify_country_code,
-- see migration_13) and to jobs (mirrors jobs.country_code), both populated
-- client-side via geocoding's administrativeArea - same pattern as the
-- existing country-code columns. match_job_notification_candidates() then
-- requires an exact state match whenever BOTH sides have one, and only
-- falls back to the old radius check when either side's state is unknown
-- (older rows predating this column, or reverse geocoding didn't resolve
-- one) - so alerts degrade gracefully instead of silently going out to
-- nobody.
--
-- Run this in the Supabase SQL Editor after migration_22.
-- Safe to run once; re-running is guarded everywhere it matters.

alter table public.profiles add column if not exists notify_state text;
alter table public.jobs add column if not exists state text;

create or replace function public.match_job_notification_candidates(
  p_poster_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_title text,
  p_category text,
  p_state text default null,
  p_radius_km double precision default 30
) returns table(uid uuid)
language sql stable as $$
  select p.uid
  from public.profiles p
  where p.uid <> p_poster_id
    and p.job_alerts_enabled = true
    and p.notify_lat is not null
    and p.notify_lng is not null
    and cardinality(p.skill_tags) > 0
    and (
      exists (
        select 1 from unnest(p.skill_tags) as tag
        where lower(btrim(tag)) = 'job seeker'
      )
      or exists (
        select 1 from unnest(p.skill_tags) as tag
        where length(btrim(tag)) > 0
          and lower(btrim(tag)) <> 'job seeker'
          and (
            lower(coalesce(p_title, '')) like '%' || lower(btrim(tag)) || '%'
            or lower(coalesce(p_category, '')) like '%' || lower(btrim(tag)) || '%'
          )
      )
    )
    and (
      (
        p_state is not null and length(btrim(p_state)) > 0
        and p.notify_state is not null and length(btrim(p.notify_state)) > 0
        and lower(btrim(p.notify_state)) = lower(btrim(p_state))
      )
      or (
        (p_state is null or length(btrim(p_state)) = 0
         or p.notify_state is null or length(btrim(p.notify_state)) = 0)
        and public.km_distance(p.notify_lat, p.notify_lng, p_lat, p_lng) <= p_radius_km
      )
    );
$$;
