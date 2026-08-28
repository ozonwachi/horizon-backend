-- Task: short referral codes. The existing referral code (a user's raw uid)
-- keeps working forever for anyone who already shared/saved it - see
-- resolveReferrerUid in referralService.ts, which accepts either form. This
-- just adds a short, human-typeable alternative that resolves to the same
-- uid. Nullable and lazily filled in (by ensureReferralCode in
-- referralService.ts, the same self-healing pattern used elsewhere in this
-- codebase) rather than backfilled here, so this migration is a pure
-- additive, zero-downtime change.
alter table public.profiles add column referral_code text;
create unique index profiles_referral_code_idx on public.profiles (referral_code) where referral_code is not null;
