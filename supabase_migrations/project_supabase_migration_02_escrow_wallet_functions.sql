-- ============================================================================
-- Project Horizon — escrow + wallet transactional functions (Task #25)
-- Run this in the Supabase SQL Editor AFTER project_supabase_schema.sql has
-- already been run (needs escrow_agreements/escrow_tranches/wallets/
-- wallet_transactions/withdrawal_requests to exist).
--
-- Why this file exists: Firestore's db.runTransaction(...) let the old
-- backend read+write several documents atomically in one round trip.
-- Supabase's JS client has no equivalent — a sequence of plain .update()/
-- .insert() calls from Node each commit separately, which is not safe for
-- money (a crash between "debit buyer" and "credit seller" would lose or
-- duplicate funds). Postgres functions are the fix: everything inside one
-- function body runs as a single transaction, so it's called via
-- supabase.rpc('function_name', {...}) from horizon-backend instead of a
-- chain of .update() calls — same atomicity guarantee Firestore gave us,
-- just expressed as SQL. Every function here does one thing a Firestore
-- transaction used to do in escrowService.js / walletService.js — see the
-- comment above each one for which.
--
-- These run with whatever role calls them. horizon-backend always calls
-- through supabase.rpc(...) using the service_role key, which bypasses Row
-- Level Security — same trust model as the Admin SDK bypassing
-- firestore.rules today. Nothing here is meant to be callable by the
-- Flutter app directly (it never had direct escrow/wallet writes before,
-- and still doesn't).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Wallet core: every balance change and its ledger row, together, atomically.
-- Replaces the pattern (repeated ~10 times across escrowService.js /
-- walletService.js) of tx.set(walletRef, {balanceKobo: increment(x)}) +
-- recordWalletTransaction(tx, {...}) inside the same Firestore transaction.
-- [p_amount_kobo] is signed exactly like before: positive credits the
-- wallet, negative debits it.
-- ----------------------------------------------------------------------------
create or replace function public.wallet_adjust(
  p_uid uuid,
  p_amount_kobo bigint,
  p_type text,
  p_agreement_id uuid default null,
  p_tranche_id uuid default null,
  p_reason text default null,
  p_recipient_role text default null
) returns uuid
language plpgsql
as $$
declare
  v_tx_id uuid;
begin
  insert into public.wallets (uid, balance_kobo)
  values (p_uid, p_amount_kobo)
  on conflict (uid) do update
    set balance_kobo = public.wallets.balance_kobo + excluded.balance_kobo,
        updated_at = now();

  insert into public.wallet_transactions
    (uid, amount_kobo, type, agreement_id, tranche_id, reason, recipient_role)
  values
    (p_uid, p_amount_kobo, p_type, p_agreement_id, p_tranche_id, p_reason, p_recipient_role)
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

-- Ensures a wallet row exists and returns its balance with a row lock held
-- for the rest of the calling transaction — the concurrency-safe way to do
-- "check balance, then maybe debit it" (used by requestWithdrawal and
-- payFromWallet) without two concurrent requests both reading the same
-- starting balance and over-drawing it.
create or replace function public.wallet_get_balance_locked(p_uid uuid) returns bigint
language plpgsql
as $$
declare
  v_balance bigint;
begin
  insert into public.wallets (uid, balance_kobo) values (p_uid, 0)
  on conflict (uid) do nothing;

  select balance_kobo into v_balance from public.wallets where uid = p_uid for update;
  return v_balance;
end;
$$;

-- ----------------------------------------------------------------------------
-- Withdrawals — was requestWithdrawal/markWithdrawalPaid/rejectWithdrawal's
-- db.runTransaction blocks in walletService.js.
-- ----------------------------------------------------------------------------
create or replace function public.wallet_request_withdrawal(
  p_uid uuid,
  p_amount_kobo bigint,
  p_bank_name text,
  p_account_number text,
  p_account_name text
) returns uuid
language plpgsql
as $$
declare
  v_balance bigint;
  v_request_id uuid;
begin
  v_balance := public.wallet_get_balance_locked(p_uid);
  if p_amount_kobo > v_balance then
    raise exception 'Requested amount exceeds available balance';
  end if;

  perform public.wallet_adjust(
    p_uid, -p_amount_kobo, 'withdrawal', null, null,
    format('Withdrawal to %s (%s)', p_bank_name, p_account_number), null
  );

  insert into public.withdrawal_requests
    (uid, amount_kobo, bank_name, account_number, account_name, status)
  values
    (p_uid, p_amount_kobo, p_bank_name, p_account_number, p_account_name, 'pending')
  returning id into v_request_id;

  return v_request_id;
end;
$$;

create or replace function public.wallet_mark_withdrawal_paid(p_request_id uuid)
returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
begin
  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status != 'pending' then
    raise exception 'Cannot mark a request with status "%" as paid', v_req.status;
  end if;

  update public.withdrawal_requests
  set status = 'paid', paid_at = now(), updated_at = now()
  where id = p_request_id
  returning * into v_req;

  return v_req;
end;
$$;

create or replace function public.wallet_reject_withdrawal(p_request_id uuid, p_reason text)
returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
begin
  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status != 'pending' then
    raise exception 'Cannot reject a request with status "%"', v_req.status;
  end if;

  perform public.wallet_adjust(
    v_req.uid, v_req.amount_kobo, 'withdrawal_rejected', null, null,
    coalesce(p_reason, 'Withdrawal request rejected'), null
  );

  update public.withdrawal_requests
  set status = 'rejected', rejection_reason = p_reason, updated_at = now()
  where id = p_request_id
  returning * into v_req;

  return v_req;
end;
$$;

-- ----------------------------------------------------------------------------
-- Escrow: create agreement + its tranches together, atomically — a partial
-- write here would otherwise leave an agreement with no tranches, which
-- every other function assumes can't happen.
-- Amount/commission/validated-tranche computation stays in JS (escrowService
-- .js) exactly as before; this just performs the insert.
-- p_tranches shape: [{ "label": text, "amountKobo": bigint,
--   "releaseConditionType": text, "releaseAfterDays": int|null }, ...]
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
      (agreement_id, label, amount_kobo, release_condition_type, release_after_days)
    values
      (v_agreement_id,
       coalesce(v_tranche->>'label', 'Full amount'),
       (v_tranche->>'amountKobo')::bigint,
       v_tranche->>'releaseConditionType',
       nullif(v_tranche->>'releaseAfterDays', '')::int);
  end loop;

  return v_agreement_id;
end;
$$;

-- Was markFunded's transaction: flip to funded, start the clock on every
-- timed_from_funding tranche, recompute the agreement's denormalized
-- next_release_eligible_at (the cron sweep's join field).
create or replace function public.escrow_mark_funded(p_agreement_id uuid, p_reference text)
returns void
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_found boolean;
begin
  select true into v_found from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;

  update public.escrow_tranches
  set funded_at = v_now,
      release_eligible_at = case
        when release_condition_type = 'timed_from_funding'
          then v_now + (release_after_days || ' days')::interval
        else release_eligible_at
      end
  where agreement_id = p_agreement_id;

  update public.escrow_agreements
  set status = 'funded',
      paystack_reference = p_reference,
      next_release_eligible_at = (
        select min(release_eligible_at) from public.escrow_tranches
        where agreement_id = p_agreement_id and status = 'pending' and release_eligible_at is not null
      ),
      updated_at = v_now
  where id = p_agreement_id;
end;
$$;

-- Was payFromWallet's transaction: debit the buyer's wallet for
-- amount+commission, then fund the agreement exactly like markFunded above.
create or replace function public.escrow_pay_from_wallet(p_agreement_id uuid, p_buyer_id uuid)
returns void
language plpgsql
as $$
declare
  v_agreement record;
  v_balance bigint;
  v_total bigint;
  v_now timestamptz := now();
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;
  if v_agreement.buyer_id != p_buyer_id then raise exception 'Not your agreement'; end if;
  if v_agreement.status != 'pending_payment' then
    raise exception 'Cannot pay from status "%"', v_agreement.status;
  end if;

  v_balance := public.wallet_get_balance_locked(p_buyer_id);
  v_total := v_agreement.amount_kobo + v_agreement.commission_kobo;
  if v_balance < v_total then
    raise exception 'Insufficient wallet balance';
  end if;

  perform public.wallet_adjust(p_buyer_id, -v_total, 'escrow_payment', p_agreement_id, null, null, 'buyer');

  update public.escrow_tranches
  set funded_at = v_now,
      release_eligible_at = case
        when release_condition_type = 'timed_from_funding'
          then v_now + (release_after_days || ' days')::interval
        else release_eligible_at
      end
  where agreement_id = p_agreement_id;

  update public.escrow_agreements
  set status = 'funded',
      paystack_reference = null,
      payment_method = 'wallet',
      next_release_eligible_at = (
        select min(release_eligible_at) from public.escrow_tranches
        where agreement_id = p_agreement_id and status = 'pending' and release_eligible_at is not null
      ),
      updated_at = v_now
  where id = p_agreement_id;
end;
$$;

-- Legacy single/whole-agreement release (old agreements with <=1 tranche).
-- Was markReleased's transaction.
create or replace function public.escrow_mark_released_legacy(p_agreement_id uuid)
returns void
language plpgsql
as $$
declare
  v_agreement record;
  v_now timestamptz := now();
  v_tranche_count int;
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;

  select count(*) into v_tranche_count from public.escrow_tranches where agreement_id = p_agreement_id;
  if v_tranche_count > 1 then
    raise exception 'This agreement has multiple tranches - release them individually via releaseTranche.';
  end if;
  if v_agreement.status != 'funded' then
    raise exception 'Cannot release from status "%"', v_agreement.status;
  end if;

  update public.escrow_tranches
  set status = 'released', released_at = v_now
  where agreement_id = p_agreement_id;

  perform public.wallet_adjust(v_agreement.seller_id, v_agreement.amount_kobo, 'escrow_release', p_agreement_id, null, null, 'seller');

  update public.escrow_agreements
  set status = 'released', released_at = v_now, updated_at = v_now
  where id = p_agreement_id;
end;
$$;

-- Core tranche release — shared by the buyer-driven confirmTrancheRelease
-- path (p_admin_uid null) and adminResolveTranche's "release" outcome
-- (p_admin_uid set). Was _releaseTrancheInTransaction. Idempotent: releasing
-- an already-released tranche returns already_released=true instead of
-- erroring or double-crediting the seller.
create or replace function public.escrow_release_tranche(
  p_agreement_id uuid,
  p_tranche_id uuid,
  p_buyer_uid uuid default null,   -- set on the ordinary buyer-driven path (confirmTrancheRelease); null for admin
  p_admin_uid uuid default null,   -- set on adminResolveTranche's "release" outcome
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

  -- These ownership/status checks used to happen in JS right before opening
  -- the Firestore transaction - moved inside here too so there's no gap
  -- between "check" and "act" for a concurrent caller to land in.
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
    v_agreement.seller_id, v_tranche.amount_kobo, 'escrow_release',
    p_agreement_id, p_tranche_id,
    case when p_admin_uid is not null then p_admin_reason else null end,
    'seller'
  );

  select
    count(*) filter (where status = 'disputed'),
    count(*) filter (where status in ('released','refunded','settled')),
    count(*) filter (where status = 'refunded'),
    count(*)
  into v_disputed_count, v_settled_count, v_refunded_count, v_total_count
  from public.escrow_tranches where agreement_id = p_agreement_id;

  -- Mirrors computeAgreementStatus in escrowService.js exactly: any
  -- disputed tranche wins; else not-fully-settled = partially_released;
  -- else all-refunded = refunded; else released (all released, or a
  -- released/refunded mix - RELEASED is the closest existing label).
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

-- adminResolveTranche's "refund" outcome — the buyer-refund twin of
-- escrow_release_tranche above. Only ever called on a disputed tranche.
create or replace function public.escrow_refund_tranche(
  p_agreement_id uuid,
  p_tranche_id uuid,
  p_admin_uid uuid,
  p_admin_reason text
) returns text
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

  if v_tranche.status != 'disputed' then
    raise exception 'Tranche is not under dispute';
  end if;

  update public.escrow_tranches
  set status = 'refunded',
      released_at = v_now,
      admin_resolved_by = p_admin_uid,
      admin_resolution_outcome = 'refund',
      admin_resolution_reason = p_admin_reason,
      admin_resolved_at = v_now
  where id = p_tranche_id;

  perform public.wallet_adjust(
    v_agreement.buyer_id, v_tranche.amount_kobo, 'escrow_refund',
    p_agreement_id, p_tranche_id, p_admin_reason, 'buyer'
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
  set status = v_new_status, updated_at = v_now
  where id = p_agreement_id;

  return v_new_status;
end;
$$;

-- Was markMilestoneReached's transaction: start a timed_from_milestone
-- tranche's countdown.
create or replace function public.escrow_mark_milestone(
  p_agreement_id uuid,
  p_tranche_id uuid,
  p_seller_id uuid
) returns void
language plpgsql
as $$
declare
  v_agreement record;
  v_tranche record;
  v_now timestamptz := now();
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;
  if v_agreement.seller_id != p_seller_id then raise exception 'Not your agreement'; end if;

  select * into v_tranche from public.escrow_tranches
    where id = p_tranche_id and agreement_id = p_agreement_id for update;
  if not found then raise exception 'Tranche not found'; end if;
  if v_tranche.release_condition_type != 'timed_from_milestone' then
    raise exception 'This tranche isn''t milestone-based';
  end if;
  if v_tranche.status != 'pending' then
    raise exception 'Cannot mark milestone on tranche with status "%"', v_tranche.status;
  end if;

  update public.escrow_tranches
  set milestone_marked_at = v_now,
      release_eligible_at = v_now + (release_after_days || ' days')::interval
  where id = p_tranche_id;

  update public.escrow_agreements
  set next_release_eligible_at = (
        select min(release_eligible_at) from public.escrow_tranches
        where agreement_id = p_agreement_id and status = 'pending' and release_eligible_at is not null
      ),
      updated_at = v_now
  where id = p_agreement_id;
end;
$$;

-- Was disputeTranche's transaction: blocks only the one tranche, flags the
-- agreement disputed so it surfaces in the admin queue.
create or replace function public.escrow_dispute_tranche(
  p_agreement_id uuid,
  p_tranche_id uuid,
  p_actor_id uuid,
  p_reason text
) returns void
language plpgsql
as $$
declare
  v_agreement record;
  v_now timestamptz := now();
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;
  if v_agreement.buyer_id != p_actor_id and v_agreement.seller_id != p_actor_id then
    raise exception 'Not a party to this agreement';
  end if;

  update public.escrow_tranches
  set status = 'disputed', dispute_reason = p_reason
  where id = p_tranche_id and agreement_id = p_agreement_id;
  if not found then raise exception 'Tranche not found'; end if;

  update public.escrow_agreements
  set status = 'disputed',
      next_release_eligible_at = (
        select min(release_eligible_at) from public.escrow_tranches
        where agreement_id = p_agreement_id and status = 'pending' and release_eligible_at is not null
      ),
      updated_at = v_now
  where id = p_agreement_id;
end;
$$;

-- Was requestOrConfirmCancel's transaction. notify_kind tells the JS caller
-- which of the three messages to send:
--   'cancelled_unfunded' - buyer cancelled before funding, done immediately
--   'requested'          - first call on a funded deal, waiting on the other party
--   'confirmed'          - second call: mutual cancel is final, pending tranches refunded
create or replace function public.escrow_request_or_confirm_cancel(
  p_agreement_id uuid,
  p_actor_id uuid
) returns table(new_status text, other_party_id uuid, notify_kind text)
language plpgsql
as $$
declare
  v_agreement record;
  v_other_party uuid;
  v_now timestamptz := now();
  v_refund_kobo bigint := 0;
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;

  if v_agreement.buyer_id != p_actor_id and v_agreement.seller_id != p_actor_id then
    raise exception 'Not a party to this agreement';
  end if;
  v_other_party := case when v_agreement.buyer_id = p_actor_id then v_agreement.seller_id else v_agreement.buyer_id end;

  if v_agreement.status in ('disputed', 'released', 'refunded', 'cancelled') then
    raise exception 'Cannot cancel from status "%"', v_agreement.status;
  end if;

  if v_agreement.status = 'pending_payment' then
    if v_agreement.buyer_id != p_actor_id then
      raise exception 'Only the buyer can cancel before the deal is funded';
    end if;
    update public.escrow_agreements
    set status = 'cancelled', cancel_requested_by = p_actor_id, cancelled_at = v_now, updated_at = v_now
    where id = p_agreement_id;
    return query select 'cancelled', v_other_party, 'cancelled_unfunded';
    return;
  end if;

  if v_agreement.cancel_requested_by is null then
    update public.escrow_agreements
    set cancel_requested_by = p_actor_id, updated_at = v_now
    where id = p_agreement_id;
    return query select v_agreement.status, v_other_party, 'requested';
    return;
  end if;

  if v_agreement.cancel_requested_by = p_actor_id then
    raise exception 'You already requested cancellation - waiting for the other party to confirm';
  end if;

  select coalesce(sum(amount_kobo), 0) into v_refund_kobo
  from public.escrow_tranches
  where agreement_id = p_agreement_id and status = 'pending';

  update public.escrow_tranches
  set status = 'refunded', released_at = v_now
  where agreement_id = p_agreement_id and status = 'pending';

  if v_refund_kobo > 0 then
    perform public.wallet_adjust(
      v_agreement.buyer_id, v_refund_kobo, 'escrow_refund',
      p_agreement_id, null, 'Mutual cancellation', 'buyer'
    );
  end if;

  update public.escrow_agreements
  set status = 'cancelled', cancel_requested_by = null, cancelled_at = v_now, updated_at = v_now
  where id = p_agreement_id;

  return query select 'cancelled', v_other_party, 'confirmed';
end;
$$;

-- Was adminForceCancelDeal's transaction. p_tranche_splits is the already-
-- validated-in-JS array (see normalizeForceCancelDecision in
-- escrowService.js — unchanged, still runs before this is called):
--   [{ "trancheId": uuid, "splits": [{"recipient": "buyer"|"seller"|"admin_wallet", "amountKobo": bigint}, ...] }, ...]
-- Re-validates status/amount sums here too (not just trusting the JS layer)
-- since this is the actual money-moving step and the only place that truly
-- has to be right.
create or replace function public.escrow_admin_force_cancel(
  p_agreement_id uuid,
  p_admin_uid uuid,
  p_reason text,
  p_admin_wallet_uid uuid,
  p_tranche_splits jsonb
) returns void
language plpgsql
as $$
declare
  v_agreement record;
  v_now timestamptz := now();
  v_entry jsonb;
  v_split jsonb;
  v_tranche record;
  v_tranche_id uuid;
  v_sum bigint;
  v_recipient text;
  v_recipient_uid uuid;
  v_single_recipient text;
  v_new_tranche_status text;
  v_outcome text;
begin
  select * into v_agreement from public.escrow_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;
  if v_agreement.status not in ('funded', 'partially_released', 'disputed') then
    raise exception 'Cannot force-cancel from status "%"', v_agreement.status;
  end if;

  for v_entry in select * from jsonb_array_elements(p_tranche_splits)
  loop
    v_tranche_id := (v_entry->>'trancheId')::uuid;
    select * into v_tranche from public.escrow_tranches
      where id = v_tranche_id and agreement_id = p_agreement_id for update;
    if not found then raise exception 'Tranche not found: %', v_tranche_id; end if;
    if v_tranche.status not in ('pending', 'disputed') then
      raise exception 'Tranche "%" is no longer open (status "%")', v_tranche.label, v_tranche.status;
    end if;

    v_sum := 0;
    for v_split in select * from jsonb_array_elements(v_entry->'splits') loop
      v_sum := v_sum + (v_split->>'amountKobo')::bigint;
    end loop;
    if v_sum != v_tranche.amount_kobo then
      raise exception 'Split amounts for tranche "%" total % kobo but the tranche is % kobo', v_tranche.label, v_sum, v_tranche.amount_kobo;
    end if;

    v_single_recipient := case when jsonb_array_length(v_entry->'splits') = 1
      then (v_entry->'splits'->0->>'recipient') else null end;

    for v_split in select * from jsonb_array_elements(v_entry->'splits') loop
      v_recipient := v_split->>'recipient';
      v_recipient_uid := case v_recipient
        when 'seller' then v_agreement.seller_id
        when 'buyer' then v_agreement.buyer_id
        when 'admin_wallet' then p_admin_wallet_uid
        else null
      end;
      if v_recipient_uid is null then
        raise exception 'Invalid split recipient "%"', v_recipient;
      end if;

      perform public.wallet_adjust(
        v_recipient_uid, (v_split->>'amountKobo')::bigint, 'admin_force_cancel',
        p_agreement_id, v_tranche_id, p_reason, v_recipient
      );
    end loop;

    v_new_tranche_status := case v_single_recipient
      when 'seller' then 'released'
      when 'buyer' then 'refunded'
      else 'settled'
    end;
    v_outcome := case v_single_recipient
      when 'seller' then 'release'
      when 'buyer' then 'refund'
      when 'admin_wallet' then 'admin_wallet'
      else 'split'
    end;

    update public.escrow_tranches
    set status = v_new_tranche_status,
        released_at = v_now,
        splits = v_entry->'splits',
        admin_resolved_by = p_admin_uid,
        admin_resolution_outcome = v_outcome,
        admin_resolution_reason = p_reason,
        admin_resolved_at = v_now
    where id = v_tranche_id;
  end loop;

  update public.escrow_agreements
  set status = 'cancelled', cancelled_at = v_now, updated_at = v_now
  where id = p_agreement_id;
end;
$$;
