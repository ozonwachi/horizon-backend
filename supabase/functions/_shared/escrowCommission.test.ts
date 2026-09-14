// Unit tests for the pure commission-math helpers in escrowService.ts -
// selectTierForAmount, commissionFromTier, commissionFromRule,
// commissionFromSettings. These are the actual arithmetic behind every
// deal's commission (see calculateCommission, which just orchestrates
// fetching the right rows and hands off to these), so a mistake here is a
// mistake in real money changing hands.
//
// Run with: deno test supabase/functions/_shared/escrowCommission.test.ts
// (needs Deno installed - see https://deno.com/manual/getting_started/installation
// if `deno` isn't already on your PATH).
//
// No Supabase client or database needed - that's the whole point of having
// pulled these four functions out as pure data-in/data-out helpers. No
// external test-library import either (no jsr:@std/assert) - deliberately
// zero-dependency, so this never breaks on a registry hiccup and never
// needs `deno test` to have network access at all.
import {
  commissionFromRule,
  commissionFromSettings,
  commissionFromTier,
  selectTierForAmount,
} from "./escrowService.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(
      `${msg ? msg + " - " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ---------------------------------------------------------------------------
// selectTierForAmount
// ---------------------------------------------------------------------------

Deno.test("selectTierForAmount - exact match inside a tier's range", () => {
  const tiers = [
    { id: "t1", min_amount_kobo: 0, max_amount_kobo: 100_000, mode: "flat", value: 500 },
    { id: "t2", min_amount_kobo: 100_001, max_amount_kobo: 1_000_000, mode: "percentage", value: 5 },
    { id: "t3", min_amount_kobo: 1_000_001, max_amount_kobo: null, mode: "percentage", value: 2 },
  ];
  assertEquals(selectTierForAmount(tiers, 50_000)!.id, "t1");
  assertEquals(selectTierForAmount(tiers, 500_000)!.id, "t2");
  assertEquals(selectTierForAmount(tiers, 5_000_000)!.id, "t3");
  // Boundaries are inclusive on both ends.
  assertEquals(selectTierForAmount(tiers, 100_000)!.id, "t1");
  assertEquals(selectTierForAmount(tiers, 100_001)!.id, "t2");
});

Deno.test("selectTierForAmount - below the lowest tier's minimum uses the lowest tier", () => {
  const tiers = [
    { id: "t1", min_amount_kobo: 50_000, max_amount_kobo: 500_000, mode: "flat", value: 1000 },
    { id: "t2", min_amount_kobo: 500_001, max_amount_kobo: null, mode: "percentage", value: 5 },
  ];
  // Nothing covers amounts under 50,000 - product decision is to extend the
  // lowest tier down rather than fall back to the platform default.
  assertEquals(selectTierForAmount(tiers, 1_000)!.id, "t1");
});

Deno.test("selectTierForAmount - above the highest tier's maximum uses the highest tier", () => {
  const tiers = [
    { id: "t1", min_amount_kobo: 0, max_amount_kobo: 100_000, mode: "flat", value: 500 },
    { id: "t2", min_amount_kobo: 100_001, max_amount_kobo: 1_000_000, mode: "percentage", value: 5 },
  ];
  assertEquals(selectTierForAmount(tiers, 50_000_000)!.id, "t2");
});

Deno.test("selectTierForAmount - gap between non-contiguous tiers uses the highest passed tier", () => {
  // t1 covers up to 100,000 and t2 only starts at 200,001 - 150,000 falls
  // in the gap between them.
  const tiers = [
    { id: "t1", min_amount_kobo: 0, max_amount_kobo: 100_000, mode: "flat", value: 500 },
    { id: "t2", min_amount_kobo: 200_001, max_amount_kobo: null, mode: "percentage", value: 5 },
  ];
  assertEquals(selectTierForAmount(tiers, 150_000)!.id, "t1");
});

Deno.test("selectTierForAmount - empty tier list returns null", () => {
  assertEquals(selectTierForAmount([], 100_000), null);
});

// ---------------------------------------------------------------------------
// commissionFromTier
// ---------------------------------------------------------------------------

Deno.test("commissionFromTier - percentage rounds to the nearest kobo", () => {
  // 5% of 333,333 kobo = 16,666.65 -> rounds to 16,667.
  assertEquals(commissionFromTier({ mode: "percentage", value: 5 }, 333_333), 16_667);
});

Deno.test("commissionFromTier - flat mode ignores amountKobo entirely", () => {
  assertEquals(commissionFromTier({ mode: "flat", value: 2_500 }, 10_000_000), 2_500);
});

// ---------------------------------------------------------------------------
// commissionFromRule
// ---------------------------------------------------------------------------

Deno.test("commissionFromRule - percentage with no clamp", () => {
  assertEquals(
    commissionFromRule({ mode: "percentage", value: 10, min_kobo: null, max_kobo: null }, 200_000),
    20_000
  );
});

Deno.test("commissionFromRule - min_kobo raises a too-small commission to the floor", () => {
  // 2% of 10,000 = 200, but min_kobo says never charge less than 500.
  assertEquals(
    commissionFromRule({ mode: "percentage", value: 2, min_kobo: 500, max_kobo: null }, 10_000),
    500
  );
});

Deno.test("commissionFromRule - max_kobo caps a too-large commission", () => {
  // 10% of 10,000,000 = 1,000,000, but max_kobo caps it at 50,000.
  assertEquals(
    commissionFromRule({ mode: "percentage", value: 10, min_kobo: null, max_kobo: 50_000 }, 10_000_000),
    50_000
  );
});

Deno.test("commissionFromRule - min and max both set, amount lands inside the range untouched", () => {
  assertEquals(
    commissionFromRule({ mode: "percentage", value: 5, min_kobo: 100, max_kobo: 100_000 }, 1_000_000),
    50_000
  );
});

Deno.test("commissionFromRule - flat mode still respects min/max clamps", () => {
  assertEquals(
    commissionFromRule({ mode: "flat", value: 10_000, min_kobo: null, max_kobo: 5_000 }, 1_000_000),
    5_000
  );
});

// ---------------------------------------------------------------------------
// commissionFromSettings
// ---------------------------------------------------------------------------

Deno.test("commissionFromSettings - percentage platform default", () => {
  assertEquals(
    commissionFromSettings({ admin_commission_type: "percentage", admin_commission_value: 7.5 }, 400_000),
    30_000
  );
});

Deno.test("commissionFromSettings - flat platform default ignores amount", () => {
  assertEquals(
    commissionFromSettings({ admin_commission_type: "flat", admin_commission_value: 1_500 }, 9_999_999),
    1_500
  );
});
