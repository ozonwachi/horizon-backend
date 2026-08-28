import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getAdminWalletUid } from "./walletLedgerService.ts";
import { notifyUser } from "./notificationService.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Excludes visually-ambiguous characters (0/O, 1/I/L) so a code read aloud
// or copied from a screenshot doesn't get mistyped.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 7;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

// Every account gets a short referral_code the first time it's needed
// (called from getReferralSummary) rather than backfilled in the migration -
// same self-healing pattern as ensureProfileExists. Retries a few times on
// the rare random collision (unique index on profiles.referral_code).
export async function ensureReferralCode(supabase: SupabaseClient, uid: string): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from("profiles")
    .select("referral_code")
    .eq("uid", uid)
    .single();
  if (existingError) throw existingError;
  if (existing.referral_code) return existing.referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomCode();
    const { data, error } = await supabase
      .from("profiles")
      .update({ referral_code: candidate })
      .eq("uid", uid)
      .is("referral_code", null) // avoid clobbering a code set by a concurrent call
      .select("referral_code")
      .maybeSingle();
    if (error) {
      // Unique violation (23505) means another account grabbed that code in
      // the same instant - just try another candidate.
      if ((error as { code?: string }).code === "23505") continue;
      throw error;
    }
    if (data?.referral_code) return data.referral_code;

    // No row updated: either a concurrent call already set one (re-fetch and
    // use it) or something else changed - either way, check current state.
    const { data: recheck, error: recheckError } = await supabase
      .from("profiles")
      .select("referral_code")
      .eq("uid", uid)
      .single();
    if (recheckError) throw recheckError;
    if (recheck.referral_code) return recheck.referral_code;
  }
  throw new Error("Could not generate a unique referral code - please try again.");
}

