-- ============================================================================
-- Logistics Partner Network. Real logistics companies apply in-app, an
-- admin reviews/approves them, and once approved they get a dedicated
-- in-app screen to manage deliveries. Money flow is a three-way escrow: the
-- buyer pays an item fee (-> seller) AND a separate logistics fee (-> the
-- assigned partner), both held in the same agreement as two tranches.
-- Entirely optional - a deal with no logistics tranche behaves exactly as
-- before this migration.
--
-- Design (confirmed with the product owner during this session):
--  - A logistics fee is just a second escrow_tranches row on the SAME
--    agreement, not a separate money system. `recipient_id` (backfilled to
--    seller_id for every existing tranche) is WHO gets paid when a tranche
--    releases - normally the seller, but the logistics tranche's recipient
--    is the assigned partner instead.
--  - `linked_item_tranche_id` on the logistics tranche points at the item
--    tranche it rides along with: releasing the item tranche (buyer
--    confirmation - unchanged trigger, unchanged timing) ALSO releases the
--    linked logistics tranche to the partner, in the same atomic operation.
--    Delivery status (picked up/in transit/delivered) never gates this.
--  - Commission is computed on the combined amount_kobo (item + logistics)
--    exactly like today - no change to calculateCommission/checkout/wallet
--    funding math, which keeps every existing money-verification path
--    (Paystack checkout amount, escrow_pay_from_wallet's balance check)
--    completely untouched and exactly as risk-tested as before this
--    migration. This is a deliberate simplification versus commission-free
--    logistics fees, made for safety in a single-session build.
--
-- Run this in the Supabase SQL Editor after migration_38.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. escrow_tranches: who a tranche pays out to, and what kind it is.
-- ----------------------------------------------------------------------------
alter table public.escrow_tranches add column if not exists recipient_id uuid references public.profiles(uid);
update public.escrow_tranches t
set recipient_id = a.seller_id
from public.escrow_agreements a
where t.agreement_id = a.id and t.recipient_id is null;
alter table public.escrow_tranches alter column recipient_id set not null;

alter table public.escrow_tranches add column if not exists tranche_type text not null default 'item';
alter table public.escrow_tranches drop constraint if exists escrow_tranches_tranche_type_check;
alter table public.escrow_tranches add constraint escrow_tranches_tranche_type_check
  check (tranche_type in ('item', 'logistics'));

alter table public.escrow_tranches add column if not exists linked_item_tranche_id uuid references public.escrow_tranches(id);

create index if not exists escrow_tranches_linked_item_idx
  on public.escrow_tranches (linked_item_tranche_id) where linked_item_tranche_id is not null;

-- ----------------------------------------------------------------------------
-- 2. profiles: an approved logistics partner flag - same boolean-flag
--    pattern as is_admin, checked by the app to show/hide the partner-only
--    screen and by RLS/edge routes to gate partner actions.
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists is_logistics_partner boolean not null default false;

-- ----------------------------------------------------------------------------
-- 3. logistics_partner_applications - same "user files, admin reviews via
--    service-role edge route" shape as verification_requests
--    (migration_11): the applicant can insert/read their own rows; nothing
--    else is exposed to the anon/authenticated client directly.
-- ----------------------------------------------------------------------------
create table if not exists public.logistics_partner_applications (
  id uuid primary key default gen_random_uuid(),
  applicant_uid uuid not null references public.profiles(uid),
  company_name text not null,
  contact_person_name text not null,
  contact_phone text not null,
  contact_email text,
  company_address text not null,
  registration_number text, -- CAC/business reg number, optional
  coverage_areas text, -- free text, e.g. "Lagos, Ogun" - not a strict enum
  latitude double precision,
  longitude double precision,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_notes text not null default '',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(uid)
);
create index if not exists logistics_partner_applications_status_idx
  on public.logistics_partner_applications (status, created_at desc);
create index if not exists logistics_partner_applications_applicant_idx
  on public.logistics_partner_applications (applicant_uid);

alter table public.logistics_partner_applications enable row level security;

drop policy if exists "applicants can file their own logistics application" on public.logistics_partner_applications;
create policy "applicants can file their own logistics application"
  on public.logistics_partner_applications
  for insert with check (auth.uid() = applicant_uid);

drop policy if exists "applicants can read their own logistics application" on public.logistics_partner_applications;
create policy "applicants can read their own logistics application"
  on public.logistics_partner_applications
  for select using (auth.uid() = applicant_uid);

-- ----------------------------------------------------------------------------
-- 4. deliveries - the physical-logistics workflow, deliberately separate
--    from escrow_tranches.status (which is only ever about the MONEY).
--    Admin-only-table pattern (no RLS policies) - the app reads/writes this
--    exclusively through the `logistics` edge function, which enforces
--    "only the assigned partner/seller/buyer/admin" per route.
-- ----------------------------------------------------------------------------
create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.escrow_agreements(id),
  logistics_tranche_id uuid not null references public.escrow_tranches(id),
  item_tranche_id uuid not null references public.escrow_tranches(id),
  seller_id uuid not null references public.profiles(uid),
  buyer_id uuid not null references public.profiles(uid),
  partner_id uuid not null references public.profiles(uid),
  status text not null default 'assigned'
    check (status in ('assigned', 'accepted', 'picked_up', 'in_transit', 'delivered', 'rejected')),
  handover_photo_path text, -- storage object path (private bucket), not a URL - see logistics/index.ts
  rejection_reason text,
  accepted_at timestamptz,
  picked_up_at timestamptz,
  in_transit_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deliveries_partner_idx on public.deliveries (partner_id, status);
create index if not exists deliveries_agreement_idx on public.deliveries (agreement_id);

alter table public.deliveries enable row level security;

-- ----------------------------------------------------------------------------
-- 5. Storage bucket for seller handover photos - private, same
--    "{uploader_uid}/..." ownership convention as identity-documents
--    (migration_11). Only the seller (uploader) can read their own upload
--    back directly; buyer/partner/admin view it via a server-generated
--    signed URL from the `logistics` edge function (which checks they're
--    actually a party to that delivery first).
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'delivery-photos',
  'delivery-photos',
  false,
  10485760, -- 10MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Sellers can upload their own handover photos" on storage.objects;
create policy "Sellers can upload their own handover photos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'delivery-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Sellers can read their own handover photos" on storage.objects;
create policy "Sellers can read their own handover photos"
on storage.objects for select
to authenticated
using (
  bucket_id = 'delivery-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ----------------------------------------------------------------------------
-- 6. escrow_create_agreement: SAME signature as migration_02's version -
--    just reads three new optional keys off each tranche object
--    (recipientId, trancheType, linkedItemTrancheIndex). Every existing
--    caller (which sets none of these) gets byte-identical behavior:
--    recipient_id defaults to the seller, tranche_type defaults to 'item',
--    no link. linkedItemTrancheIndex is the 0-based position of the paired
--    item tranche WITHIN THIS SAME p_tranches ARRAY - resolved to a real
--    tranche id in a second pass, after every tranche has been inserted and
--    has an id to point at.
-- ----------------------------------------------------------------------------
create or replace function public.escrow_create_agreement(
  p_buyer_id uuid,
  p_seller_id uuid,
  p_type text,
  p_category text,
  p_amount_kobo bigint,
  p_commission_kobo bigint,
  p_commission_rule_id uuid,
  p_reference_id text,
  p_title text,
  p_description text,
  p_tranches jsonb
) returns uuid
language plpgsql
as $$
declare
  v_agreement_id uuid;
  v_tranche jsonb;
  v_index int := 0;
  v_tranche_ids uuid[] := '{}';
  v_new_id uuid;
  v_linked_index int;
begin
  insert into public.escrow_agreements
    (buyer_id, seller_id, type, category, reference_id, title, description,
     amount_kobo, commission_kobo, commission_rule_id, status)
  values
    (p_buyer_id, p_seller_id, p_type, p_category, p_reference_id, p_title, p_description,
     p_amount_kobo, p_commission_kobo, p_commission_rule_id, 'pending_payment')
  returning id into v_agreement_id;

  for v_tranche in select * from jsonb_array_elements(p_tranches)
  loop
    insert into public.escrow_tranches
      (agreement_id, label, amount_kobo, release_condition_type, release_after_days,
       recipient_id, tranche_type)
    values
      (v_agreement_id,
       coalesce(v_tranche->>'label', 'Full amount'),
       (v_tranche->>'amountKobo')::bigint,
       v_tranche->>'releaseConditionType',
       nullif(v_tranche->>'releaseAfterDays', '')::int,
       coalesce((v_tranche->>'recipientId')::uuid, p_seller_id),
       coalesce(v_tranche->>'trancheType', 'item'))
    returning id into v_new_id;

    v_tranche_ids := array_append(v_tranche_ids, v_new_id);
  end loop;

  v_index := 0;
  for v_tranche in select * from jsonb_array_elements(p_tranches)
  loop
    v_index := v_index + 1;
    v_linked_index := nullif(v_tranche->>'linkedItemTrancheIndex', '')::int;
    if v_linked_index is not null then
      update public.escrow_tranches
      set linked_item_tranche_id = v_tranche_ids[v_linked_index + 1] -- pg arrays are 1-based
      where id = v_tranche_ids[v_index];
    end if;
  end loop;

  return v_agreement_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. escrow_release_tranche: SAME signature as migration_02's version.
--    Two changes: (a) pay recipient_id instead of always seller_id, so a
--    logistics tranche pays the partner; (b) after releasing, also release
--    any tranche linked to THIS one (a logistics tranche riding along with
--    its item tranche) in the same atomic call, to its own recipient. The
--    linked release is skipped if it isn't 'pending' (e.g. a partner
--    already rejected/refunded it via escrow_reject_logistics_tranche, or
--    it's somehow already released) - both are no-ops, not errors, since
--    the buyer's confirm action must never fail because of the logistics
--    side.
-- ----------------------------------------------------------------------------
create or replace function public.escrow_release_tranche(
  p_agreement_id uuid,
  p_tranche_id uuid,
  p_buyer_uid uuid default null,
  p_admin_uid uuid default null,
  p_admin_reason text default null
) returns table(already_released boolean, new_status text)
language plpgsql
as $$
declare
  v_agreement record;
  v_tranche record;
  v_linked record;
  v_now timestamptz := now();
  v_new_status text;
  v_disputed_count int;
  v_settled_count int;
  v_refunded_count int;
  v_total_count int;
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;

  select * into v_tranche from public.escrow_tranches
    where id = p_tranche_id and agreement_id = p_agreement_id for update;
  if not found then raise exception 'Tranche not found'; end if;

  if v_tranche.status = 'released' then
    return query select true, v_agreement.status;
    return;
  end if;

  if p_admin_uid is not null then
    if v_tranche.status != 'disputed' then
      raise exception 'Tranche is not under dispute';
    end if;
  else
    if p_buyer_uid is null or v_agreement.buyer_id != p_buyer_uid then
      raise exception 'Not your agreement';
    end if;
    if v_agreement.status not in ('funded', 'partially_released') then
      raise exception 'Cannot release from status "%"', v_agreement.status;
    end if;
    if v_tranche.status = 'disputed' then
      raise exception 'Cannot release a disputed tranche';
    end if;
  end if;

  update public.escrow_tranches
  set status = 'released',
      released_at = v_now,
      admin_resolved_by = p_admin_uid,
      admin_resolution_outcome = case when p_admin_uid is not null then 'release' else null end,
      admin_resolution_reason = case when p_admin_uid is not null then p_admin_reason else null end,
      admin_resolved_at = case when p_admin_uid is not null then v_now else null end
  where id = p_tranche_id;

  perform public.wallet_adjust(
    v_tranche.recipient_id, v_tranche.amount_kobo, 'escrow_release',
    p_agreement_id, p_tranche_id,
    case when p_admin_uid is not null then p_admin_reason else null end,
    case when v_tranche.recipient_id = v_agreement.seller_id then 'seller' else 'logistics_partner' end
  );

  select * into v_linked from public.escrow_tranches
    where agreement_id = p_agreement_id and linked_item_tranche_id = p_tranche_id and status = 'pending'
    for update;
  if found then
    update public.escrow_tranches
    set status = 'released', released_at = v_now
    where id = v_linked.id;

    perform public.wallet_adjust(
      v_linked.recipient_id, v_linked.amount_kobo, 'escrow_release',
      p_agreement_id, v_linked.id, null, 'logistics_partner'
    );
  end if;

  select
    count(*) filter (where status = 'disputed'),
    count(*) filter (where status in ('released','refunded','settled')),
    count(*) filter (where status = 'refunded'),
    count(*)
  into v_disputed_count, v_settled_count, v_refunded_count, v_total_count
  from public.escrow_tranches where agreement_id = p_agreement_id;

  if v_disputed_count > 0 then
    v_new_status := 'disputed';
  elsif v_settled_count < v_total_count then
    v_new_status := 'partially_released';
  elsif v_refunded_count = v_total_count then
    v_new_status := 'refunded';
  else
    v_new_status := 'released';
  end if;

  update public.escrow_agreements
  set status = v_new_status,
      next_release_eligible_at = (
        select min(release_eligible_at) from public.escrow_tranches
        where agreement_id = p_agreement_id and status = 'pending' and release_eligible_at is not null
      ),
      released_at = case when v_new_status = 'released' then v_now else released_at end,
      updated_at = v_now
  where id = p_agreement_id;

  return query select false, v_new_status;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. escrow_reject_logistics_tranche - a partner declining an ALREADY
--    assigned delivery. Deliberately separate from escrow_refund_tranche
--    (migration_02), which is gated on the tranche already being
--    'disputed' as part of the admin dispute-resolution flow - a partner
--    rejecting isn't a dispute, so this operates on a plain 'pending'
--    logistics tranche instead. Never touches the item tranche or the
--    agreement's overall status - the item deal continues completely
--    unaffected; only the logistics side (this tranche + the `deliveries`
--    row, updated separately by the caller) reflects the rejection.
-- ----------------------------------------------------------------------------
create or replace function public.escrow_reject_logistics_tranche(
  p_tranche_id uuid,
  p_partner_uid uuid,
  p_reason text default null
) returns void
language plpgsql
as $$
declare
  v_tranche record;
  v_agreement record;
  v_now timestamptz := now();
begin
  select * into v_tranche from public.escrow_tranches where id = p_tranche_id for update;
  if not found then raise exception 'Tranche not found'; end if;
  if v_tranche.tranche_type != 'logistics' then
    raise exception 'Not a logistics tranche';
  end if;
  if v_tranche.recipient_id != p_partner_uid then
    raise exception 'Not your delivery';
  end if;
  if v_tranche.status = 'refunded' then
    return; -- already rejected - idempotent no-op, not an error
  end if;
  if v_tranche.status != 'pending' then
    raise exception 'Cannot reject a tranche with status "%"', v_tranche.status;
  end if;

  select * into v_agreement from public.escrow_agreements where id = v_tranche.agreement_id for update;

  update public.escrow_tranches
  set status = 'refunded',
      released_at = v_now,
      admin_resolution_outcome = 'refund',
      admin_resolution_reason = p_reason
  where id = p_tranche_id;

  -- Only move money if it was actually paid in - a partner can also reject
  -- before the buyer has funded the agreement at all.
  if v_agreement.status != 'pending_payment' then
    perform public.wallet_adjust(
      v_agreement.buyer_id, v_tranche.amount_kobo, 'escrow_refund',
      v_agreement.id, p_tranche_id, p_reason, 'buyer'
    );
  end if;
end;
$$;
