-- ============================================================================
-- Project Horizon — schema additions needed by Task #27
-- (Flutter data layer migration off cloud_firestore). Run this in the
-- Supabase SQL Editor after project_supabase_schema.sql. Safe to run once.
--
-- Everything else Task #27 needs (listings/jobs/barter_posts, profiles,
-- conversations/messages, notifications, favorites) already exists in
-- project_supabase_schema.sql - this file only adds what wasn't designed
-- yet at that point: interest tracking (the personalized nearby-feed
-- signal, item 7 in the feature registry).
-- ============================================================================

-- Mirrors Firestore's userInterests collection (doc ID `{uid}_{category}`,
-- a running `weight` bumped by +1/+3/-3 depending on the signal). One row
-- per user per normalized category, upserted with an atomic increment via
-- interest_bump() below instead of Firestore's FieldValue.increment.
create table public.user_interests (
  uid uuid not null references public.profiles(uid) on delete cascade,
  category text not null default '',
  category_normalized text not null,
  weight int not null default 0,
  last_interacted_at timestamptz not null default now(),
  primary key (uid, category_normalized)
);
create index user_interests_uid_weight_idx on public.user_interests (uid, weight desc);

alter table public.user_interests enable row level security;
create policy "users manage their own interest signals" on public.user_interests
  for all using (auth.uid() = uid) with check (auth.uid() = uid);

-- Atomic upsert-with-increment - the Postgres equivalent of Firestore's
-- `set({weight: FieldValue.increment(weight)}, {merge: true})`. Called
-- directly by the Flutter app (via the anon key, protected by the RLS
-- policy above), so it has to be safe to call as any authenticated user
-- for their own uid only - callers pass their own auth.uid() as p_uid and
-- the RLS-equivalent check below rejects anything else.
create or replace function public.interest_bump(
  p_uid uuid,
  p_category text,
  p_weight int
) returns void
language plpgsql
security invoker
as $$
begin
  if p_uid != auth.uid() then
    raise exception 'Cannot record interest for another user';
  end if;

  insert into public.user_interests (uid, category, category_normalized, weight, last_interacted_at)
  values (p_uid, p_category, lower(trim(p_category)), p_weight, now())
  on conflict (uid, category_normalized) do update
    set weight = public.user_interests.weight + excluded.weight,
        category = excluded.category,
        last_interacted_at = now();
end;
$$;
