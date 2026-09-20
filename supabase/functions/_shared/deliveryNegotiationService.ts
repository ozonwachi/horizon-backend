import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser } from "./notificationService.ts";
import { calculateCommission, createAgreement, getAgreement, requestOrConfirmCancel } from "./escrowService.ts";
import { enrichOne, formatNaira, getDeliveryOrThrow, getDeliveryPaymentStatus } from "./logisticsService.ts";

// The price negotiation behind an in-app delivery - see migration_40's doc
// comment for the whole flow. Kept apart from logisticsService.ts because it
// needs escrowService (commission, creating the separate delivery deal,
// cancelling an unpaid one), and escrowService already imports
// logisticsService - one-directional imports keep that from becoming a cycle.
//
// Nothing here ever touches money until BOTH sides have agreed a price, and
// even then it only creates/attaches an UNPAID amount - the buyer's own
// payment (and, later, own confirmation) is what actually moves anything.

const DELIVERIES_TABLE = "deliveries";
const OFFERS_TABLE = "delivery_offers";

// Statuses that still count as "this deal has a delivery arranged" - a new
// request is only allowed once the previous one was declined or turned off.
const DEAD_STATUSES = ["rejected", "cancelled"];

type Role = "buyer" | "partner";

function parseAmountKobo(value: unknown): number {
  const kobo = Math.round(Number(value));
  if (!Number.isFinite(kobo) || kobo <= 0) throw new Error("Enter a valid amount");
  return kobo;
}

// deno-lint-ignore no-explicit-any
function roleOf(row: any, uid: string): Role {
  if (uid === row.buyer_id) return "buyer";
  if (uid === row.partner_id) return "partner";
  throw new Error("Not your delivery");
}

async function displayName(supabase: SupabaseClient, uid: string): Promise<string> {
  const { data } = await supabase.from("profiles").select("name").eq("uid", uid).maybeSingle();
  return data?.name || "Someone";
}

async function partnerName(supabase: SupabaseClient, uid: string): Promise<string> {
  const { data } = await supabase
    .from("logistics_partner_applications")
    .select("company_name")
    .eq("applicant_uid", uid)
    .eq("status", "approved")
    .maybeSingle();
  return data?.company_name || (await displayName(supabase, uid));
}

