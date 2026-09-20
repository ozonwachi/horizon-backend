-- ============================================================================
-- Delivery money and seller money are RELEASED SEPARATELY.
--
-- migration_39's escrow_release_tranche auto-released a linked delivery
-- tranche in the same call whenever its item tranche was released, so the
-- buyer could never release the seller without also paying the delivery
-- partner (or the other way round). The delivery fee is its own tranche now
-- in every sense: the buyer releases the item tranche (-> seller) and the
-- delivery tranche (-> delivery partner) as two independent actions, each
-- with its own confirm and its own dispute.
--
-- This is migration_39's function with ONLY the "release the linked tranche
-- too" block removed. Everything else - paying recipient_id instead of always
-- the seller, the checks, the agreement status recomputation - is unchanged.
-- linked_item_tranche_id stays on escrow_tranches as a plain record of which
-- item a delivery fee belongs to; nothing acts on it any more.
--
-- Independent of migration_40 - safe to run before or after it.
-- ============================================================================

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
