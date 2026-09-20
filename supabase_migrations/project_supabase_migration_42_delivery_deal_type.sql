-- ============================================================================
-- Allow escrow_agreements.type = 'delivery'.
--
-- When a delivery price is agreed AFTER the item deal was already paid, the
-- delivery becomes its own escrow agreement (buyer -> delivery partner) that
-- the buyer pays separately - see migration_40. It's created with
-- type = 'delivery', which the original CHECK constraint (listing / job /
-- barter / custom) rejects. Found by the end-to-end test: everything up to
-- accepting the price worked, then the delivery deal insert failed.
--
-- Same drop-and-re-add convention as the other constraint changes; existing
-- rows only use 'listing'/'custom', so re-validating them is safe.
-- ============================================================================

alter table public.escrow_agreements drop constraint if exists escrow_agreements_type_check;
alter table public.escrow_agreements add constraint escrow_agreements_type_check
  check (type in ('listing', 'job', 'barter', 'custom', 'delivery'));
