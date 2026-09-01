-- Task: barter counter-offers + (no schema change) admin listing management.
--
-- Counter-offers: barter_detail_screen's existing "Pay with Escrow" button
-- already has the right direction for a barter (whoever ISN'T the poster
-- becomes the buyer, covering any cash top-up to the poster as seller) -
-- unlike job applications, there's no escrow direction bug here. What was
-- missing was a way to actually NEGOTIATE terms (what's being offered, any
-- cash difference) before falling back to plain Message. barter_offers
-- gives each non-poster a single negotiation thread per barter post that
-- both sides can accept / reject / counter, with a short round-by-round
-- history kept on the row itself (a jsonb array) rather than a separate
-- table - simplest thing that still shows "who proposed what, when."
--
-- Admin listing management needs no new table or function here:
-- deleteReportedPost() (reportService.ts, already shipped) deletes a
-- listing/job/barter_post row by type + id via the service-role client,
-- bypassing the "owners manage their own posts" RLS the same way it
-- already does for the report-triggered delete flow. This migration is
-- purely the barter_offers table + functions; see admin/index.ts's new
-- DELETE /admin/listings/:type/:id route for the admin-listings side.
--
-- Run this in the Supabase SQL Editor after migration_20.

create table if not exists public.barter_offers (
  id uuid primary key default gen_random_uuid(),
  barter_post_id uuid not null references public.barter_posts(id) on delete cascade,
  offerer_id uuid not null references public.profiles(uid),
  offerer_name text not null default 'Unknown',
  offerer_trust_level text not null default 'basic',
  offer_text text not null,
  note text not null default '',
  -- 'awaiting_poster'  - offerer just submitted/countered; poster must respond
  -- 'awaiting_offerer' - poster countered; the original offerer must respond
  -- 'accepted' | 'rejected' | 'withdrawn'
  status text not null default 'awaiting_poster'
    check (status in ('awaiting_poster', 'awaiting_offerer', 'accepted', 'rejected', 'withdrawn')),
  round int not null default 1,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (barter_post_id, offerer_id)
);
create index if not exists barter_offers_post_idx on public.barter_offers (barter_post_id, status);
create index if not exists barter_offers_offerer_idx on public.barter_offers (offerer_id, status);

alter table public.barter_offers enable row level security;

