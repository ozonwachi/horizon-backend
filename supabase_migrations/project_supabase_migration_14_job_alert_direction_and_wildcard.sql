-- Task: two refinements to the job/nearby-opportunity notification built in
-- migration_13, both from the same follow-up discussion:
--
-- 1. Direction matters. jobs.is_service_offer already distinguishes a
--    CLIENT looking for a skillsman (false - "I need a plumber") from a
--    SKILLSMAN advertising themselves (true - "I'm a plumber, book me").
--    Only the former should ping matching skillsmen nearby - pinging other
--    plumbers about a competitor's service ad is noise, not a job lead.
--    Enforced in the `jobs` edge function (see notify-matches route) -
--    this migration's part is just the wildcard change below, which
--    applies to whichever jobs the function still calls it for.
--
-- 2. "Job Seeker" is a generalist tag, not a trade - someone who tagged
--    themselves that way (rather than/alongside a specific skill) is
--    saying "I'll take any nearby work", not "notify me only about jobs
--    that literally say 'job seeker'". So it's now a wildcard: matches
--    every nearby job post within radius, regardless of category. This is
--    what makes the same matching mechanism cover generalist/office-type
--    work, not just named trades.
--
-- Run this in the Supabase SQL Editor after migration_13.
-- Safe to run once; re-running just replaces the function definition.

create or replace function public.match_job_notification_candidates(
  p_poster_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_title text,
  p_category text,
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
    and public.km_distance(p.notify_lat, p.notify_lng, p_lat, p_lng) <= p_radius_km;
$$;
