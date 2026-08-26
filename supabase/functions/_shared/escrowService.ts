import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser } from "./notificationService.ts";
import { notifyAdminsOfDispute } from "./conversationService.ts";
import { recordAuditLog } from "./auditLogService.ts";
import { getAdminWalletUid } from "./walletLedgerService.ts";
import { processReferralPayoutsForAgreement } from "./referralService.ts";

const AGREEMENTS_TABLE = "escrow_agreements";
const TRANCHES_TABLE = "escrow_tranches";
const COMMISSION_TABLE = "commission_rules";
const SETTINGS_TABLE = "platform_settings";

// Fields a generic admin edit (adminUpdateAgreement) is allowed to touch.
// Status transitions have their own dedicated, invariant-preserving
// functions (markFunded, markReleased, adminResolveTranche, cancel*) and
// are deliberately excluded here.
const ADMIN_EDITABLE_FIELDS = ["amountKobo", "commissionKobo", "title", "description"] as const;
const ADMIN_FIELD_COLUMNS: Record<string, string> = {
  amountKobo: "amount_kobo",
  commissionKobo: "commission_kobo",
  title: "title",
  description: "description",
};

export const EscrowStatus = {
  PENDING_PAYMENT: "pending_payment",
  FUNDED: "funded",
  PARTIALLY_RELEASED: "partially_released", // some tranches released, some still pending
  RELEASED: "released",
  DISPUTED: "disputed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
} as const;

export const TrancheStatus = {
  PENDING: "pending",
  RELEASED: "released",
  DISPUTED: "disputed",
  REFUNDED: "refunded",
  // A tranche an admin force-cancelled with a split decision - part to the
  // buyer, part to the seller, part to the admin wallet, in any
  // combination - so neither RELEASED (100% to seller) nor REFUNDED (100%
  // to buyer) describes it accurately. The tranche's `splits` array (see
  // adminForceCancelDeal) is the actual record of where the money went.
  SETTLED: "settled",
} as const;

export const ReleaseConditionType = {
  BUYER_CONFIRMATION: "buyer_confirmation",
  TIMED_FROM_FUNDING: "timed_from_funding",
  TIMED_FROM_MILESTONE: "timed_from_milestone",
} as const;

// ---------------------------------------------------------------------------
// Row <-> wire-format mapping. The Flutter app (EscrowAgreement.fromJson /
// Tranche.fromJson) expects exactly the camelCase shape the old Firestore
// doc.data() produced, with tranches nested inside the agreement and
// releaseCondition nested inside each tranche. These two functions are the
// only place that shape gets reconstructed from Postgres' normalized
// agreements+tranches tables, so every function below can just work with
// plain JS objects like before.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function toTranche(row: any) {
  return {
    id: row.id,
    label: row.label,
    amountKobo: row.amount_kobo,
    releaseCondition: {
      type: row.release_condition_type,
      ...(row.release_after_days != null ? { releaseAfterDays: row.release_after_days } : {}),
    },
    status: row.status,
    fundedAt: row.funded_at,
    releaseEligibleAt: row.release_eligible_at,
    milestoneMarkedAt: row.milestone_marked_at,
    releasedAt: row.released_at,
    overdueFlaggedAt: row.overdue_flagged_at,
    disputeReason: row.dispute_reason,
    ...(row.admin_resolved_by
      ? {
          adminResolution: {
            by: row.admin_resolved_by,
            outcome: row.admin_resolution_outcome,
            reason: row.admin_resolution_reason,
            resolvedAt: row.admin_resolved_at,
          },
        }
      : {}),
    ...(row.splits ? { splits: row.splits } : {}),
  };
}

