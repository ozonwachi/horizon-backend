-- Task: ban-evasion detection. A banned user can already just sign up
-- again with a new email - Supabase Auth has no idea it's the same person.
-- This can't catch every case (a determined evader can also use a new
-- phone), but phone number reuse is the cheapest, most common tell, and it
-- costs nothing extra to check since every account already collects one.
--
-- 1. `banned_phones` snapshots the phone number on an account the moment it
--    gets banned (hooked into moderationService.setAccountStatus below) -
--    kept even if that phone is later cleared or the profile deleted, since
--    the whole point is to remember it past that account's lifetime.
--
-- 2. A trigger on `profiles` (insert, or update of phone) checks the new
--    phone against that list. A match doesn't block anything - signup/phone
--    changes still go through - it just drops a row in
--    `ban_evasion_flags` for an admin to review and decide (that "new"
--    account might genuinely be a family member reusing a household line).
--
-- Run this in the Supabase SQL Editor after migration_17.
-- Safe to run once; re-running just replaces the trigger/function.

create table if not exists public.banned_phones (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  banned_uid uuid not null references public.profiles(uid),
  banned_at timestamptz not null default now()
);
create index if not exists banned_phones_phone_idx on public.banned_phones (phone);

create table if not exists public.ban_evasion_flags (
  id uuid primary key default gen_random_uuid(),
  new_uid uuid not null references public.profiles(uid),
  phone text not null,
  matched_banned_uid uuid not null references public.profiles(uid),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists ban_evasion_flags_status_idx on public.ban_evasion_flags (status, created_at desc);

alter table public.banned_phones enable row level security;
alter table public.ban_evasion_flags enable row level security;

drop policy if exists "admins can read banned phones" on public.banned_phones;
create policy "admins can read banned phones" on public.banned_phones
  for select using (
    exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

drop policy if exists "admins can read ban evasion flags" on public.ban_evasion_flags;
create policy "admins can read ban evasion flags" on public.ban_evasion_flags
  for select using (
    exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

drop policy if exists "admins can update ban evasion flags" on public.ban_evasion_flags;
create policy "admins can update ban evasion flags" on public.ban_evasion_flags
  for update using (
    exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

-- Fires on insert (phone set at signup) or whenever phone changes
-- (setPhone). Skips the no-op case of an UPDATE that didn't actually touch
-- phone. security definer so it can read banned_phones/write
-- ban_evasion_flags regardless of which role's session triggered the
-- underlying profiles write.
create or replace function public.check_phone_ban_evasion() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
begin
  if new.phone is null or new.phone = '' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.phone is not distinct from new.phone then
    return new;
  end if;

  select * into v_match
  from public.banned_phones
  where phone = new.phone
  order by banned_at desc
  limit 1;

  if found then
    insert into public.ban_evasion_flags (new_uid, phone, matched_banned_uid)
    values (new.uid, new.phone, v_match.banned_uid);
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_phone_ban_evasion_check on public.profiles;
create trigger profiles_phone_ban_evasion_check
  after insert or update of phone on public.profiles
  for each row execute function public.check_phone_ban_evasion();
