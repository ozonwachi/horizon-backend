-- ============================================================================
-- Admin payout approval system.
--
-- Extends the existing withdrawal_requests pending->paid/rejected flow
-- (see wallet_request_withdrawal/wallet_mark_withdrawal_paid/
-- wallet_reject_withdrawal in migration_02) with a tiered admin-approval
-- gate that sits between "requested" and "money actually leaves via
-- Paystack" - previously a single admin could mark ANY amount paid with no
-- approval step at all.
--
-- Two tiers only:
--   <= payout_high_tier_threshold_kobo (default NGN 1,000,000): any one
--     staff member (owner or worker) approves.
--   >  threshold: the owner alone, OR two DISTINCT workers jointly
--     (covers the owner being unavailable).
--
-- Staff roles: profiles.staff_role is 'admin' (owner - the platform
-- owner/operator) or 'worker' (junior staff). is_admin stays exactly as it
-- was (a plain "has staff access at all" boolean, still true for both
-- roles) - nothing that already checks is_admin needs to change.
--
-- Lock condition: NOT disputes (a disputed escrow tranche can't also be
-- RELEASED, so disputed money was never in the wallet to withdraw in the
-- first place - confirmed against escrowService.ts's state model). The
-- real lock is account_status - approval/execution re-check
-- account_status = 'active' at each step, same condition
-- requireActiveAccount already enforces on every other money-movement
-- route.
--
-- Run this in the Supabase SQL Editor after migration_35.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Staff role on profiles. Nullable - only meaningful once is_admin=true,
--    enforced by the check below rather than assumed.
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists staff_role text;

alter table public.profiles drop constraint if exists profiles_staff_role_check;
alter table public.profiles add constraint profiles_staff_role_check
  check (staff_role is null or staff_role in ('admin', 'worker'));

alter table public.profiles drop constraint if exists profiles_staff_role_requires_admin_check;
alter table public.profiles add constraint profiles_staff_role_requires_admin_check
  check (staff_role is null or is_admin = true);

-- Seed: the one existing is_admin account becomes the first owner. Every
-- later admin/worker account is granted through the new staff-management
-- endpoints (adminManagementService.ts), never by editing this table by
-- hand again.
update public.profiles
set staff_role = 'admin'
where uid = '88606c06-4920-4a2a-872b-e149ed6a310f' and is_admin = true and staff_role is null;

-- ----------------------------------------------------------------------------
-- 2. Configurable tier threshold - same singleton-row pattern as every
--    other platform_settings field, so it's editable via the existing
--    GET/PATCH /admin/settings route rather than hardcoded.
-- ----------------------------------------------------------------------------
alter table public.platform_settings
  add column if not exists payout_high_tier_threshold_kobo bigint not null default 100000000;

alter table public.platform_settings drop constraint if exists platform_settings_payout_threshold_check;
alter table public.platform_settings add constraint platform_settings_payout_threshold_check
  check (payout_high_tier_threshold_kobo > 0);

-- ----------------------------------------------------------------------------
-- 3. withdrawal_requests: approval/execution tracking columns, and a wider
--    status range (pending -> approved -> processing -> paid, or
--    pending/approved -> rejected, or processing -> failed).
-- ----------------------------------------------------------------------------
alter table public.withdrawal_requests add column if not exists approved_at timestamptz;
alter table public.withdrawal_requests add column if not exists execution_method text;
alter table public.withdrawal_requests add column if not exists paystack_transfer_code text;
alter table public.withdrawal_requests add column if not exists paystack_transfer_reference text;

alter table public.withdrawal_requests drop constraint if exists withdrawal_requests_status_check;
alter table public.withdrawal_requests add constraint withdrawal_requests_status_check
  check (status in ('pending', 'approved', 'processing', 'paid', 'rejected', 'failed'));

alter table public.withdrawal_requests drop constraint if exists withdrawal_requests_execution_method_check;
alter table public.withdrawal_requests add constraint withdrawal_requests_execution_method_check
  check (execution_method is null or execution_method in ('automatic', 'manual'));

create unique index if not exists withdrawal_requests_transfer_reference_idx
  on public.withdrawal_requests (paystack_transfer_reference)
  where paystack_transfer_reference is not null;

-- ----------------------------------------------------------------------------
-- 4. One row per approval. Unique on (request, approver) so the same staff
--    member can't approve their own decision twice; approver_role is
--    snapshotted at approval time (not re-derived from profiles later) so
--    a later role change can't retroactively alter what an already-counted
--    approval was made as.
-- ----------------------------------------------------------------------------
create table if not exists public.withdrawal_approvals (
  id uuid primary key default gen_random_uuid(),
  withdrawal_request_id uuid not null references public.withdrawal_requests(id),
  approver_uid uuid not null references public.profiles(uid),
  approver_role text not null check (approver_role in ('admin', 'worker')),
  approved_at timestamptz not null default now(),
  unique (withdrawal_request_id, approver_uid)
);

create index if not exists withdrawal_approvals_request_idx
  on public.withdrawal_approvals (withdrawal_request_id);

-- Admin-only table, same trust model as audit_logs/withdrawal_requests -
-- horizon-backend always writes through supabase.rpc(...)/service-role,
-- which bypasses RLS. No policies means the anon/authenticated keys the
-- Flutter app uses get nothing here at all.
alter table public.withdrawal_approvals enable row level security;

-- ----------------------------------------------------------------------------
-- 5. wallet_transactions gets one new ledger type: a credit-back when an
--    automatic Paystack transfer fails/reverses after money was already
--    debited at request time (distinct from withdrawal_rejected so the
--    two scenarios stay distinguishable in a user's transaction history).
-- ----------------------------------------------------------------------------
alter table public.wallet_transactions drop constraint if exists wallet_transactions_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_type_check
  check (type in (
    'escrow_release', 'escrow_refund', 'escrow_payment', 'deposit',
    'withdrawal', 'withdrawal_rejected', 'withdrawal_failed', 'admin_force_cancel',
    'referral_payout', 'referral_payout_debit', 'connection_fee',
    'admin_credit', 'off_platform_reward', 'commission_refund'
  ));

-- ----------------------------------------------------------------------------
-- 6. wallet_approve_withdrawal - records one approval and, if the tier's
--    requirement is now met, flips pending -> approved. Looks up the
--    approver's CURRENT is_admin/staff_role from profiles itself rather
--    than trusting a role passed in from the caller - the backend always
--    calls this right after requireAdmin has already checked is_admin, but
--    a real money-moving function re-validates its own authority instead
--    of trusting the layer above it.
-- ----------------------------------------------------------------------------
create or replace function public.wallet_approve_withdrawal(
  p_request_id uuid,
  p_approver_uid uuid
) returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
  v_is_admin boolean;
  v_role text;
  v_account_status text;
  v_threshold bigint;
  v_admin_approvals int;
  v_worker_approvals int;
  v_satisfied boolean;
begin
  select is_admin, staff_role into v_is_admin, v_role
  from public.profiles where uid = p_approver_uid;
  if v_is_admin is not true then
    raise exception 'Approver is not an admin';
  end if;
  if v_role is null then
    raise exception 'Approver has no staff role assigned';
  end if;

  select account_status into v_account_status from public.profiles where uid = p_approver_uid;
  if v_account_status is distinct from 'active' then
    raise exception 'Your account is under review, so approving payouts is temporarily paused';
  end if;

  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status != 'pending' then
    raise exception 'Cannot approve a request with status "%"', v_req.status;
  end if;

  if exists (
    select 1 from public.withdrawal_approvals
    where withdrawal_request_id = p_request_id and approver_uid = p_approver_uid
  ) then
    raise exception 'You have already approved this withdrawal request';
  end if;

  insert into public.withdrawal_approvals (withdrawal_request_id, approver_uid, approver_role)
  values (p_request_id, p_approver_uid, v_role);

  select payout_high_tier_threshold_kobo into v_threshold from public.platform_settings where id = 1;

  select
    count(*) filter (where approver_role = 'admin'),
    count(distinct approver_uid) filter (where approver_role = 'worker')
  into v_admin_approvals, v_worker_approvals
  from public.withdrawal_approvals
  where withdrawal_request_id = p_request_id;

  if v_req.amount_kobo <= v_threshold then
    v_satisfied := true;
  else
    v_satisfied := v_admin_approvals >= 1 or v_worker_approvals >= 2;
  end if;

  if v_satisfied then
    update public.withdrawal_requests
    set status = 'approved', approved_at = now(), updated_at = now()
    where id = p_request_id
    returning * into v_req;
  end if;

  return v_req;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Execution. wallet_execute_withdrawal_manual REPLACES
--    wallet_mark_withdrawal_paid (dropped below) - the old function let any
--    single admin mark ANY amount paid straight from 'pending' with zero
--    approval, which is exactly the bypass this whole migration exists to
--    close. Both new execution paths require status='approved' instead,
--    and re-check the payee's account_status fresh, per the hard
--    "re-validate immediately before execution" rule.
-- ----------------------------------------------------------------------------
drop function if exists public.wallet_mark_withdrawal_paid(uuid);

create or replace function public.wallet_execute_withdrawal_manual(
  p_request_id uuid,
  p_reference text
) returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
  v_payee_status text;
begin
  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status != 'approved' then
    raise exception 'Cannot execute a request with status "%" - it must be approved first', v_req.status;
  end if;

  select account_status into v_payee_status from public.profiles where uid = v_req.uid;
  if v_payee_status is distinct from 'active' then
    raise exception 'Payee account is under review - withdrawal execution blocked';
  end if;

  update public.withdrawal_requests
  set status = 'paid', execution_method = 'manual', paystack_transfer_reference = p_reference,
      paid_at = now(), updated_at = now()
  where id = p_request_id
  returning * into v_req;

  return v_req;
end;
$$;

-- Records that an automatic transfer was just started (approved ->
-- processing) - the actual Paystack API call happens in TypeScript
-- (paystackService.ts) before this is called, since it's an external HTTP
-- call and can't live inside a Postgres function. The webhook
-- (wallet_complete_withdrawal_transfer / wallet_fail_withdrawal_transfer
-- below) is what actually confirms success or failure.
create or replace function public.wallet_start_withdrawal_transfer(
  p_request_id uuid,
  p_transfer_code text,
  p_transfer_reference text
) returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
  v_payee_status text;
begin
  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status != 'approved' then
    raise exception 'Cannot execute a request with status "%" - it must be approved first', v_req.status;
  end if;

  select account_status into v_payee_status from public.profiles where uid = v_req.uid;
  if v_payee_status is distinct from 'active' then
    raise exception 'Payee account is under review - withdrawal execution blocked';
  end if;

  update public.withdrawal_requests
  set status = 'processing', execution_method = 'automatic',
      paystack_transfer_code = p_transfer_code, paystack_transfer_reference = p_transfer_reference,
      updated_at = now()
  where id = p_request_id
  returning * into v_req;

  return v_req;
end;
$$;

-- Paystack transfer.success webhook lands here. Idempotent by construction:
-- once status is no longer 'processing' (e.g. a retried webhook delivery
-- after the first one already completed it), this raises instead of
-- double-processing - the webhook handler treats that as a harmless no-op,
-- not an error to surface.
create or replace function public.wallet_complete_withdrawal_transfer(
  p_transfer_reference text
) returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
begin
  select * into v_req from public.withdrawal_requests
  where paystack_transfer_reference = p_transfer_reference for update;
  if not found then raise exception 'No withdrawal matches transfer reference %', p_transfer_reference; end if;
  if v_req.status != 'processing' then
    raise exception 'Cannot complete a request with status "%"', v_req.status;
  end if;

  update public.withdrawal_requests
  set status = 'paid', paid_at = now(), updated_at = now()
  where id = v_req.id
  returning * into v_req;

  return v_req;
end;
$$;

-- Paystack transfer.failed / transfer.reversed webhook lands here. Credits
-- the amount back to the payee's wallet, same shape as
-- wallet_reject_withdrawal's credit-back but tagged withdrawal_failed so
-- it's distinguishable in their transaction history from an outright
-- rejection.
create or replace function public.wallet_fail_withdrawal_transfer(
  p_transfer_reference text,
  p_reason text
) returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
begin
  select * into v_req from public.withdrawal_requests
  where paystack_transfer_reference = p_transfer_reference for update;
  if not found then raise exception 'No withdrawal matches transfer reference %', p_transfer_reference; end if;
  if v_req.status != 'processing' then
    raise exception 'Cannot fail a request with status "%"', v_req.status;
  end if;

  perform public.wallet_adjust(
    v_req.uid, v_req.amount_kobo, 'withdrawal_failed', null, null,
    coalesce(p_reason, 'Automatic transfer failed'), null
  );

  update public.withdrawal_requests
  set status = 'failed', rejection_reason = p_reason, updated_at = now()
  where id = v_req.id
  returning * into v_req;

  return v_req;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. wallet_reject_withdrawal widened to accept 'approved' as well as
--    'pending' - an approved-but-not-yet-executed payout can still be
--    rejected (e.g. something looked wrong after approval), same
--    credit-back behavior either way.
-- ----------------------------------------------------------------------------
create or replace function public.wallet_reject_withdrawal(p_request_id uuid, p_reason text)
returns public.withdrawal_requests
language plpgsql
as $$
declare
  v_req public.withdrawal_requests;
begin
  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status not in ('pending', 'approved') then
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
