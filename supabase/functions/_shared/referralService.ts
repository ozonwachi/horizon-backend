import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getAdminWalletUid } from "./walletLedgerService.ts";
import { notifyUser } from "./notificationService.ts";

// Links a brand-new signup to whoever referred them. The actual validation
// (no self-referral, referral code matches a real user, this account hasn't
// already been linked) lives in the referral_link Postgres function so it
// can't be bypassed by calling the table directly - there's deliberately no
// INSERT policy on public.referrals for regular users.
export async function linkReferral(
  supabase: SupabaseClient,
  referredUid: string,
  referrerCode: string
): Promise<void> {
  const referrerUid = (referrerCode || "").trim();
  if (!referrerUid) throw new Error("No referral code provided.");

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

// Everything the "My Referrals" screen needs in one call: the user's own
// referral code (just their uid), who they've referred and how many of
// each referred person's trades have paid out so far, the per-person cap,
// and their all-time total earned.
export async function getReferralSummary(
  supabase: SupabaseClient,
  uid: string
): Promise<ReferralSummary> {
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
    referralCode: uid,
    maxPayoutsPerReferredUser: settings.referral_max_payouts_per_referred_user,
    totalEarnedKobo,
    referrals,
  };
}
