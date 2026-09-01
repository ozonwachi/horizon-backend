-- Task: close three gaps flagged in the pre-QA Feature Registry pass -
-- items #66 (verification notifications), #74 (report a user directly),
-- and #63/#64 (job + nearby-opportunity notifications, matched by the
-- reporting user's own skill tags AND a persisted "notification location"
-- rather than live GPS, since matching runs server-side when someone ELSE
-- posts a job - the server can't ask a bystander's device for a GPS fix).
--
-- Run this in the Supabase SQL Editor after migration_12.
-- Safe to run once; re-running is guarded everywhere it matters.

-- ---------------------------------------------------------------------------
-- #74: Report User. reports.target_type only allowed listing/job/barter -
-- widen the check constraint to also allow 'user'. For a user report,
-- target_id and target_owner_uid are both the reported person's uid (they
-- are their own "owner"), same shape the table already required.
-- ---------------------------------------------------------------------------
do $$
declare
  con_name text;
begin
  select conname into con_name
  from pg_constraint
  where conrelid = 'public.reports'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%target_type%';

  if con_name is not null then
    execute format('alter table public.reports drop constraint %I', con_name);
  end if;
end $$;

alter table public.reports
  add constraint reports_target_type_check
  check (target_type in ('listing', 'job', 'barter', 'user'));

-- ---------------------------------------------------------------------------
-- #63/#64: a persisted notification location + an alerts toggle, set at
-- signup and editable any time from the profile screen. Nullable - existing
-- users simply won't match anything (and get nothing extra) until they set
-- one; nothing else in the app reads these columns, so this is fully
-- additive.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists notify_lat double precision;
alter table public.profiles add column if not exists notify_lng double precision;
alter table public.profiles add column if not exists notify_location_label text not null default '';
alter table public.profiles add column if not exists notify_country_code text;
alter table public.profiles add column if not exists job_alerts_enabled boolean not null default true;

-- Great-circle distance in kilometers between two lat/lng points. Plain
-- haversine, no PostGIS extension needed - matching the app's existing
-- practice of doing "nearby" math without PostGIS (see geo_utils.dart's
-- client-side distance sorting).
create or replace function public.km_distance(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable parallel safe as $$
  select 6371 * acos(
    least(1.0, greatest(-1.0,
      cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lng2) - radians(lng1))
      + sin(radians(lat1)) * sin(radians(lat2))
    ))
  );
$$;

-- Who should hear about a newly-posted job: anyone (a) not the poster,
-- (b) with job alerts still on, (c) with a notification location set, and
-- (d) whose OWN skill tags (the roles/trades they listed on their profile -
-- "Plumber", "Mason", ...) show up as a substring of the job's title or
-- category - i.e. only plumbers hear about a job that mentions "plumber",
-- not everyone within range - narrowed further to within p_radius_km of
-- their notification location, not the job's whole country.
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
    and exists (
      select 1 from unnest(p.skill_tags) as tag
      where length(btrim(tag)) > 0
        and (
          lower(coalesce(p_title, '')) like '%' || lower(btrim(tag)) || '%'
          or lower(coalesce(p_category, '')) like '%' || lower(btrim(tag)) || '%'
        )
    )
    and public.km_distance(p.notify_lat, p.notify_lng, p_lat, p_lng) <= p_radius_km;
$$;
