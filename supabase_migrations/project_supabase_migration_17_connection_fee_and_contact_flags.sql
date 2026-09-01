-- Task: connection-fee regulation + contact-sharing detection.
--
-- The problem: jobs/barter/listings connect a buyer and a seller through
-- the app, but nothing stops them from swapping phone numbers and finishing
-- the deal - and paying each other - entirely off-platform, so the
-- commission on that deal is never collected. This migration builds the
-- three pieces that regulate that, without trying to block messaging
-- outright (a false-positive block on a legitimate message would be far
-- worse than a false-positive warning):
--
-- 1. `platform_settings` gains connection_fee_type/connection_fee_value -
--    the admin-configurable fee (flat or percentage) a user is expected to
--    pay if they take a deal off-platform. Same shape as
--    admin_commission_type/value, editable from the same admin screen.
--
-- 2. `contact_share_flags` - a row is inserted here (by the conversations
--    Edge Function, service-role) whenever a message LOOKS like it's
--    sharing a phone number, email, or a common off-platform contact
--    keyword ("whatsapp", "call me on", ...). This is a heuristic, not
--    proof - it deliberately stores just a short matched snippet and which
--    conversation/item it came from, not read access to the whole thread,
--    so admins get a lead to review rather than a surveillance feed.
--
-- 3. `pay_connection_fee()` - a self-serve wallet debit an honest user can
--    call (via the wallet Edge Function) to declare and pay the fee for a
--    deal they took off-platform, modeled directly on
--    wallet_request_withdrawal's balance-locked debit pattern in
--    project_supabase_migration_02_escrow_wallet_functions.sql. Credits the
--    admin wallet (ADMIN_WALLET_UID) in the same transaction.
--
-- Run this in the Supabase SQL Editor after migration_16.
-- Safe to run once; re-running just replaces the function and (for the new
-- columns) is a no-op via `if not exists`.

alter table public.platform_settings
  add column if not exists connection_fee_type text not null default 'percentage'
    check (connection_fee_type in ('flat', 'percentage')),
  add column if not exists connection_fee_value numeric not null default 5;

create table if not exists public.contact_share_flags (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(uid),
  sender_name text not null default '',
  matched_snippet text not null default '',
  related_item_title text,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists contact_share_flags_status_idx on public.contact_share_flags (status, created_at desc);

alter table public.contact_share_flags enable row level security;

drop policy if exists "admins can read contact share flags" on public.contact_share_flags;
create policy "admins can read contact share flags" on public.contact_share_flags
  for select using (
    exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

drop policy if exists "admins can update contact share flags" on public.contact_share_flags;
create policy "admins can update contact share flags" on public.contact_share_flags
  for update using (
    exists (select 1 from public.profiles p where p.uid = auth.uid() and p.is_admin)
  );

-- No insert policy: rows are only ever written by the conversations Edge
-- Function through the service-role client, which bypasses RLS entirely -
-- deliberately not opened up to ordinary users.

-- Self-serve "I did a deal off-platform, here's the fee" payment. Mirrors
-- wallet_request_withdrawal: row-lock the payer's wallet, verify they can
-- cover it, then move the money in one transaction so there's no window
-- where it's debited from one side without landing on the other.
create or replace function public.pay_connection_fee(
  p_uid uuid,
  p_amount_kobo bigint,
  p_admin_wallet_uid uuid,
  p_note text default null
) returns uuid
language plpgsql
as $$
declare
  v_balance bigint;
  v_tx_id uuid;
begin
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be greater than 0';
  end if;

  v_balance := public.wallet_get_balance_locked(p_uid);
  if p_amount_kobo > v_balance then
    raise exception 'Insufficient wallet balance to pay this connection fee';
  end if;

  v_tx_id := public.wallet_adjust(
    p_uid, -p_amount_kobo, 'connection_fee', null, null,
    coalesce(p_note, 'Connection fee'), null
  );

  perform public.wallet_adjust(
    p_admin_wallet_uid, p_amount_kobo, 'connection_fee', null, null,
    coalesce(p_note, 'Connection fee received'), null
  );

  return v_tx_id;
end;
$$;
