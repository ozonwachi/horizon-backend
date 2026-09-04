-- Task: the "connection_fee_paid" notification names who paid, but the
-- admin wallet's own transaction history had no way to tell - the credit
-- row's reason was always the fixed string 'Connection fee received', with
-- nothing identifying which user it came from. Username isn't a reliable
-- way to look someone up either (it's optional - see
-- profiles_username_lower_idx's partial index), so this bakes the payer's
-- EMAIL (always set, always unique) into the reason text instead.
--
-- No new column, no Flutter changes needed - AdminWalletScreen already
-- renders `reason` as the transaction subtitle (see wallet_transaction.dart
-- / admin_wallet_screen.dart), so this alone is the whole fix.
--
-- Run this in the Supabase SQL Editor after migration_32.
-- Safe to run once; re-running just replaces the function definition.

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
  v_payer_email text;
begin
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be greater than 0';
  end if;

  v_balance := public.wallet_get_balance_locked(p_uid);
  if p_amount_kobo > v_balance then
    raise exception 'Insufficient wallet balance to pay this connection fee';
  end if;

  select email into v_payer_email from public.profiles where uid = p_uid;

  v_tx_id := public.wallet_adjust(
    p_uid, -p_amount_kobo, 'connection_fee', null, null,
    coalesce(p_note, 'Connection fee'), null
  );

  perform public.wallet_adjust(
    p_admin_wallet_uid, p_amount_kobo, 'connection_fee', null, null,
    coalesce(p_note, 'Connection fee received') ||
      case when v_payer_email is not null and length(v_payer_email) > 0
        then ' from ' || v_payer_email
        else ''
      end,
    null
  );

  return v_tx_id;
end;
$$;
