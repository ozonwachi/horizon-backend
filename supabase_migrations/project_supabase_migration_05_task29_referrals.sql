-- Task #29: referral + commission payout system.
-- Run this in the Supabase SQL Editor after migrations 02, 03, and 04.
--
-- The referrals/referral_earnings/platform_settings tables already exist
-- (provisioned ahead of time in the original project_supabase_schema.sql
-- back in Task #22) - this migration only adds the function that actually
-- pays a referral bonus out, atomically.

-- ----------------------------------------------------------------------------
-- referral_payout_process
-- ----------------------------------------------------------------------------
-- Called once per party (buyer, seller) on an escrow agreement right after
-- it transitions to fully 'released' (see escrowService.js's
-- confirmTrancheRelease and adminResolveTranche, which call this via
-- referralService.processReferralPayoutsForAgreement). A no-op, not an
-- error, when the given uid was never referred by anyone.
--
-- Idempotency: the unique index referral_earnings_one_per_trade_idx on
-- (referral_id, agreement_id) is what actually guarantees a single trade
-- never pays out twice, even under a retry or a race - the insert below
-- catches unique_violation and treats it as "already paid" rather than
-- erroring. The `for update` row lock on the referrals row serializes
-- concurrent payout attempts for the SAME referred person (e.g. two of
-- their trades settling back-to-back) so the
-- referral_max_payouts_per_referred_user cap is enforced correctly rather
-- than both racing past a stale count.
--
-- p_admin_wallet_uid is passed in from JS (ADMIN_WALLET_UID env var) rather
-- than looked up here - same reasoning as escrow_admin_force_cancel's
-- p_admin_wallet_uid param, there's no fixed sentinel uid in Postgres for
-- "the admin wallet", it's an operator-configured real profile.
create or replace function public.referral_payout_process(
  p_referred_uid uuid,
  p_agreement_id uuid,
  p_admin_wallet_uid uuid
) returns table(paid boolean, referrer_uid uuid, amount_kobo bigint)
language plpgsql
as $$
declare
  v_referral record;
  v_settings record;
  v_agreement record;
  v_payout_count int;
  v_amount bigint;
begin
  select * into v_referral from public.referrals where referred_uid = p_referred_uid for update;
  if not found then
    return query select false, null::uuid, null::bigint;
    return;
  end if;

  select * into v_settings from public.platform_settings where id = 1;

  select * into v_agreement from public.escrow_agreements where id = p_agreement_id;
  if not found then
    raise exception 'Agreement not found';
  end if;

  select count(*) into v_payout_count
  from public.referral_earnings
  where referral_id = v_referral.id;

  if v_payout_count >= v_settings.referral_max_payouts_per_referred_user then
    return query select false, v_referral.referrer_uid, null::bigint;
    return;
  end if;

  if v_settings.referral_commission_type = 'flat' then
    v_amount := v_settings.referral_commission_value::bigint;
  else
    v_amount := round(v_agreement.amount_kobo * v_settings.referral_commission_value / 100.0)::bigint;
  end if;

  if v_amount <= 0 then
    return query select false, v_referral.referrer_uid, null::bigint;
    return;
  end if;

  begin
    insert into public.referral_earnings (referral_id, referrer_uid, referred_uid, agreement_id, amount_kobo)
    values (v_referral.id, v_referral.referrer_uid, p_referred_uid, p_agreement_id, v_amount);
  exception when unique_violation then
    return query select false, v_referral.referrer_uid, null::bigint;
    return;
  end;

  perform public.wallet_adjust(
    v_referral.referrer_uid, v_amount, 'referral_payout', p_agreement_id, null,
    'Referral bonus for a referred user completing a trade', null
  );
  perform public.wallet_adjust(
    p_admin_wallet_uid, -v_amount, 'referral_payout_debit', p_agreement_id, null,
    'Referral bonus paid out to a referrer', null
  );

  return query select true, v_referral.referrer_uid, v_amount;
end;
$$;

-- ----------------------------------------------------------------------------
-- referral_link
-- ----------------------------------------------------------------------------
-- Creates the referrer -> referred relationship. Called once, right after
-- a new user's first signup (see referralService.linkReferral in the
-- backend). There's no INSERT policy on public.referrals for regular users
-- (see project_supabase_schema.sql's RLS section) - by design, linking a
-- referral always goes through this function via the backend's
-- service_role client, so self-referrals and made-up referrer uids get
-- validated in one place rather than trusted from the client.
create or replace function public.referral_link(
  p_referrer_uid uuid,
  p_referred_uid uuid
) returns void
language plpgsql
as $$
begin
  if p_referrer_uid = p_referred_uid then
    raise exception 'You cannot refer yourself.';
  end if;

  if not exists (select 1 from public.profiles where uid = p_referrer_uid) then
    raise exception 'That referral code does not match any user.';
  end if;

  if exists (select 1 from public.referrals where referred_uid = p_referred_uid) then
    raise exception 'This account has already been linked to a referral.';
  end if;

  insert into public.referrals (referrer_uid, referred_uid)
  values (p_referrer_uid, p_referred_uid);
end;
$$;
