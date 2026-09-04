-- Task: job/nearby-opportunity alerts weren't matching specific trades
-- ("Plumber", "Mason", ...) even when a nearby job genuinely needed one -
-- only the "Job Seeker" wildcard was reliably firing.
--
-- Root cause: match_job_notification_candidates() (migration_13, refined in
-- 14 and 23) has only ever compared a candidate's profile skill_tags
-- against the job's TITLE/CATEGORY TEXT via a substring LIKE - e.g. a
-- "Plumber" tag only matched if the literal word "plumber" happened to
-- appear somewhere in the job's title or category. That's already
-- lower()'d on both sides, so it was never actually a capitalization bug -
-- but PostJobScreen has had its own "Skills needed" tag picker (jobs.
-- skill_tags, same shape as profiles.skill_tags) since job applications
-- were added, and this function has never once looked at it. So unless a
-- poster's title/category happened to literally contain the trade word,
-- nobody with that skill tag was ever going to match, no matter how it was
-- capitalized - which is exactly what looked like an inconsistent,
-- capitalization-shaped bug from the outside.
--
-- Fix: take the job's own skill_tags as a new parameter and match it
-- directly against each candidate's skill_tags - trimmed and
-- lower-cased on both sides, so "MASon" on a profile matches "MasoN" on a
-- job post, and any free-text tag either side ever types works the same
-- way with no fixed list to keep in sync (skill_tags has always been
-- freeform on both profiles and jobs - see ProfileScreen's "Roles & Skills"
-- and PostJobScreen's "Skills needed"). The old title/category substring
-- check is kept, but only as a fallback for a job posted with NO skill
-- tags at all (the field's optional) - so an untagged older/newer job
-- isn't silently excluded from every alert, it just falls back to the
-- looser check it always had.
--
-- Run this in the Supabase SQL Editor after migration_31.
-- Safe to run once; re-running just replaces the function definition.

create or replace function public.match_job_notification_candidates(
  p_poster_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_title text,
  p_category text,
  p_state text default null,
  p_radius_km double precision default 30,
  p_skill_tags text[] default '{}'
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
      -- Wildcard: "Job Seeker" means "notify me about any nearby work",
      -- not a literal trade to match against - see migration_14.
      exists (
        select 1 from unnest(p.skill_tags) as tag
        where lower(btrim(tag)) = 'job seeker'
      )
      or (
        -- Primary match: the job itself was tagged with skills needed -
        -- compare tag-to-tag, not tag-in-title-text.
        cardinality(p_skill_tags) > 0
        and exists (
          select 1
          from unnest(p.skill_tags) as candidate_tag,
               unnest(p_skill_tags) as job_tag
          where length(btrim(candidate_tag)) > 0
            and lower(btrim(candidate_tag)) <> 'job seeker'
            and lower(btrim(candidate_tag)) = lower(btrim(job_tag))
        )
      )
      or (
        -- Fallback: job has no skill tags at all - same substring-in-
        -- title/category behavior this function always had.
        cardinality(p_skill_tags) = 0
        and exists (
          select 1 from unnest(p.skill_tags) as tag
          where length(btrim(tag)) > 0
            and lower(btrim(tag)) <> 'job seeker'
            and (
              lower(coalesce(p_title, '')) like '%' || lower(btrim(tag)) || '%'
              or lower(coalesce(p_category, '')) like '%' || lower(btrim(tag)) || '%'
            )
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