// deno-lint-ignore no-explicit-any
async function currentPendingOffer(supabase: SupabaseClient, deliveryId: string): Promise<any> {
  const { data, error } = await supabase
    .from(OFFERS_TABLE)
    .select("*")
    .eq("delivery_id", deliveryId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
}

async function notify(
  supabase: SupabaseClient,
  uid: string,
  payload: { title: string; body: string; relatedType: "escrow" | "delivery"; relatedId: string; important?: boolean }
) {
  await notifyUser(supabase, uid, { type: "delivery_offer", ...payload }).catch((err) =>
    console.error("notifyUser (delivery negotiation) failed:", err)
  );
}

// The buyer picks a partner and opens the negotiation with a first offer.
// Available while the item deal is unpaid AND after it's paid (as long as
// there's still something left to deliver) - which one it turns out to be
// decides how the agreed price is charged, see applyAgreedPrice.
export async function requestDelivery(
  supabase: SupabaseClient,
  buyerUid: string,
  input: { agreementId: string; partnerId: string; amountKobo: unknown; note?: string }
) {
  const amountKobo = parseAmountKobo(input.amountKobo);
  if (!input.agreementId || !input.partnerId) throw new Error("agreementId and partnerId are required");

  const agreement = await getAgreement(supabase, input.agreementId);
  if (!agreement) throw new Error("Deal not found");
  if (agreement.buyerId !== buyerUid) throw new Error("Only the buyer can arrange delivery");
  if (agreement.type === "delivery") throw new Error("A delivery payment can't have its own delivery");
  if (!["pending_payment", "funded", "partially_released"].includes(agreement.status)) {
    throw new Error("Delivery can't be added to this deal anymore");
  }
  // deno-lint-ignore no-explicit-any
  const hasOpenItem = (agreement.tranches || []).some((t: any) => (t.trancheType ?? "item") === "item" && t.status === "pending");
  if (!hasOpenItem) throw new Error("This deal has nothing left to deliver");
  if (input.partnerId === agreement.sellerId || input.partnerId === buyerUid) {
    throw new Error("Choose a different delivery partner");
  }

  const { data: partnerProfile, error: partnerError } = await supabase
    .from("profiles")
    .select("uid,is_logistics_partner")
    .eq("uid", input.partnerId)
    .maybeSingle();
  if (partnerError) throw partnerError;
  if (!partnerProfile?.is_logistics_partner) throw new Error("That delivery partner isn't available");

  const { data: existing, error: existingError } = await supabase
    .from(DELIVERIES_TABLE)
    .select("id,status")
    .eq("agreement_id", input.agreementId)
    .not("status", "in", `(${DEAD_STATUSES.join(",")})`)
    .limit(1);
  if (existingError) throw existingError;
  if (existing && existing.length > 0) throw new Error("This deal already has an in-app delivery arranged");

  const { data: row, error } = await supabase
    .from(DELIVERIES_TABLE)
    .insert({
      agreement_id: input.agreementId,
      seller_id: agreement.sellerId,
      buyer_id: buyerUid,
      partner_id: input.partnerId,
      status: "negotiating",
    })
    .select("*")
    .single();
  if (error) throw error;

  const { error: offerError } = await supabase.from(OFFERS_TABLE).insert({
    delivery_id: row.id,
    offered_by: buyerUid,
    offered_by_role: "buyer",
    amount_kobo: amountKobo,
    note: input.note?.trim() || null,
  });
  if (offerError) {
    await supabase.from(DELIVERIES_TABLE).delete().eq("id", row.id);
    throw offerError;
  }

  const buyerName = await displayName(supabase, buyerUid);
  await notify(supabase, input.partnerId, {
    title: "New delivery request",
    body: `${buyerName} offered ${formatNaira(amountKobo)} to deliver "${agreement.title || "an item"}". Accept, counter, or decline.`,
    relatedType: "delivery",
    relatedId: row.id,
    important: true,
  });
  await notify(supabase, agreement.sellerId, {
    title: "Delivery being arranged",
    body: `The buyer is arranging in-app delivery for "${agreement.title || "your deal"}".`,
    relatedType: "escrow",
    relatedId: input.agreementId,
  });

  return enrichOne(supabase, row);
}

// Either side replies to the current offer with a different price. Only the
// party who did NOT make the current offer may reply to it - you can't
// counter yourself.
export async function counterOffer(
  supabase: SupabaseClient,
  deliveryId: string,
  actorUid: string,
  amountKobo: unknown,
  note?: string
) {
  const amount = parseAmountKobo(amountKobo);
  const row = await getDeliveryOrThrow(supabase, deliveryId);
  const role = roleOf(row, actorUid);
  if (row.status !== "negotiating") throw new Error("This delivery isn't being negotiated anymore");

  const current = await currentPendingOffer(supabase, deliveryId);
  if (!current) throw new Error("There's no open offer to reply to");
  if (current.offered_by_role === role) throw new Error("Waiting for the other side to reply to your offer");

  const { error: markError } = await supabase.from(OFFERS_TABLE).update({ status: "countered" }).eq("id", current.id);
  if (markError) throw markError;
  const { error: insertError } = await supabase.from(OFFERS_TABLE).insert({
    delivery_id: deliveryId,
    offered_by: actorUid,
    offered_by_role: role,
    amount_kobo: amount,
    note: note?.trim() || null,
  });
  if (insertError) throw insertError;
  await supabase.from(DELIVERIES_TABLE).update({ updated_at: new Date().toISOString() }).eq("id", deliveryId);

  const otherUid = role === "buyer" ? row.partner_id : row.buyer_id;
  const actorName = role === "buyer" ? await displayName(supabase, actorUid) : await partnerName(supabase, actorUid);
  await notify(supabase, otherUid, {
    title: "New delivery price offer",
    body: `${actorName} countered with ${formatNaira(amount)}.`,
    relatedType: role === "buyer" ? "delivery" : "escrow",
    relatedId: role === "buyer" ? deliveryId : row.agreement_id,
    important: true,
  });

  return enrichOne(supabase, row);
}

// Turns the agreed price into an actual amount owed. Two shapes, chosen by
// whether the buyer has already paid the item deal (see migration_40):
//  - not yet paid  -> a 'logistics' tranche on that same deal, so it's still
//    ONE payment, with delivery and seller money in separate tranches;
//  - already paid  -> a separate 'delivery' deal (buyer -> partner) the buyer
//    pays on its own.
// The tranche route re-checks under a row lock, so a payment landing at the
// same moment falls through to the separate-deal route instead of failing.
// deno-lint-ignore no-explicit-any
async function applyAgreedPrice(supabase: SupabaseClient, row: any, agreedKobo: number) {
  const agreement = await getAgreement(supabase, row.agreement_id);
  if (!agreement) throw new Error("Deal not found");
  if (!["pending_payment", "funded", "partially_released"].includes(agreement.status)) {
    throw new Error("This deal is already closed, so delivery can't be added to it.");
  }
  const partner = await partnerName(supabase, row.partner_id);
  const nowIso = new Date().toISOString();

  let update: Record<string, unknown> | null = null;

  if (agreement.status === "pending_payment") {
    const { commissionKobo } = await calculateCommission(supabase, {
      type: agreement.type,
      category: agreement.category,
      amountKobo: agreement.amountKobo + agreedKobo,
    });
    const { data: trancheId, error } = await supabase.rpc("escrow_add_delivery_tranche", {
      p_agreement_id: row.agreement_id,
      p_partner_uid: row.partner_id,
      p_amount_kobo: agreedKobo,
      p_new_commission_kobo: commissionKobo,
      p_label: `Delivery fee - ${partner}`,
    });
    if (!error) {
      const { data: tranche, error: trancheError } = await supabase
        .from("escrow_tranches")
        .select("id,linked_item_tranche_id")
        .eq("id", trancheId)
        .single();
      if (trancheError) throw trancheError;
      update = { logistics_tranche_id: tranche.id, item_tranche_id: tranche.linked_item_tranche_id };
    } else if (!String(error.message).startsWith("DELIVERY_NOT_ADDABLE")) {
      throw new Error(error.message);
    }
  }

  if (!update) {
    const deliveryDeal = await createAgreement(supabase, {
      buyerId: row.buyer_id,
      sellerId: row.partner_id,
      type: "delivery",
      category: null,
      amountKobo: agreedKobo,
      referenceId: row.agreement_id,
      title: `Delivery: ${agreement.title || "your order"}`,
      description: `Delivery by ${partner} for "${agreement.title || "your order"}".`,
      terms: { type: "buyer_confirmation" },
    });
    update = { delivery_agreement_id: deliveryDeal.id };
  }

  const { data: updated, error: updateError } = await supabase
    .from(DELIVERIES_TABLE)
    .update({ ...update, status: "accepted", accepted_at: nowIso, agreed_amount_kobo: agreedKobo, updated_at: nowIso })
    .eq("id", row.id)
    .select("*")
    .single();
  if (updateError) throw updateError;
  return updated;
}

// Accepting the current offer - the other side's latest number becomes the
// agreed price.
export async function acceptCurrentOffer(supabase: SupabaseClient, deliveryId: string, actorUid: string) {
  const row = await getDeliveryOrThrow(supabase, deliveryId);
  const role = roleOf(row, actorUid);
  if (row.status !== "negotiating") throw new Error("This delivery isn't being negotiated anymore");

  const current = await currentPendingOffer(supabase, deliveryId);
  if (!current) throw new Error("There's no open offer to accept");
  if (current.offered_by_role === role) throw new Error("You can't accept your own offer - wait for the other side");

  const updated = await applyAgreedPrice(supabase, row, current.amount_kobo);
  await supabase.from(OFFERS_TABLE).update({ status: "accepted" }).eq("id", current.id);

  const dto = await enrichOne(supabase, updated);
  const price = formatNaira(current.amount_kobo);
  // Where the buyer goes to pay: the item deal itself when the price was
  // added to it, or the separate delivery deal.
  const buyerTarget = dto.mode === "separate" ? dto.deliveryAgreementId : row.agreement_id;

  if (role === "partner") {
    await notify(supabase, row.buyer_id, {
      title: "Delivery price agreed",
      body:
        dto.mode === "separate"
          ? `${dto.partnerName} accepted ${price}. Pay it to start your delivery.`
          : `${dto.partnerName} accepted ${price}. It's added to your deal as its own tranche - pay the deal to start the delivery.`,
      relatedType: "escrow",
      relatedId: buyerTarget,
      important: true,
    });
  } else {
    await notify(supabase, row.partner_id, {
      title: "Delivery price agreed",
      body: `${dto.buyerName} accepted ${price}. You can start once they've paid.`,
      relatedType: "delivery",
      relatedId: deliveryId,
      important: true,
    });
  }
  await notify(supabase, row.seller_id, {
    title: "Delivery arranged",
    body: `In-app delivery for "${dto.deal?.title || "your deal"}" was agreed at ${price}.`,
    relatedType: "escrow",
    relatedId: row.agreement_id,
  });

  return dto;
}

// The partner turning a request down while it's still being negotiated. The
// buyer can then pick someone else.
export async function declineDelivery(supabase: SupabaseClient, deliveryId: string, partnerUid: string, reason?: string) {
  const row = await getDeliveryOrThrow(supabase, deliveryId);
  if (row.partner_id !== partnerUid) throw new Error("Not your delivery");
  if (row.status !== "negotiating") throw new Error("This request can't be declined anymore");

  const current = await currentPendingOffer(supabase, deliveryId);
  if (current) await supabase.from(OFFERS_TABLE).update({ status: "declined" }).eq("id", current.id);

  const { data: updated, error } = await supabase
    .from(DELIVERIES_TABLE)
    .update({ status: "rejected", rejection_reason: reason?.trim() || null, updated_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .select("*")
    .single();
  if (error) throw error;

  const partner = await partnerName(supabase, partnerUid);
  await notify(supabase, row.buyer_id, {
    title: "Delivery request declined",
    body: reason?.trim()
      ? `${partner} declined: ${reason.trim()}. Choose another partner, or carry on without in-app delivery.`
      : `${partner} declined your delivery request. Choose another partner, or carry on without in-app delivery.`,
    relatedType: "escrow",
    relatedId: row.agreement_id,
    important: true,
  });

  return enrichOne(supabase, updated);
}

// "Turn off in-app delivery" - the buyer walking away. Fine at any point
// until the delivery money is paid in: while still negotiating it just
// closes the thread; after a price was agreed it also takes the amount back
// off the deal (or cancels the unpaid delivery deal).
export async function cancelDelivery(supabase: SupabaseClient, deliveryId: string, buyerUid: string) {
  const row = await getDeliveryOrThrow(supabase, deliveryId);
  if (row.buyer_id !== buyerUid) throw new Error("Only the buyer can turn off in-app delivery");
  if (DEAD_STATUSES.includes(row.status)) throw new Error("This delivery is already closed");

  if (row.status === "negotiating") {
    const current = await currentPendingOffer(supabase, deliveryId);
    if (current) await supabase.from(OFFERS_TABLE).update({ status: "withdrawn" }).eq("id", current.id);
  } else {
    // A price was agreed. Only while nothing has been paid in.
    const payment = await getDeliveryPaymentStatus(supabase, row);
    if (row.agreed_amount_kobo == null || payment !== "unpaid") {
      throw new Error("The delivery is already paid for - it can't be turned off now. Contact support if there's a problem.");
    }

    if (row.delivery_agreement_id) {
      await requestOrConfirmCancel(supabase, row.delivery_agreement_id, buyerUid);
    } else if (row.logistics_tranche_id) {
      const agreement = await getAgreement(supabase, row.agreement_id);
      if (!agreement) throw new Error("Deal not found");
      const { commissionKobo } = await calculateCommission(supabase, {
        type: agreement.type,
        category: agreement.category,
        amountKobo: agreement.amountKobo - row.agreed_amount_kobo,
      });
      const { error } = await supabase.rpc("escrow_remove_delivery_tranche", {
        p_agreement_id: row.agreement_id,
        p_tranche_id: row.logistics_tranche_id,
        p_new_commission_kobo: commissionKobo,
      });
      if (error) {
        throw new Error(
          String(error.message).startsWith("DELIVERY_NOT_REMOVABLE")
            ? "The delivery is already paid for - it can't be turned off now. Contact support if there's a problem."
            : error.message
        );
      }
    }
  }

  const { data: updated, error } = await supabase
    .from(DELIVERIES_TABLE)
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .select("*")
    .single();
  if (error) throw error;

  const buyerName = await displayName(supabase, buyerUid);
  await notify(supabase, row.partner_id, {
    title: "Delivery request closed",
    body: `${buyerName} turned off in-app delivery for this order.`,
    relatedType: "delivery",
    relatedId: deliveryId,
  });

  return enrichOne(supabase, updated);
}
