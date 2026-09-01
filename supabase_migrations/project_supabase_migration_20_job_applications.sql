-- Task: job applications. Until now there was no way for a job poster to
-- pick WHO they're hiring - job_detail_screen's "Pay with Escrow" button
-- let ANY viewer become the escrow buyer paying the poster, which only
-- actually makes sense for a service offer (a client booking a skillsman
-- who's advertising themselves). For a regular "I need a plumber" job post,
-- that direction is backwards (the plumber viewing it would end up paying
-- the client) - and the poster, who SHOULD be the one paying, couldn't act
-- on their own post at all. This adds the missing middle step: multiple
-- people apply, the poster reviews and accepts one, and accepting is what
-- lets the poster open an escrow deal with that specific applicant as the
-- seller (poster becomes the buyer - the existing CustomDealScreen already
-- supports this, no escrow changes needed, just a new caller).
--
-- Only applies to regular job postings (is_service_offer = false) -
-- service offers keep working exactly as before (book & pay directly).
--
-- Run this in the Supabase SQL Editor after migration_19.

alter table public.jobs add column if not exists filled boolean not null default false;

create table if not exists public.job_applications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  applicant_id uuid not null references public.profiles(uid),
  applicant_name text not null default 'Unknown',
  applicant_trust_level text not null default 'basic',
  cover_note text not null default '',
  proposed_rate text,
  status text not null default 'pending'
    check (status in ('pending', 'shortlisted', 'accepted', 'rejected', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, applicant_id)
);
create index if not exists job_applications_job_idx on public.job_applications (job_id, status);
create index if not exists job_applications_applicant_idx on public.job_applications (applicant_id, status);

alter table public.job_applications enable row level security;

drop policy if exists "applicant or poster or admin can read applications" on public.job_applications;
create policy "applicant or poster or admin can read applications" on public.job_applications
  for select using (
    applicant_id = auth.uid()
    or exists (select 1 from public.jobs j where j.id = job_id and j.poster_id = auth.uid())
    or exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

-- Deliberately no insert/update policy - every write goes through one of
-- the three security-definer functions below, called from the jobs Edge
-- Function with the caller's verified uid passed explicitly as a
-- parameter (not read via auth.uid(), since the Edge Function calls
-- through the service-role client - same reasoning as wallet_adjust's
-- p_uid parameter). Keeps validation, the "accepting one auto-rejects the
-- rest" side effect, and the job.filled flip all in one atomic place
-- instead of racy client-side logic.

create or replace function public.apply_to_job(
  p_job_id uuid,
  p_applicant_id uuid,
  p_applicant_name text,
  p_applicant_trust_level text,
  p_cover_note text,
  p_proposed_rate text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job record;
  v_existing_status text;
  v_app_id uuid;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then
    raise exception 'Job not found';
  end if;
  if v_job.poster_id = p_applicant_id then
    raise exception 'You can not apply to your own job';
  end if;
  if v_job.is_service_offer then
    raise exception 'Service offers do not accept applications - message the provider directly';
  end if;
  if v_job.filled then
    raise exception 'This job has already been filled';
  end if;

  select status into v_existing_status
  from public.job_applications
  where job_id = p_job_id and applicant_id = p_applicant_id;

  if v_existing_status in ('pending', 'shortlisted', 'accepted') then
    raise exception 'You already applied to this job';
  end if;

  if v_existing_status is not null then
    update public.job_applications
    set cover_note = p_cover_note,
        proposed_rate = p_proposed_rate,
        status = 'pending',
        applicant_name = p_applicant_name,
        applicant_trust_level = p_applicant_trust_level,
        created_at = now(),
        updated_at = now()
    where job_id = p_job_id and applicant_id = p_applicant_id
    returning id into v_app_id;
  else
    insert into public.job_applications
      (job_id, applicant_id, applicant_name, applicant_trust_level, cover_note, proposed_rate, status)
    values
      (p_job_id, p_applicant_id, p_applicant_name, p_applicant_trust_level, p_cover_note, p_proposed_rate, 'pending')
    returning id into v_app_id;
  end if;

  return v_app_id;
end;
$$;

create or replace function public.withdraw_job_application(
  p_application_id uuid,
  p_applicant_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_owner uuid;
begin
  select status, applicant_id into v_status, v_owner
  from public.job_applications where id = p_application_id for update;

  if not found then
    raise exception 'Application not found';
  end if;
  if v_owner <> p_applicant_id then
    raise exception 'Not your application';
  end if;
  if v_status not in ('pending', 'shortlisted') then
    raise exception 'This application can not be withdrawn';
  end if;

  update public.job_applications set status = 'withdrawn', updated_at = now() where id = p_application_id;
end;
$$;

-- Only callable by the job's poster. 'accepted' also marks the job filled
-- and auto-rejects every other still-open application for it, returning
-- who got auto-rejected (as jsonb) so the Edge Function can notify them in
-- the same request instead of a second round trip.
create or replace function public.decide_job_application(
  p_application_id uuid,
  p_poster_id uuid,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_job_title text;
  v_applicant_id uuid;
  v_auto_rejected jsonb;
begin
  if p_status not in ('shortlisted', 'accepted', 'rejected') then
    raise exception 'Invalid status "%"', p_status;
  end if;

  select ja.job_id, ja.applicant_id, j.title
    into v_job_id, v_applicant_id, v_job_title
  from public.job_applications ja
  join public.jobs j on j.id = ja.job_id
  where ja.id = p_application_id and j.poster_id = p_poster_id
  for update of ja;

  if not found then
    raise exception 'Application not found, or this is not your job posting';
  end if;

  v_auto_rejected := '[]'::jsonb;

  if p_status = 'accepted' then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'applicantId', applicant_id)), '[]'::jsonb)
      into v_auto_rejected
    from public.job_applications
    where job_id = v_job_id and id <> p_application_id and status in ('pending', 'shortlisted');

    update public.job_applications
    set status = 'rejected', updated_at = now()
    where job_id = v_job_id and id <> p_application_id and status in ('pending', 'shortlisted');

    update public.jobs set filled = true where id = v_job_id;
  end if;

  update public.job_applications
  set status = p_status, updated_at = now()
  where id = p_application_id;

  return jsonb_build_object(
    'jobId', v_job_id,
    'jobTitle', v_job_title,
    'applicantId', v_applicant_id,
    'autoRejected', v_auto_rejected
  );
end;
$$;