// Accepts either the historical long form (a referrer's raw uid, for codes/
// links shared before short codes existed - kept working forever) or the
// newer short referral_code. Returns null if neither resolves to a real
// account.
async function resolveReferrerUid(supabase: SupabaseClient, code: string): Promise<string | null> {
  if (UUID_RE.test(code)) {
    const { data, error } = await supabase.from("profiles").select("uid").eq("uid", code).maybeSingle();
    if (error) throw error;
    return data?.uid ?? null;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("uid")
    .eq("referral_code", code.trim().toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data?.uid ?? null;
}

// Links a brand-new signup to whoever referred them. The actual relationship
// validation (no self-referral, this account hasn't already been linked)
// lives in the referral_link Postgres function so it can't be bypassed by
// calling the table directly - there's deliberately no INSERT policy on
// public.referrals for regular users. Resolving the code (short or long
// form) to a uid happens here first, since referral_link only knows uids.
export async function linkReferral(
  supabase: SupabaseClient,
  referredUid: string,
  referrerCode: string
): Promise<void> {
  const raw = (referrerCode || "").trim();
  if (!raw) throw new Error("No referral code provided.");

  const referrerUid = await resolveReferrerUid(supabase, raw);
  if (!referrerUid) throw new Error("That referral code doesn't match any account.");

  const { error } = await supabase.rpc("referral_link", {
    p_referrer_uid: referrerUid,
    p_referred_uid: referredUid,
  });
  if (error) throw new Error(error.message);
}

export type ReleasedAgreement = {
  id: string;
  buyerId: string;
  sellerId: string;
};

// Called right after an escrow agreement's overall status transitions to
// 'released' - checks whether the buyer and/or seller were themselves
// referred by someone, and pays that referrer a bonus if so (funded from
// the admin wallet - see referral_payout_process in
// project_supabase_migration_05_task29_referrals.sql). A referral payout is
// a bonus on top of a successful trade, never part of its correctness, so
// every failure here is caught and logged rather than propagated - it must
// never roll back or fail the escrow release itself.
export async function processReferralPayoutsForAgreement(
  supabase: SupabaseClient,
  agreement: ReleasedAgreement
): Promise<void> {
  let adminWalletUid: string;
  try {
    adminWalletUid = getAdminWalletUid();
  } catch {
    // ADMIN_WALLET_UID isn't configured yet - referral payouts can't be
    // funded until it is. Nothing to do, and not worth logging on every
    // single release until the admin sets one up.
    return;
  }

  const candidateUids = [...new Set([agreement.buyerId, agreement.sellerId].filter(Boolean))];

  for (const uid of candidateUids) {
    try {
      const { data, error } = await supabase.rpc("referral_payout_process", {
        p_referred_uid: uid,
        p_agreement_id: agreement.id,
        p_admin_wallet_uid: adminWalletUid,
      });
      if (error) throw error;

      const outcome = Array.isArray(data) ? data[0] : data;
      if (outcome?.paid) {
        await notifyUser(supabase, outcome.referrer_uid, {
          type: "referral_payout",
          title: "Referral bonus earned",
          body: "Someone you referred completed a trade - a referral bonus was added to your wallet.",
          relatedType: "wallet",
          relatedId: agreement.id,
        }).catch((err) => console.error("notifyUser (referral_payout) failed:", err));
      }
    } catch (err) {
      console.error(
        `Referral payout check failed for uid=${uid} agreement=${agreement.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

export type ReferralSummary = {
  referralCode: string;
  // Present only once HORIZON_APP_URL is configured (see getReferralLink) -
  // until then referralCode alone is still fully usable, just not as a
  // tap-to-open link.
  referralLink: string | null;
  maxPayoutsPerReferredUser: number;
  totalEarnedKobo: number;
  referrals: Array<{
    referredUid: string;
    referredName: string;
    createdAt: string;
    payoutCount: number;
    payoutKobo: number;
  }>;
};

// Builds a shareable https link once the app has a domain configured. Set
// HORIZON_APP_URL (e.g. "https://horizon.app") as a Supabase Edge Function
// secret when that domain exists and is wired up for app/universal links
// (assetlinks.json on Android, apple-app-site-association on iOS, plus
// app_links initialized in main.dart - none of that is set up yet, this
// just leaves the one place it needs to plug in). Until then this returns
// null and the app falls back to sharing the short code by itself, which
// already works everywhere (typed in by hand, texted, pasted).
function getReferralLink(referralCode: string): string | null {
  const base = Deno.env.get("HORIZON_APP_URL");
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/r/${referralCode}`;
}

// Everything the "My Referrals" screen needs in one call: the user's own
// short referral code (and a link built from it, once HORIZON_APP_URL is
// set), who they've referred and how many of each referred person's trades
// have paid out so far, the per-person cap, and their all-time total earned.
export async function getReferralSummary(
  supabase: SupabaseClient,
  uid: string
): Promise<ReferralSummary> {
  const referralCode = await ensureReferralCode(supabase, uid);

  const { data: settings, error: settingsError } = await supabase
    .from("platform_settings")
    .select("referral_max_payouts_per_referred_user")
    .eq("id", 1)
    .single();
  if (settingsError) throw settingsError;

  const { data: referralRows, error: referralsError } = await supabase
    .from("referrals")
    .select("id, referred_uid, created_at")
    .eq("referrer_uid", uid)
    .order("created_at", { ascending: false });
  if (referralsError) throw referralsError;

  const referredUids = (referralRows || []).map((r) => r.referred_uid);

  const [profilesResult, earningsResult] = await Promise.all([
    referredUids.length
      ? supabase.from("profiles").select("uid, name").in("uid", referredUids)
      : Promise.resolve({ data: [] as Array<{ uid: string; name: string }>, error: null }),
    supabase.from("referral_earnings").select("referral_id, amount_kobo").eq("referrer_uid", uid),
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (earningsResult.error) throw earningsResult.error;

  const nameByUid = new Map((profilesResult.data || []).map((p) => [p.uid, p.name]));
  const payoutsByReferralId = new Map<string, { count: number; kobo: number }>();
  let totalEarnedKobo = 0;
  for (const row of earningsResult.data || []) {
    totalEarnedKobo += row.amount_kobo;
    const entry = payoutsByReferralId.get(row.referral_id) || { count: 0, kobo: 0 };
    entry.count += 1;
    entry.kobo += row.amount_kobo;
    payoutsByReferralId.set(row.referral_id, entry);
  }

  const referrals = (referralRows || []).map((r) => {
    const payouts = payoutsByReferralId.get(r.id) || { count: 0, kobo: 0 };
    return {
      referredUid: r.referred_uid,
      referredName: nameByUid.get(r.referred_uid) || "Unknown",
      createdAt: r.created_at,
      payoutCount: payouts.count,
      payoutKobo: payouts.kobo,
    };
  });

  return {
    referralCode,
    referralLink: getReferralLink(referralCode),
    maxPayoutsPerReferredUser: settings.referral_max_payouts_per_referred_user,
    totalEarnedKobo,
    referrals,
  };
}
