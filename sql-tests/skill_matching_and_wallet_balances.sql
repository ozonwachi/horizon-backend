-- Starter test suite, part 2 of 2 (see escrowCommission.test.ts for part 1 -
-- the commission math, run with `deno test` instead of in here).
--
-- Covers the two pieces of "money math and skill-tag matching" that live in
-- Postgres rather than in the app or the Deno backend:
--   Part A - the skill-tag matching predicate inside
--            match_job_notification_candidates() (migration_32) - the exact
--            logic that decides who gets notified about a new job.
--   Part B - wallet_adjust()'s balance arithmetic (migration_02) - the
--            function every credit/debit in the app (release, refund,
--            deposit, withdrawal, connection fee, admin credit...) goes
--            through.
--
-- HOW TO RUN: paste this whole file into the Supabase SQL Editor and run it,
-- the same way we ran the RLS/analytics verification queries earlier. Every
-- assertion either prints nothing (pass) or raises an error naming exactly
-- which case failed and what was expected vs. what happened (fail). The
-- whole thing runs inside one transaction that's rolled back at the very
-- end (`rollback;`), so nothing here touches real data - safe to run any
-- time, including against production.
--
-- Part B needs ONE real signed-up user to attach test wallet transactions
-- to - already set below to ozonwachi1@gmail.com. Swap the email on the
-- `where email = ...` line further down if you'd rather use a different
-- account - any account you don't mind seeing a couple of harmless,
-- rolled-back-anyway wallet_transactions rows briefly exist for is fine.

begin;

-- ===========================================================================
-- PART A - skill-tag matching predicate (migration_32)
-- ===========================================================================
--
-- match_job_notification_candidates() queries public.profiles directly, and
-- profiles.uid has a real foreign key to auth.users - there's no clean way
-- to insert throwaway fake candidates to exercise it end-to-end without
-- also creating fake auth.users rows, which is more invasive than a
-- read-only test script should be. Instead, this mirrors the exact
-- "primary match" predicate from inside that function (the tag-to-tag
-- comparison introduced by migration_32 - see its comment block) as a
-- pg_temp function, and tests THAT in isolation. If migration_32's
-- matching predicate ever changes, this mirror needs updating to match -
-- diff it against match_job_notification_candidates's own SQL body.

create or replace function pg_temp.skills_overlap(candidate_tags text[], job_tags text[])
returns boolean
language sql
as $$
  select exists (
    select 1
    from unnest(candidate_tags) as candidate_tag,
         unnest(job_tags) as job_tag
    where length(btrim(candidate_tag)) > 0
      and lower(btrim(candidate_tag)) <> 'job seeker'
      and lower(btrim(candidate_tag)) = lower(btrim(job_tag))
  );
$$;

do $$
begin
  -- Exact tag match.
  if pg_temp.skills_overlap(array['Plumber'], array['Plumber']) is distinct from true then
    raise exception 'FAIL: exact tag match ("Plumber" vs "Plumber") should match';
  end if;

  -- Case-insensitive: "MASon" on a profile should match "MasoN" on a job.
  if pg_temp.skills_overlap(array['MASon'], array['MasoN']) is distinct from true then
    raise exception 'FAIL: case-insensitive match ("MASon" vs "MasoN") should match';
  end if;

  -- Whitespace-insensitive.
  if pg_temp.skills_overlap(array['  Plumber  '], array['Plumber']) is distinct from true then
    raise exception 'FAIL: whitespace-trimmed match should match';
  end if;

  -- No overlap at all.
  if pg_temp.skills_overlap(array['Plumber'], array['Electrician']) is distinct from false then
    raise exception 'FAIL: "Plumber" vs "Electrician" should NOT match';
  end if;

  -- One of several tags on each side overlaps - should still match.
  if pg_temp.skills_overlap(array['Mason', 'Painter'], array['Electrician', 'Painter']) is distinct from true then
    raise exception 'FAIL: partial overlap across multiple tags should match';
  end if;

  -- "Job Seeker" is the wildcard, handled by a SEPARATE clause in the real
  -- function (see migration_32) - it must NEVER be treated as a real skill
  -- tag inside this specific predicate, even if a job happened to be
  -- (nonsensically) tagged "Job Seeker" too.
  if pg_temp.skills_overlap(array['Job Seeker'], array['Job Seeker']) is distinct from false then
    raise exception 'FAIL: "Job Seeker" must not match here - it is handled by the wildcard clause instead';
  end if;

  -- Empty candidate tags never match anything.
  if pg_temp.skills_overlap(array[]::text[], array['Plumber']) is distinct from false then
    raise exception 'FAIL: empty candidate tags should not match';
  end if;

  -- Empty job tags never match anything (this is what triggers the
  -- separate title/category substring fallback in the real function).
  if pg_temp.skills_overlap(array['Plumber'], array[]::text[]) is distinct from false then
    raise exception 'FAIL: empty job tags should not match';
  end if;

  raise notice 'PART A PASSED: skill-tag matching predicate behaves correctly (8 cases)';