// deno-lint-ignore no-explicit-any
function toAgreement(row: any, trancheRows: any[]) {
  const tranches = (trancheRows || []).map(toTranche);
  return {
    id: row.id,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    type: row.type,
    category: row.category,
    referenceId: row.reference_id,
    title: row.title,
    description: row.description,
    amountKobo: row.amount_kobo,
    commissionKobo: row.commission_kobo,
    commissionRuleId: row.commission_rule_id,
    // Kept for backward compatibility with any old client reading `terms`
    // directly instead of tranches[].releaseCondition - reconstructed from
    // the single tranche when there's exactly one, same as the Firestore
    // version did.
    terms: tranches.length === 1 ? tranches[0].releaseCondition : null,
    tranches,
    nextReleaseEligibleAt: row.next_release_eligible_at,
    status: row.status,
    paystackReference: row.paystack_reference,
    paymentMethod: row.payment_method,
    cancelRequestedBy: row.cancel_requested_by,
    disputeReason: row.dispute_reason,
    releasedAt: row.released_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// deno-lint-ignore no-explicit-any
export type Agreement = any;

export async function getAgreement(supabase: SupabaseClient, agreementId: string): Promise<Agreement | null> {
  const { data: row, error } = await supabase
    .from(AGREEMENTS_TABLE)
    .select("*")
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const { data: trancheRows, error: trancheError } = await supabase
    .from(TRANCHES_TABLE)
    .select("*")
    .eq("agreement_id", agreementId)
    .order("created_at", { ascending: true });
  if (trancheError) throw trancheError;

  return toAgreement(row, trancheRows || []);
}

export async function calculateCommission(
  supabase: SupabaseClient,
  { type, category, amountKobo }: { type: string; category?: string | null; amountKobo: number }
) {
  let query = supabase.from(COMMISSION_TABLE).select("*").eq("type", type).limit(1);
  query = category ? query.eq("category", category) : query.is("category", null);
  const { data: rows, error } = await query;
  if (error) throw error;

  // No commission_rules row for this exact (type, category) - fall back to
  // the platform-wide default from platform_settings, rather than
  // silently charging 0 commission. A commission_rules row, when one
  // exists, always wins - it's the specific override, platform_settings is
  // just the floor everything else lands on.
  if (!rows || rows.length === 0) {
    const { data: settings, error: settingsError } = await supabase
      .from(SETTINGS_TABLE)
      .select("admin_commission_type, admin_commission_value")
      .eq("id", 1)
      .single();
    if (settingsError) throw settingsError;

    const commissionKobo =
      settings.admin_commission_type === "percentage"
        ? Math.round((amountKobo * settings.admin_commission_value) / 100)
        : settings.admin_commission_value;

    return { commissionKobo, rule: null as null };
  }

  const rule = rows[0];
  let commissionKobo: number;
  if (rule.mode === "percentage") {
    commissionKobo = Math.round((amountKobo * rule.value) / 100);
  } else {
    commissionKobo = rule.value;
  }
  if (rule.min_kobo != null) commissionKobo = Math.max(commissionKobo, rule.min_kobo);
  if (rule.max_kobo != null) commissionKobo = Math.min(commissionKobo, rule.max_kobo);

  return { commissionKobo, rule };
}

// Builds the tranches array for a new agreement. If the caller passes
// explicit `tranches`, they're validated and normalized. Otherwise we fall
// back to a single tranche covering the full amount, using `terms` (the
// old param) as its release condition - this is what keeps every existing
// simple buy/sell flow working unchanged. Output is already flattened to
// the column shape escrow_create_agreement's RPC expects.
// deno-lint-ignore no-explicit-any
function buildTranches({ amountKobo, tranches, terms }: { amountKobo: number; tranches?: any[]; terms?: any }) {
  if (tranches && tranches.length > 0) {
    const sum = tranches.reduce((acc, t) => acc + t.amountKobo, 0);
    if (sum !== amountKobo) {
      throw new Error(`Tranche amounts (${sum}) must sum to agreement amountKobo (${amountKobo})`);
    }

    return tranches.map((t, index) => {
      if (!t.releaseCondition || !t.releaseCondition.type) {
        throw new Error(`Tranche "${t.label || index}" is missing a releaseCondition`);
      }
      const isTimed =
        t.releaseCondition.type === ReleaseConditionType.TIMED_FROM_FUNDING ||
        t.releaseCondition.type === ReleaseConditionType.TIMED_FROM_MILESTONE;
      if (isTimed && !t.releaseCondition.releaseAfterDays) {
        throw new Error(`Tranche "${t.label || index}" has a timed release condition but no releaseAfterDays`);
      }

      return {
        label: t.label || `Tranche ${index + 1}`,
        amountKobo: t.amountKobo,
        releaseConditionType: t.releaseCondition.type,
        releaseAfterDays: t.releaseCondition.releaseAfterDays || null,
      };
    });
  }

  // Legacy / simple path - one tranche, whole amount.
  const condition = terms || { type: ReleaseConditionType.BUYER_CONFIRMATION };
  return [
    {
      label: "Full amount",
      amountKobo,
      releaseConditionType: condition.type,
      releaseAfterDays: condition.releaseAfterDays || null,
    },
  ];
}

export async function createAgreement(
  supabase: SupabaseClient,
  {
    buyerId,
    sellerId,
    type,
    category,
    amountKobo,
    terms,
    referenceId,
    title,
    description,
    tranches,
    // deno-lint-ignore no-explicit-any
  }: any
) {
  const { commissionKobo, rule } = await calculateCommission(supabase, { type, category, amountKobo });
  const builtTranches = buildTranches({ amountKobo, tranches, terms });

  const { data: agreementId, error } = await supabase.rpc("escrow_create_agreement", {
    p_buyer_id: buyerId,
    p_seller_id: sellerId,
    p_type: type,
    p_category: category || null,
    p_amount_kobo: amountKobo,
    p_commission_kobo: commissionKobo,
    p_commission_rule_id: rule ? rule.id : null,
    p_reference_id: referenceId || null,
    p_title: title || null,
    p_description: description || null,
    p_tranches: builtTranches,
  });
  if (error) throw new Error(error.message);

  const agreement = await getAgreement(supabase, agreementId);

  // Notify the other party that a deal was opened. The buyer already knows
  // (they just created it) - it's the seller who needs the heads up.
  await notifyUser(supabase, sellerId, {
    type: "escrow_opened",
    title: "New escrow deal opened",
    body: title
      ? `An escrow agreement for "${title}" was opened with you.`
      : "An escrow agreement was opened with you.",
    relatedType: "escrow",
    relatedId: agreement.id,
  }).catch((err) => console.error("notifyUser (escrow_opened) failed:", err));

  return agreement;
}

export async function markFunded(supabase: SupabaseClient, agreementId: string, paystackReference: string) {
  const { error } = await supabase.rpc("escrow_mark_funded", {
    p_agreement_id: agreementId,
    p_reference: paystackReference,
  });
  if (error) throw new Error(error.message);

  const result = await getAgreement(supabase, agreementId);

  await notifyUser(supabase, result.sellerId, {
    type: "escrow_funded",
    title: "Escrow deal funded",
    body: "The buyer has funded your escrow agreement.",
    relatedType: "escrow",
    relatedId: agreementId,
  }).catch((err) => console.error("notifyUser (escrow_funded) failed:", err));

  return result;
}

// Legacy whole-agreement release. Kept unchanged for old agreements with
// no tranches array (or exactly one, whole-amount tranche). For new
// tranche-based agreements, use confirmTrancheRelease instead.
export async function markReleased(supabase: SupabaseClient, agreementId: string) {
  const { error } = await supabase.rpc("escrow_mark_released_legacy", {
    p_agreement_id: agreementId,
  });
  if (error) throw new Error(error.message);

  const result = await getAgreement(supabase, agreementId);

  await notifyUser(supabase, result.sellerId, {
    type: "escrow_released",
    title: "Escrow funds released",
    body: "The buyer released the escrow funds to you.",
    relatedType: "escrow",
    relatedId: agreementId,
  }).catch((err) => console.error("notifyUser (escrow_released) failed:", err));

  return result;
}

// Buyer explicitly confirms a tranche (works for buyer_confirmation
// tranches, and also lets a buyer release a timed tranche early rather
// than waiting for the timer).
export async function confirmTrancheRelease(
  supabase: SupabaseClient,
  agreementId: string,
  trancheId: string,
  buyerUid: string
) {
  const before = await getAgreement(supabase, agreementId);
  if (!before) throw new Error("Agreement not found");

  const { data: rows, error } = await supabase.rpc("escrow_release_tranche", {
    p_agreement_id: agreementId,
    p_tranche_id: trancheId,
    p_buyer_uid: buyerUid,
    p_admin_uid: null,
    p_admin_reason: null,
  });
  if (error) throw new Error(error.message);
  const alreadyReleased = rows[0].already_released;

  const result = await getAgreement(supabase, agreementId);

  if (!alreadyReleased) {
    await notifyUser(supabase, before.sellerId, {
      type: "escrow_released",
      title: "Escrow tranche released",
      body: "The buyer released a tranche of escrow funds to you.",
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error("notifyUser (tranche release) failed:", err));
  }

  // A referral bonus only makes sense once the WHOLE deal is settled, not
  // per-tranche - checking the agreement-level status here (not the
  // tranche's) is what makes this fire exactly once per deal, right at the
  // moment it newly becomes fully released.
  if (before.status !== EscrowStatus.RELEASED && result.status === EscrowStatus.RELEASED) {
    processReferralPayoutsForAgreement(supabase, result).catch((err) =>
      console.error("processReferralPayoutsForAgreement failed:", err)
    );
  }

  return result;
}

// Seller marks a milestone reached (e.g. "delivered"), which starts the
// countdown for a timed_from_milestone tranche.
export async function markMilestoneReached(
  supabase: SupabaseClient,
  agreementId: string,
  trancheId: string,
  sellerUid: string
) {
  const before = await getAgreement(supabase, agreementId);
  if (!before) throw new Error("Agreement not found");

  const { error } = await supabase.rpc("escrow_mark_milestone", {
    p_agreement_id: agreementId,
    p_tranche_id: trancheId,
    p_seller_id: sellerUid,
  });
  if (error) throw new Error(error.message);

  const result = await getAgreement(supabase, agreementId);

  await notifyUser(supabase, before.buyerId, {
    type: "escrow_milestone",
    title: "Milestone reached",
    body: "The other party marked a milestone reached - a release countdown has started.",
    relatedType: "escrow",
    relatedId: agreementId,
  }).catch((err) => console.error("notifyUser (escrow_milestone) failed:", err));

  return result;
}

// Either party disputes a specific tranche. This blocks ONLY that tranche
// from releasing (auto or manual) - other tranches on the same agreement
// keep flowing normally. The agreement is flagged `disputed` at the top
// level so it surfaces in an admin queue; resolve via adminResolveTranche.
export async function disputeTranche(
  supabase: SupabaseClient,
  agreementId: string,
  trancheId: string,
  reason: string | null,
  actorUid: string
) {
  const before = await getAgreement(supabase, agreementId);
  if (!before) throw new Error("Agreement not found");
  const otherPartyId = before.buyerId === actorUid ? before.sellerId : before.buyerId;

  const { error } = await supabase.rpc("escrow_dispute_tranche", {
    p_agreement_id: agreementId,
    p_tranche_id: trancheId,
    p_actor_id: actorUid,
    p_reason: reason || null,
  });
  if (error) throw new Error(error.message);

  const result = await getAgreement(supabase, agreementId);

  if (otherPartyId) {
    await notifyUser(supabase, otherPartyId, {
      type: "escrow_disputed",
      title: "Escrow tranche disputed",
      body: reason ? `A tranche was disputed: ${reason}` : "A tranche on your escrow agreement was disputed.",
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error("notifyUser (escrow_disputed) failed:", err));
  }

  await notifyAdminsOfDispute(supabase, { agreementId, reason }).catch((err) =>
    console.error("notifyAdminsOfDispute failed:", err)
  );

  return result;
}

// Minimal admin resolution path so a disputed tranche isn't a dead end.
// outcome: "release" credits the seller as normal; "refund" credits the
// buyer's wallet instead and marks the tranche refunded. Full admin
// authentication/authorization is the route's job (requireAdmin) - this
// function assumes the caller has already verified the actor is an admin.
export async function adminResolveTranche(
  supabase: SupabaseClient,
  agreementId: string,
  trancheId: string,
  outcome: "release" | "refund",
  adminUid: string | null,
  reason: string | null
) {
  const before = await getAgreement(supabase, agreementId);
  if (!before) throw new Error("Agreement not found");
  // deno-lint-ignore no-explicit-any
  const beforeTranche = before.tranches.find((t: any) => t.id === trancheId);
  if (!beforeTranche) throw new Error("Tranche not found");
  const previousTrancheStatus = beforeTranche.status;

  let result: Agreement;
  if (outcome === "release") {
    const { error } = await supabase.rpc("escrow_release_tranche", {
      p_agreement_id: agreementId,
      p_tranche_id: trancheId,
      p_buyer_uid: null,
      p_admin_uid: adminUid,
      p_admin_reason: reason || null,
    });
    if (error) throw new Error(error.message);
    result = await getAgreement(supabase, agreementId);

    // See the matching comment in confirmTrancheRelease. An admin-driven
    // release (resolving a dispute in the seller's favor) can just as
    // validly complete a deal as a buyer-driven one.
    if (before.status !== EscrowStatus.RELEASED && result.status === EscrowStatus.RELEASED) {
      processReferralPayoutsForAgreement(supabase, result).catch((err) =>
        console.error("processReferralPayoutsForAgreement failed:", err)
      );
    }
  } else if (outcome === "refund") {
    const { error } = await supabase.rpc("escrow_refund_tranche", {
      p_agreement_id: agreementId,
      p_tranche_id: trancheId,
      p_admin_uid: adminUid,
      p_admin_reason: reason || null,
    });
    if (error) throw new Error(error.message);
    result = await getAgreement(supabase, agreementId);
  } else {
    throw new Error(`Unknown outcome "${outcome}"`);
  }

  const notifyTargets: string[] =
    outcome === "refund" ? [before.buyerId] : [before.sellerId, before.buyerId].filter(Boolean);
  await Promise.all(
    notifyTargets.map((uid) =>
      notifyUser(supabase, uid, {
        type: "escrow_dispute_resolved",
        title: "Escrow dispute resolved",
        body:
          outcome === "refund"
            ? "An admin resolved your dispute and issued a refund."
            : "An admin resolved the dispute and released the tranche to the seller.",
        relatedType: "escrow",
        relatedId: agreementId,
      }).catch((err) => console.error("notifyUser (dispute resolved) failed:", err))
    )
  );

  if (adminUid) {
    const recipientUid = outcome === "refund" ? before.buyerId : before.sellerId;
    const recipientRole = outcome === "refund" ? "buyer" : "seller";
    await recordAuditLog(supabase, {
      userId: adminUid,
      action: "escrow_dispute_resolved",
      targetType: "escrowTranche",
      targetId: `${agreementId}/${trancheId}`,
      agreementId,
      previousValue: { status: previousTrancheStatus },
      newValue: {
        status: outcome === "refund" ? TrancheStatus.REFUNDED : TrancheStatus.RELEASED,
        trancheLabel: beforeTranche.label,
        amountKobo: beforeTranche.amountKobo,
        recipientUid,
        recipientRole,
      },
      reason: reason || outcome,
    }).catch((err) => console.error("recordAuditLog (dispute resolved) failed:", err));
  }

  return result;
}

// Admin dashboard "browse everything" list - unlike listForUser, this is
// NOT scoped to a buyer/seller and is meant to be called only from a route
// already protected by requireAdmin. Optional `status` filters to one
// EscrowStatus value (e.g. "disputed" to triage what needs attention
// first).
export async function listAllAgreements(
  supabase: SupabaseClient,
  { status, limit = 100 }: { status?: string; limit?: number } = {}
): Promise<Agreement[]> {
  let query = supabase
    .from(AGREEMENTS_TABLE)
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(Math.min(limit, 500));
  if (status) {
    query = query.eq("status", status);
  }
  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const { data: trancheRows, error: trancheError } = await supabase
    .from(TRANCHES_TABLE)
    .select("*")
    .in(
      "agreement_id",
      rows.map((r) => r.id)
    )
    .order("created_at", { ascending: true });
  if (trancheError) throw trancheError;

  // deno-lint-ignore no-explicit-any
  const tranchesByAgreement = new Map<string, any[]>();
  for (const t of trancheRows || []) {
    if (!tranchesByAgreement.has(t.agreement_id)) tranchesByAgreement.set(t.agreement_id, []);
    tranchesByAgreement.get(t.agreement_id)!.push(t);
  }

  return rows.map((row) => toAgreement(row, tranchesByAgreement.get(row.id) || []));
}

// Cron entrypoint. IMPORTANT: this does NOT release funds - money only
// ever moves when the buyer explicitly confirms, via confirmTrancheRelease
// (even after a timer has fully expired, the buyer still has to tap
// "release"). What this DOES do is find tranches whose window has passed
// and are still sitting unreleased, and stamp them so the app/
// notifications layer can prompt the buyer. No wallet writes happen here.
export async function flagOverdueTranches(supabase: SupabaseClient) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from(TRANCHES_TABLE)
    .update({ overdue_flagged_at: nowIso })
    .eq("status", TrancheStatus.PENDING)
    .lte("release_eligible_at", nowIso)
    .is("overdue_flagged_at", null)
    .select("id, agreement_id");

  if (error) {
    return { checked: 0, flagged: 0, errors: [{ message: error.message }] };
  }
  return { checked: (data || []).length, flagged: (data || []).length, errors: [] as Array<{ message: string }> };
}

export async function markDisputed(
  supabase: SupabaseClient,
  agreementId: string,
  reason: string | null,
  actorUid: string | null
) {
  const { data: row, error } = await supabase
    .from(AGREEMENTS_TABLE)
    .update({ status: EscrowStatus.DISPUTED, dispute_reason: reason || null, updated_at: new Date().toISOString() })
    .eq("id", agreementId)
    .select("*")
    .single();
  if (error) throw error;

  const otherPartyId =
    actorUid && row.buyer_id === actorUid
      ? row.seller_id
      : actorUid && row.seller_id === actorUid
        ? row.buyer_id
        : null;
  if (otherPartyId) {
    await notifyUser(supabase, otherPartyId, {
      type: "escrow_disputed",
      title: "Escrow agreement disputed",
      body: reason ? `Your escrow agreement was disputed: ${reason}` : "Your escrow agreement was disputed.",
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error("notifyUser (escrow_disputed) failed:", err));
  }

  await notifyAdminsOfDispute(supabase, { agreementId, reason }).catch((err) =>
    console.error("notifyAdminsOfDispute failed:", err)
  );

  return getAgreement(supabase, agreementId);
}

export async function payFromWallet(supabase: SupabaseClient, agreementId: string, buyerUid: string) {
  const { error } = await supabase.rpc("escrow_pay_from_wallet", {
    p_agreement_id: agreementId,
    p_buyer_id: buyerUid,
  });
  if (error) throw new Error(error.message);

  const result = await getAgreement(supabase, agreementId);

  await notifyUser(supabase, result.sellerId, {
    type: "escrow_funded",
    title: "Escrow deal funded",
    body: "The buyer funded your escrow agreement from their wallet.",
    relatedType: "escrow",
    relatedId: agreementId,
  }).catch((err) => console.error("notifyUser (escrow_funded) failed:", err));

  return result;
}

export async function listForUser(supabase: SupabaseClient, uid: string): Promise<Agreement[]> {
  const { data: rows, error } = await supabase
    .from(AGREEMENTS_TABLE)
    .select("*")
    .or(`buyer_id.eq.${uid},seller_id.eq.${uid}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const { data: trancheRows, error: trancheError } = await supabase
    .from(TRANCHES_TABLE)
    .select("*")
    .in(
      "agreement_id",
      rows.map((r) => r.id)
    )
    .order("created_at", { ascending: true });
  if (trancheError) throw trancheError;

  // deno-lint-ignore no-explicit-any
  const tranchesByAgreement = new Map<string, any[]>();
  for (const t of trancheRows || []) {
    if (!tranchesByAgreement.has(t.agreement_id)) tranchesByAgreement.set(t.agreement_id, []);
    tranchesByAgreement.get(t.agreement_id)!.push(t);
  }

  return rows.map((row) => toAgreement(row, tranchesByAgreement.get(row.id) || []));
}

// Buyer can cancel unilaterally before the deal is funded; once funded (or
// partially released), cancelling requires both parties to agree -
// whoever calls this first "requests" the cancellation, and the other
// party's call to this same function confirms it and actually unwinds the
// deal, refunding any still-unreleased tranche funds back to the buyer's
// wallet. Already-released tranches are not clawed back.
export async function requestOrConfirmCancel(supabase: SupabaseClient, agreementId: string, actorUid: string) {
  const { data: rows, error } = await supabase.rpc("escrow_request_or_confirm_cancel", {
    p_agreement_id: agreementId,
    p_actor_id: actorUid,
  });
  if (error) throw new Error(error.message);
  const { other_party_id: otherPartyId, notify_kind: notifyKind } = rows[0];

  const result = await getAgreement(supabase, agreementId);

  const NOTIFY_COPY: Record<string, { type: string; title: string; body: string }> = {
    cancelled_unfunded: {
      type: "escrow_cancelled",
      title: "Escrow deal cancelled",
      body: "The buyer cancelled this escrow agreement before it was funded.",
    },
    requested: {
      type: "escrow_cancel_requested",
      title: "Cancellation requested",
      body: "The other party requested to cancel this funded escrow agreement. Confirm to proceed.",
    },
    confirmed: {
      type: "escrow_cancelled",
      title: "Escrow deal cancelled",
      body: "Both parties confirmed cancellation - any unreleased funds have been refunded to the buyer.",
    },
  };
  const notify = NOTIFY_COPY[notifyKind];
  if (notify && otherPartyId) {
    await notifyUser(supabase, otherPartyId, {
      type: notify.type,
      title: notify.title,
      body: notify.body,
      relatedType: "escrow",
      relatedId: agreementId,
    }).catch((err) => console.error(`notifyUser (${notify.type}) failed:`, err));
  }

  return result;
}

// Generic admin override so an admin can correct escrow metadata
// (amount/commission/title/description) for exceptional cases the normal
// flows don't cover. Every call must include a reason and is written to
// the audit log. Blocked once the agreement is settled (released/
// refunded/cancelled) to avoid silently desyncing amountKobo from
// tranches that already reflect a different total.
export async function adminUpdateAgreement(
  supabase: SupabaseClient,
  agreementId: string,
  adminUid: string,
  // deno-lint-ignore no-explicit-any
  changes: any,
  reason: string
) {
  if (!reason) throw new Error("reason is required for an admin edit");

  const current = await getAgreement(supabase, agreementId);
  if (!current) throw new Error("Agreement not found");

  const EDIT_BLOCKED_STATUSES: string[] = [EscrowStatus.RELEASED, EscrowStatus.REFUNDED, EscrowStatus.CANCELLED];
  const editingMoney = "amountKobo" in changes || "commissionKobo" in changes;
  if (editingMoney && EDIT_BLOCKED_STATUSES.includes(current.status)) {
    throw new Error(`Cannot edit amounts on an agreement with status "${current.status}"`);
  }

  // deno-lint-ignore no-explicit-any
  const columnUpdate: Record<string, any> = {};
  // deno-lint-ignore no-explicit-any
  const previousValue: Record<string, any> = {};
  // deno-lint-ignore no-explicit-any
  const newValue: Record<string, any> = {};
  for (const field of ADMIN_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes, field)) {
      columnUpdate[ADMIN_FIELD_COLUMNS[field]] = changes[field];
      previousValue[field] = current[field] ?? null;
      newValue[field] = changes[field];
    }
  }
  if (Object.keys(columnUpdate).length === 0) {
    throw new Error("No editable fields provided");
  }
  columnUpdate.updated_at = new Date().toISOString();

  const { error } = await supabase.from(AGREEMENTS_TABLE).update(columnUpdate).eq("id", agreementId);
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "escrow_admin_update",
    targetType: "escrowAgreement",
    targetId: agreementId,
    agreementId,
    previousValue,
    newValue,
    reason,
  });

  await Promise.all(
    [current.buyerId, current.sellerId]
      .filter(Boolean)
      .map((uid: string) =>
        notifyUser(supabase, uid, {
          type: "escrow_admin_update",
          title: "Escrow agreement updated by admin",
          body: `An admin updated this agreement: ${reason}`,
          relatedType: "escrow",
          relatedId: agreementId,
        }).catch((err) => console.error("notifyUser (escrow_admin_update) failed:", err))
      )
  );

  return getAgreement(supabase, agreementId);
}

// Fields adminUpdateTranche is allowed to touch. Deliberately excludes
// releaseCondition (timing) and status - status changes go through the
// dedicated release/refund functions above so wallet balances always stay
// consistent with the tranche's recorded status.
const TRANCHE_ADMIN_EDITABLE_FIELDS = ["amountKobo", "label"] as const;

// Admin-only: edits a single tranche's amount/label. Only allowed while
// the tranche is still PENDING - once it's released or refunded, real
// money has already moved, and once it's disputed, the intended path is
// to resolve it (adminResolveTranche) or fold it into an
// adminForceCancelDeal decision, not silently rewrite its numbers. The
// update itself is conditioned on status = 'pending' at the database
// level too (not just this function's earlier read), so a concurrent
// status change can't slip through.
export async function adminUpdateTranche(
  supabase: SupabaseClient,
  agreementId: string,
  trancheId: string,
  adminUid: string,
  // deno-lint-ignore no-explicit-any
  changes: any,
  reason: string
) {
  if (!reason || !reason.trim()) {
    throw new Error("A reason is required for an admin tranche edit");
  }

  // deno-lint-ignore no-explicit-any
  const filteredChanges: Record<string, any> = {};
  for (const field of TRANCHE_ADMIN_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes || {}, field)) {
      filteredChanges[field] = changes[field];
    }
  }
  if (Object.keys(filteredChanges).length === 0) {
    throw new Error("No editable fields provided");
  }

  const { data: existing, error: fetchError } = await supabase
    .from(TRANCHES_TABLE)
    .select("*")
    .eq("id", trancheId)
    .eq("agreement_id", agreementId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!existing) throw new Error("Tranche not found");
  if (existing.status !== TrancheStatus.PENDING) {
    throw new Error(`Cannot edit a tranche with status "${existing.status}" - only pending tranches can be edited`);
  }

  const previousValue = { amountKobo: existing.amount_kobo, label: existing.label };
  // deno-lint-ignore no-explicit-any
  const columnUpdate: Record<string, any> = {};
  if ("amountKobo" in filteredChanges) columnUpdate.amount_kobo = filteredChanges.amountKobo;
  if ("label" in filteredChanges) columnUpdate.label = filteredChanges.label;

  const { data: updatedRows, error: updateError } = await supabase
    .from(TRANCHES_TABLE)
    .update(columnUpdate)
    .eq("id", trancheId)
    .eq("status", TrancheStatus.PENDING)
    .select("id");
  if (updateError) throw updateError;
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error(`Cannot edit a tranche with status "${existing.status}" - only pending tranches can be edited`);
  }

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "escrow_tranche_edited",
    targetType: "escrowTranche",
    targetId: `${agreementId}/${trancheId}`,
    agreementId,
    previousValue,
    newValue: filteredChanges,
    reason,
  }).catch((err) => console.error("recordAuditLog (tranche edited) failed:", err));

  return getAgreement(supabase, agreementId);
}

// Statuses a deal must be in for adminForceCancelDeal to make sense -
// money actually exists to move (funded), and the deal hasn't already
// fully settled one way or another.
const FORCE_CANCELLABLE_STATUSES: string[] = [
  EscrowStatus.FUNDED,
  EscrowStatus.PARTIALLY_RELEASED,
  EscrowStatus.DISPUTED,
];

// Turns one tranche's decision into a validated splits array of
// { recipient: "buyer" | "seller" | "admin_wallet", amountKobo }. Accepts
// the plain "release"/"refund" string (the common case - all of it to one
// side) alongside an actual array (the admin chose to split it), so the
// simple case stays a one-line decision while a genuinely mixed outcome is
// still expressible. Every kobo of the tranche must be accounted for -
// deliberately no silent remainder and no default "leftover goes to
// admin_wallet": the admin has to say where every part of it goes.
// deno-lint-ignore no-explicit-any
function normalizeForceCancelDecision(tranche: any, decision: any) {
  // deno-lint-ignore no-explicit-any
  let splits: any[];
  if (decision === "release") {
    splits = [{ recipient: "seller", amountKobo: tranche.amountKobo }];
  } else if (decision === "refund") {
    splits = [{ recipient: "buyer", amountKobo: tranche.amountKobo }];
  } else if (Array.isArray(decision) && decision.length > 0) {
    splits = decision;
  } else {
    throw new Error(`Invalid decision for tranche "${tranche.label || tranche.id}"`);
  }

  const validRecipients = ["buyer", "seller", "admin_wallet"];
  let sum = 0;
  for (const split of splits) {
    if (!validRecipients.includes(split && split.recipient)) {
      throw new Error(
        `Invalid split recipient for tranche "${tranche.label || tranche.id}" - must be buyer, seller, or admin_wallet`
      );
    }
    if (!Number.isInteger(split.amountKobo) || split.amountKobo <= 0) {
      throw new Error(`Split amounts must be positive whole numbers (tranche "${tranche.label || tranche.id}")`);
    }
    sum += split.amountKobo;
  }
  if (sum !== tranche.amountKobo) {
    throw new Error(
      `Split amounts for tranche "${tranche.label || tranche.id}" total ${sum} kobo but the ` +
        `tranche is ${tranche.amountKobo} kobo - every kobo has to be accounted for, with ` +
        "nothing created or lost"
    );
  }

  return splits;
}

// Admin-only: ends a deal immediately, without needing both parties to
// mutually confirm and without requiring a formal dispute first.
// `decisions` is { [trancheId]: "release" | "refund" | Split[] } and MUST
// cover every tranche still PENDING or DISPUTED on the agreement. Tranches
// already RELEASED or REFUNDED are left untouched. No cap on the amount
// this can move; the Flutter app is expected to show a clear confirmation
// before calling this, since it's irreversible.
export async function adminForceCancelDeal(
  supabase: SupabaseClient,
  agreementId: string,
  adminUid: string,
  // deno-lint-ignore no-explicit-any
  decisions: Record<string, any>,
  reason: string
) {
  if (!reason || !reason.trim()) {
    throw new Error("A reason is required to force-cancel a deal");
  }

  const agreement = await getAgreement(supabase, agreementId);
  if (!agreement) throw new Error("Agreement not found");
  if (!FORCE_CANCELLABLE_STATUSES.includes(agreement.status)) {
    throw new Error(
      `Cannot force-cancel from status "${agreement.status}" - either nothing has been funded yet, or the deal has already fully settled`
    );
  }

  const openTranches = agreement.tranches.filter(
    // deno-lint-ignore no-explicit-any
    (t: any) => t.status === TrancheStatus.PENDING || t.status === TrancheStatus.DISPUTED
  );
  // deno-lint-ignore no-explicit-any
  const missing = openTranches.filter((t: any) => !(decisions || {})[t.id]);
  if (missing.length > 0) {
    // deno-lint-ignore no-explicit-any
    throw new Error(`Missing a decision for tranche(s): ${missing.map((t: any) => t.label || t.id).join(", ")}`);
  }

  // deno-lint-ignore no-explicit-any
  const actionsSummary: any[] = [];
  let usesAdminWallet = false;
  // deno-lint-ignore no-explicit-any
  const trancheSplits = openTranches.map((tranche: any) => {
    const splits = normalizeForceCancelDecision(tranche, decisions[tranche.id]);
    for (const split of splits) {
      if (split.recipient === "admin_wallet") usesAdminWallet = true;
      actionsSummary.push({
        trancheId: tranche.id,
        trancheLabel: tranche.label,
        outcome: split.recipient === "seller" ? "release" : split.recipient === "buyer" ? "refund" : "admin_wallet",
        amountKobo: split.amountKobo,
        recipientUid:
          split.recipient === "seller"
            ? agreement.sellerId
            : split.recipient === "buyer"
              ? agreement.buyerId
              : null, // filled in below once we know the admin wallet uid
        recipientRole: split.recipient,
      });
    }
    return { trancheId: tranche.id, splits };
  });

  const adminWalletUid = usesAdminWallet ? getAdminWalletUid() : null;
  if (usesAdminWallet) {
    for (const action of actionsSummary) {
      if (action.recipientRole === "admin_wallet") action.recipientUid = adminWalletUid;
    }
  }

  const { error } = await supabase.rpc("escrow_admin_force_cancel", {
    p_agreement_id: agreementId,
    p_admin_uid: adminUid,
    p_reason: reason,
    p_admin_wallet_uid: adminWalletUid,
    p_tranche_splits: trancheSplits,
  });
  if (error) throw new Error(error.message);

  const result = await getAgreement(supabase, agreementId);

  await Promise.all(
    [agreement.buyerId, agreement.sellerId]
      .filter(Boolean)
      .map((uid: string) =>
        notifyUser(supabase, uid, {
          type: "escrow_force_cancelled",
          title: "Escrow deal closed by admin",
          body: `An admin ended this deal: ${reason}`,
          relatedType: "escrow",
          relatedId: agreementId,
        }).catch((err) => console.error("notifyUser (force cancelled) failed:", err))
      )
  );

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "escrow_force_cancelled",
    targetType: "escrowAgreement",
    targetId: agreementId,
    agreementId,
    previousValue: { status: agreement.status },
    newValue: { status: EscrowStatus.CANCELLED, decisions: actionsSummary },
    reason,
  }).catch((err) => console.error("recordAuditLog (force cancelled) failed:", err));

  return result;
}