drop policy if exists "offerer or poster or admin can read barter offers" on public.barter_offers;
create policy "offerer or poster or admin can read barter offers" on public.barter_offers
  for select using (
    offerer_id = auth.uid()
    or exists (select 1 from public.barter_posts b where b.id = barter_post_id and b.poster_id = auth.uid())
    or exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

-- Deliberately no insert/update policy - same reasoning as job_applications
-- (migration_20): every write goes through the two functions below, called
-- from a new `barter` Edge Function with the caller's verified uid passed
-- explicitly as a parameter, not read via auth.uid().

create or replace function public.submit_barter_offer(
  p_barter_post_id uuid,
  p_offerer_id uuid,
  p_offerer_name text,
  p_offerer_trust_level text,
  p_offer_text text,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poster_id uuid;
  v_existing_id uuid;
  v_existing_status text;
  v_offer_id uuid;
  v_history jsonb;
begin
  select poster_id into v_poster_id from public.barter_posts where id = p_barter_post_id;
  if v_poster_id is null then
    raise exception 'Barter post not found';
  end if;
  if v_poster_id = p_offerer_id then
    raise exception 'You can not make an offer on your own post';
  end if;
  if trim(p_offer_text) = '' then
    raise exception 'Describe what you are offering';
  end if;

  select id, status into v_existing_id, v_existing_status
  from public.barter_offers
  where barter_post_id = p_barter_post_id and offerer_id = p_offerer_id;

  if v_existing_status in ('awaiting_poster', 'awaiting_offerer', 'accepted') then
    raise exception 'You already have an active offer on this post';
  end if;

  v_history := jsonb_build_array(jsonb_build_object(
    'by', 'offerer', 'offerText', p_offer_text, 'note', p_note, 'at', now()
  ));

  if v_existing_id is not null then
    update public.barter_offers
    set offer_text = p_offer_text,
        note = p_note,
        status = 'awaiting_poster',
        round = 1,
        history = v_history,
        offerer_name = p_offerer_name,
        offerer_trust_level = p_offerer_trust_level,
        created_at = now(),
        updated_at = now()
    where id = v_existing_id
    returning id into v_offer_id;
  else
    insert into public.barter_offers
      (barter_post_id, offerer_id, offerer_name, offerer_trust_level, offer_text, note, status, round, history)
    values
      (p_barter_post_id, p_offerer_id, p_offerer_name, p_offerer_trust_level, p_offer_text, p_note, 'awaiting_poster', 1, v_history)
    returning id into v_offer_id;
  end if;

  return v_offer_id;
end;
$$;

-- p_action: 'accept' | 'reject' | 'counter' | 'withdraw'. p_offer_text/
-- p_note are only used (and required) for 'counter'. Returns jsonb the
-- Edge Function uses to notify the other party: barterPostId, postTitle,
-- offererId, posterId, status.
create or replace function public.respond_barter_offer(
  p_offer_id uuid,
  p_responder_id uuid,
  p_action text,
  p_offer_text text default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer record;
  v_post record;
  v_is_poster boolean;
  v_is_offerer boolean;
  v_entry jsonb;
  v_new_status text;
begin
  if p_action not in ('accept', 'reject', 'counter', 'withdraw') then
    raise exception 'Invalid action "%"', p_action;
  end if;

  select * into v_offer from public.barter_offers where id = p_offer_id for update;
  if not found then
    raise exception 'Offer not found';
  end if;

  select * into v_post from public.barter_posts where id = v_offer.barter_post_id;
  if not found then
    raise exception 'Barter post no longer exists';
  end if;

  v_is_poster := (v_post.poster_id = p_responder_id);
  v_is_offerer := (v_offer.offerer_id = p_responder_id);

  if not v_is_poster and not v_is_offerer then
    raise exception 'Not a party to this offer';
  end if;

  if v_offer.status not in ('awaiting_poster', 'awaiting_offerer') then
    raise exception 'This offer is no longer active';
  end if;

  if p_action = 'withdraw' then
    if not v_is_offerer then
      raise exception 'Only the offerer can withdraw';
    end if;
    v_new_status := 'withdrawn';
  else
    -- Whoever's turn it is must be the one responding.
    if v_offer.status = 'awaiting_poster' and not v_is_poster then
      raise exception 'Waiting on the poster to respond';
    end if;
    if v_offer.status = 'awaiting_offerer' and not v_is_offerer then
      raise exception 'Waiting on the other party to respond';
    end if;

    if p_action = 'accept' then
      v_new_status := 'accepted';
    elsif p_action = 'reject' then
      v_new_status := 'rejected';
    else -- counter
      if p_offer_text is null or trim(p_offer_text) = '' then
        raise exception 'Describe the counter-offer';
      end if;
      v_new_status := case when v_is_poster then 'awaiting_offerer' else 'awaiting_poster' end;
    end if;
  end if;

  if p_action = 'counter' then
    v_entry := jsonb_build_object(
      'by', case when v_is_poster then 'poster' else 'offerer' end,
      'offerText', p_offer_text,
      'note', coalesce(p_note, ''),
      'at', now()
    );
    update public.barter_offers
    set status = v_new_status,
        offer_text = p_offer_text,
        note = coalesce(p_note, ''),
        round = round + 1,
        history = history || v_entry,
        updated_at = now()
    where id = p_offer_id;
  else
    update public.barter_offers
    set status = v_new_status, updated_at = now()
    where id = p_offer_id;
  end if;

  return jsonb_build_object(
    'barterPostId', v_offer.barter_post_id,
    'postTitle', v_post.offering || ' for ' || v_post.seeking,
    'offererId', v_offer.offerer_id,
    'posterId', v_post.poster_id,
    'status', v_new_status
  );
end;
$$;