end $$;

-- ===========================================================================
-- PART B - wallet balance arithmetic (wallet_adjust / migration_02)
-- ===========================================================================

do $$
declare
  v_uid uuid;
  v_starting_balance bigint;
  v_balance bigint;
begin
  select uid into v_uid
  from public.profiles
  where email = 'ozonwachi1@gmail.com';

  if v_uid is null then
    raise exception 'No profiles row found for that email - check it is spelled exactly as it appears in Supabase Auth > Users';
  end if;

  select coalesce(balance_kobo, 0) into v_starting_balance
  from public.wallets where uid = v_uid;
  v_starting_balance := coalesce(v_starting_balance, 0);

  -- A credit should increase the balance by exactly the amount credited.
  perform public.wallet_adjust(v_uid, 100000, 'deposit');
  select balance_kobo into v_balance from public.wallets where uid = v_uid;
  if v_balance is distinct from v_starting_balance + 100000 then
    raise exception 'FAIL: credit of 100000 kobo should raise balance by exactly 100000, got % (started at %)',
      v_balance, v_starting_balance;
  end if;

  -- A debit (negative amount) should decrease the balance by exactly that
  -- amount - this is the same function withdrawals/escrow payments use,
  -- just with a negative p_amount_kobo.
  perform public.wallet_adjust(v_uid, -30000, 'withdrawal');
  select balance_kobo into v_balance from public.wallets where uid = v_uid;
  if v_balance is distinct from v_starting_balance + 100000 - 30000 then
    raise exception 'FAIL: debit of 30000 kobo did not reduce the balance correctly, got %', v_balance;
  end if;

  -- Several adjustments in sequence should net out to a simple running sum
  -- - this is the core invariant every escrow release/refund/deposit/
  -- withdrawal/connection-fee/admin-credit path depends on.
  perform public.wallet_adjust(v_uid, 5000, 'escrow_release');
  perform public.wallet_adjust(v_uid, -2000, 'connection_fee');
  perform public.wallet_adjust(v_uid, 1000, 'admin_credit');
  select balance_kobo into v_balance from public.wallets where uid = v_uid;
  if v_balance is distinct from v_starting_balance + 100000 - 30000 + 5000 - 2000 + 1000 then
    raise exception 'FAIL: running balance after 5 adjustments should be %, got %',
      v_starting_balance + 100000 - 30000 + 5000 - 2000 + 1000, v_balance;
  end if;

  -- wallet_get_balance_locked() must agree with the plain column read -
  -- it's meant to be the same value, just row-locked for the duration of
  -- the calling transaction (see its doc comment in migration_02).
  if public.wallet_get_balance_locked(v_uid) is distinct from v_balance then
    raise exception 'FAIL: wallet_get_balance_locked() (%) disagrees with wallets.balance_kobo (%)',
      public.wallet_get_balance_locked(v_uid), v_balance;
  end if;

  -- Every adjustment above should have written a matching ledger row -
  -- that's the other half of what wallet_adjust does alongside the balance
  -- update, and it's what WalletScreen's Transaction History reads from.
  if (select count(*) from public.wallet_transactions
      where uid = v_uid and created_at > now() - interval '1 minute') < 5 then
    raise exception 'FAIL: expected at least 5 new wallet_transactions rows from the adjustments above';
  end if;

  raise notice 'PART B PASSED: wallet balance arithmetic and ledger writes are correct (starting balance %, ending balance %)',
    v_starting_balance, v_balance;
end $$;

-- Undoes every wallet_adjust() call above - the test account's real balance
-- and transaction history are exactly as they were before this script ran.
rollback;
