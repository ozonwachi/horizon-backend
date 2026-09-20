-- ============================================================================
-- In-app delivery, redesigned around a price NEGOTIATION instead of the
-- buyer typing a fee at deal creation (migration_39's original design).
--
-- New flow:
--   1. The buyer picks a delivery partner and makes an OFFER. Nothing is
--      added to any tranche or charged - `deliveries` just gets a
--      'negotiating' row plus a first row in `delivery_offers`.
--   2. Buyer and partner go back and forth (counter-offers, any number of
--      rounds). Only the party who did NOT make the current offer can
--      accept/counter it.
--   3. When one side accepts, the agreed price is turned into real money:
--        - item deal NOT yet paid  -> added to that same deal as its own
--          'logistics' tranche (escrow_add_delivery_tranche below), so the
--          buyer still makes ONE payment, with delivery and seller money in
--          separate tranches (released together when the item tranche is,
--          exactly as migration_39's escrow_release_tranche already does).
--        - item deal ALREADY paid  -> a separate escrow agreement of type
--          'delivery' (buyer -> partner) that the buyer pays on its own; no
--          new SQL needed for that, it reuses escrow_create_agreement.
--   4. Until it's agreed AND paid, the buyer can turn in-app delivery off
--      and carry on (deliveries.status 'cancelled'). The row persists across
--      app restarts, so a slow reply just leaves the deal as a draft.
--
-- Run this in the Supabase SQL Editor after migration_39.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. deliveries: room for a negotiation that hasn't produced any tranche yet.
-- ----------------------------------------------------------------------------
alter table public.deliveries alter column logistics_tranche_id drop not null;
alter table public.deliveries alter column item_tranche_id drop not null;

alter table public.deliveries drop constraint if exists deliveries_status_check;
alter table public.deliveries add constraint deliveries_status_check
  check (status in ('negotiating', 'assigned', 'accepted', 'picked_up', 'in_transit', 'delivered', 'rejected', 'cancelled'));

-- The price both sides agreed on, and - only when the item deal was already
-- paid at agreement time - the separate delivery agreement that carries it.
alter table public.deliveries add column if not exists agreed_amount_kobo bigint;
alter table public.deliveries add column if not exists delivery_agreement_id uuid references public.escrow_agreements(id);

create index if not exists deliveries_delivery_agreement_idx
  on public.deliveries (delivery_agreement_id) where delivery_agreement_id is not null;

-- ----------------------------------------------------------------------------
-- 2. delivery_offers: the back-and-forth. The newest 'pending' row is the
--    current offer; a counter marks it 'countered' and inserts the reply.
--    Admin-only-table pattern (no policies) - everything goes through the
--    `logistics` edge function, which checks who is a party.
-- ----------------------------------------------------------------------------
create table if not exists public.delivery_offers (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  offered_by uuid not null references public.profiles(uid),
  offered_by_role text not null check (offered_by_role in ('buyer', 'partner')),
  amount_kobo bigint not null check (amount_kobo > 0),
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'countered', 'declined', 'withdrawn')),
  created_at timestamptz not null default now()
);

create index if not exists delivery_offers_delivery_idx
  on public.delivery_offers (delivery_id, created_at);

alter table public.delivery_offers enable row level security;

-- ----------------------------------------------------------------------------
-- 3. escrow_add_delivery_tranche - attach an agreed delivery price to an
--    item deal that has NOT been paid yet. Under the agreement's row lock so
--    it can't race with the buyer paying at the same moment: if the deal got
--    funded first this raises a message starting with DELIVERY_NOT_ADDABLE,
--    which the caller treats as "fall back to a separate delivery deal".
--    The caller passes the recomputed commission for the new total (commission
--    logic lives in JS - see calculateCommission in escrowService.ts).
-- ----------------------------------------------------------------------------
create or replace function public.escrow_add_delivery_tranche(
  p_agreement_id uuid,
  p_partner_uid uuid,
  p_amount_kobo bigint,
  p_new_commission_kobo bigint,
  p_label text
) returns uuid
language plpgsql
as $$
declare
  v_agreement record;
  v_item record;
  v_new_id uuid;
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;
  if v_agreement.status != 'pending_payment' then
    raise exception 'DELIVERY_NOT_ADDABLE: this deal is already funded';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Delivery amount must be positive';
  end if;

  -- Ride along with the LAST item tranche - the one that most naturally
  -- means "the deal is done" (the only one, in a simple buy-now deal).
  select * into v_item from public.escrow_tranches
    where agreement_id = p_agreement_id and tranche_type = 'item' and status = 'pending'
    order by created_at desc, id
    limit 1;
  if not found then raise exception 'No pending item tranche to attach delivery to'; end if;

  insert into public.escrow_tranches
    (agreement_id, label, amount_kobo, release_condition_type, recipient_id, tranche_type, linked_item_tranche_id)
  values
    (p_agreement_id, coalesce(p_label, 'Delivery fee'), p_amount_kobo, 'buyer_confirmation',
     p_partner_uid, 'logistics', v_item.id)
  returning id into v_new_id;

  update public.escrow_agreements
  set amount_kobo = amount_kobo + p_amount_kobo,
      commission_kobo = p_new_commission_kobo,
      updated_at = now()
  where id = p_agreement_id;

  return v_new_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. escrow_remove_delivery_tranche - the buyer turning in-app delivery off
--    after a price was agreed but BEFORE paying. Only valid while the deal is
--    still unpaid (nothing to refund). Detaches the tranche from any
--    deliveries row first (that FK would otherwise block the delete).
-- ----------------------------------------------------------------------------
create or replace function public.escrow_remove_delivery_tranche(
  p_agreement_id uuid,
  p_tranche_id uuid,
  p_new_commission_kobo bigint
) returns void
language plpgsql
as $$
declare
  v_agreement record;
  v_tranche record;
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;
  if v_agreement.status != 'pending_payment' then
    raise exception 'DELIVERY_NOT_REMOVABLE: this deal is already funded';
  end if;

  select * into v_tranche from public.escrow_tranches
    where id = p_tranche_id and agreement_id = p_agreement_id
      and tranche_type = 'logistics' and status = 'pending'
    for update;
  if not found then raise exception 'Delivery tranche not found'; end if;

  update public.deliveries set logistics_tranche_id = null where logistics_tranche_id = p_tranche_id;
  delete from public.escrow_tranches where id = p_tranche_id;

  update public.escrow_agreements
  set amount_kobo = amount_kobo - v_tranche.amount_kobo,
      commission_kobo = p_new_commission_kobo,
      updated_at = now()
  where id = p_agreement_id;
end;
$$;
