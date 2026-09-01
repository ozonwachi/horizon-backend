-- Task: commission negotiation flow - lets a buyer propose a different
-- (lower) commission rate to the seller before opening an escrow deal;
-- only takes effect once the seller explicitly accepts. See
-- negotiations/index.ts and escrowService.ts's createAgreement
-- (negotiationId param).
--
-- Deliberately a request/accept flow, not a live back-and-forth counter-
-- offer - the requester proposes once, the counterparty accepts or
-- declines. A declined/expired proposal can simply be re-proposed with new
-- numbers if the parties want to keep talking.
--
-- Safety: this table only ever RECORDS what the two parties agreed to -
-- it's escrowService.ts's createAgreement that actually applies it, and
-- only ever as a CAP (min of the negotiated rate and the platform's normal
-- rate for that deal type/category) - so an accepted negotiation can only
-- ever lower what a buyer pays, never raise it above the standard rate,
-- regardless of what's stored here.
--
-- Run this in the Supabase SQL Editor after migration_24.
-- Safe to run once; re-running is guarded everywhere it matters.

create table if not exists public.commission_negotiations (
  id uuid primary key default gen_random_uuid(),
  requester_uid uuid not null references public.profiles(uid),
  counterparty_uid uuid not null references public.profiles(uid),
  amount_kobo integer not null check (amount_kobo > 0),
  proposed_mode text not null check (proposed_mode in ('percentage', 'flat')),
  proposed_value numeric not null check (proposed_value >= 0),
  message text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'used', 'expired')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  used_at timestamptz
);

alter table public.commission_negotiations enable row level security;

-- No client-facing write policies: proposing, responding, and consuming a
-- negotiation all go through the negotiations/admin Edge Functions
-- (service-role), same as commission_negotiations' closest analog
-- (contact_share_flags) - keeps the "only the min of negotiated/standard
-- rate is ever applied" safety rule enforced in one place (the backend),
-- not duplicated into an RLS policy that a client write could route around.
drop policy if exists "participants can read their own negotiations" on public.commission_negotiations;
create policy "participants can read their own negotiations"
  on public.commission_negotiations for select
  using (auth.uid() = requester_uid or auth.uid() = counterparty_uid);

create index if not exists commission_negotiations_counterparty_idx
  on public.commission_negotiations (counterparty_uid, status);
