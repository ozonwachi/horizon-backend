import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser } from "./notificationService.ts";

// Logistics Partner Network - see migration_39's doc comment for the original
// design (three-way escrow via a second tranche) and migration_40's for the
// negotiation flow that replaced "buyer types a delivery fee". This module
// owns everything that ISN'T money movement or the negotiation itself (that's
// deliveryNegotiationService.ts, which needs escrowService and so lives
// separately to keep imports one-directional): partner applications, the
// partner-facing delivery workflow, and turning a `deliveries` row into the
// rich shape both apps render.

const APPLICATIONS_TABLE = "logistics_partner_applications";
const DELIVERIES_TABLE = "deliveries";
const OFFERS_TABLE = "delivery_offers";

// deno-lint-ignore no-explicit-any
function toApplication(row: any) {
  return {
    id: row.id,
    applicantUid: row.applicant_uid,
    companyName: row.company_name,
    contactPersonName: row.contact_person_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    companyAddress: row.company_address,
    registrationNumber: row.registration_number,
    coverageAreas: row.coverage_areas,
    latitude: row.latitude,
    longitude: row.longitude,
    status: row.status,
    adminNotes: row.admin_notes,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

export function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// deno-lint-ignore no-explicit-any
export async function getDeliveryOrThrow(supabase: SupabaseClient, deliveryId: string): Promise<any> {
  const { data, error } = await supabase.from(DELIVERIES_TABLE).select("*").eq("id", deliveryId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Delivery not found");
  return data;
}

// Is the money for this delivery actually in escrow yet? A delivery priced
// into the item deal (a logistics tranche) is paid when that deal is; one
// carried by its own delivery agreement is paid when THAT is. Cancelled
// counts as unpaid - nothing is held.
// deno-lint-ignore no-explicit-any
function paymentFromAgreements(row: any, agreementsById: Map<string, any>): "paid" | "unpaid" | null {
  const carrierId = row.delivery_agreement_id ?? (row.logistics_tranche_id ? row.agreement_id : null);
  if (!carrierId) return null;
  const status = agreementsById.get(carrierId)?.status;
  if (!status) return null;
  return status === "pending_payment" || status === "cancelled" ? "unpaid" : "paid";
}

export async function getDeliveryPaymentStatus(
  supabase: SupabaseClient,
  // deno-lint-ignore no-explicit-any
  row: any
): Promise<"paid" | "unpaid" | null> {
  const carrierId = row.delivery_agreement_id ?? (row.logistics_tranche_id ? row.agreement_id : null);
  if (!carrierId) return null;
  const { data, error } = await supabase.from("escrow_agreements").select("id,status").eq("id", carrierId).maybeSingle();
  if (error) throw error;
  return paymentFromAgreements(row, new Map(data ? [[data.id, data]] : []));
}

// Turns raw `deliveries` rows into what the apps render: the negotiation
// thread, the deal being delivered (so a partner can read what the job is
// without leaving their dashboard), everyone's display names, and whether the
// delivery money has actually been paid in. Batched - one query per table no
// matter how many rows.
// deno-lint-ignore no-explicit-any
export async function enrichDeliveries(supabase: SupabaseClient, rows: any[]) {
  if (rows.length === 0) return [];

  const deliveryIds = rows.map((r) => r.id);
  const agreementIds = [
    ...new Set([
      ...rows.map((r) => r.agreement_id),
      ...rows.map((r) => r.delivery_agreement_id).filter(Boolean),
    ]),
  ];
  const uids = [...new Set(rows.flatMap((r) => [r.buyer_id, r.seller_id, r.partner_id]))];
  const partnerUids = [...new Set(rows.map((r) => r.partner_id))];

  const [offersRes, agreementsRes, profilesRes, appsRes] = await Promise.all([
    supabase.from(OFFERS_TABLE).select("*").in("delivery_id", deliveryIds).order("created_at", { ascending: true }),
    supabase
      .from("escrow_agreements")
      .select("id,title,description,category,type,status,amount_kobo,reference_id")
      .in("id", agreementIds),
    supabase.from("profiles").select("uid,name").in("uid", uids),
    supabase
      .from(APPLICATIONS_TABLE)
      .select("applicant_uid,company_name,contact_phone")
      .eq("status", "approved")
      .in("applicant_uid", partnerUids),
  ]);
  for (const r of [offersRes, agreementsRes, profilesRes, appsRes]) {
    if (r.error) throw r.error;
  }

  // Where the item is picked up from - only listings have a location.
  // deno-lint-ignore no-explicit-any
  const listingIds = (agreementsRes.data || [])
    // deno-lint-ignore no-explicit-any
    .filter((a: any) => a.type === "listing" && a.reference_id)
    // deno-lint-ignore no-explicit-any
    .map((a: any) => a.reference_id);
  const locationsById = new Map<string, string>();
  if (listingIds.length > 0) {
    const { data: listings } = await supabase.from("listings").select("id,location").in("id", listingIds);
    // deno-lint-ignore no-explicit-any
    for (const l of (listings || []) as any[]) locationsById.set(l.id, l.location);
  }

  // deno-lint-ignore no-explicit-any
  const agreementsById = new Map<string, any>((agreementsRes.data || []).map((a: any) => [a.id, a]));
  // deno-lint-ignore no-explicit-any
  const nameByUid = new Map<string, string>((profilesRes.data || []).map((p: any) => [p.uid, p.name || "User"]));
  // deno-lint-ignore no-explicit-any
  const companyByUid = new Map<string, any>((appsRes.data || []).map((a: any) => [a.applicant_uid, a]));
  // deno-lint-ignore no-explicit-any
  const offersByDelivery = new Map<string, any[]>();
  // deno-lint-ignore no-explicit-any
  for (const o of (offersRes.data || []) as any[]) {
    const list = offersByDelivery.get(o.delivery_id) ?? [];
    list.push(o);
    offersByDelivery.set(o.delivery_id, list);
  }

  return rows.map((row) => {
    const offers = (offersByDelivery.get(row.id) ?? []).map((o) => ({
      id: o.id,
      offeredBy: o.offered_by,
      role: o.offered_by_role,
      amountKobo: o.amount_kobo,
      note: o.note,
      status: o.status,
      createdAt: o.created_at,
    }));
    const currentOffer = row.status === "negotiating" ? [...offers].reverse().find((o) => o.status === "pending") ?? null : null;
    const deal = agreementsById.get(row.agreement_id);
    const company = companyByUid.get(row.partner_id);

    return {
      id: row.id,
      agreementId: row.agreement_id,
      logisticsTrancheId: row.logistics_tranche_id,
      itemTrancheId: row.item_tranche_id,
      sellerId: row.seller_id,
      buyerId: row.buyer_id,
      partnerId: row.partner_id,
      status: row.status,
      hasHandoverPhoto: Boolean(row.handover_photo_path),
      rejectionReason: row.rejection_reason,
      acceptedAt: row.accepted_at,
      pickedUpAt: row.picked_up_at,
      inTransitAt: row.in_transit_at,
      deliveredAt: row.delivered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agreedAmountKobo: row.agreed_amount_kobo,
      deliveryAgreementId: row.delivery_agreement_id,
      // "in_deal": the delivery price sits in the item deal as its own
      // tranche (one payment). "separate": its own delivery deal, paid on
      // its own because the item deal was already paid when it was agreed.
      mode: row.delivery_agreement_id ? "separate" : row.logistics_tranche_id ? "in_deal" : null,
      paymentStatus: paymentFromAgreements(row, agreementsById),
      offers,
      currentOffer,
      // Whose reply is being waited on - the party that did NOT make the
      // current offer.
      awaiting: currentOffer ? (currentOffer.role === "buyer" ? "partner" : "buyer") : null,
      deal: deal
        ? {
            title: deal.title,
            description: deal.description,
            category: deal.category,
            type: deal.type,
            status: deal.status,
            amountKobo: deal.amount_kobo,
            pickupLocation: deal.reference_id ? locationsById.get(deal.reference_id) ?? null : null,
          }
        : null,
      buyerName: nameByUid.get(row.buyer_id) ?? "Buyer",
      sellerName: nameByUid.get(row.seller_id) ?? "Seller",
      partnerName: company?.company_name ?? nameByUid.get(row.partner_id) ?? "Delivery partner",
    };
  });
}

// deno-lint-ignore no-explicit-any
export async function enrichOne(supabase: SupabaseClient, row: any) {
  const [dto] = await enrichDeliveries(supabase, [row]);
  return dto;
}

export async function applyAsPartner(
  supabase: SupabaseClient,
  applicantUid: string,
  data: {
    companyName: string;
    contactPersonName: string;
    contactPhone: string;
    contactEmail?: string;
    companyAddress: string;
    registrationNumber?: string;
    coverageAreas?: string;
    latitude?: number;
    longitude?: number;
  }
) {
  if (!data.companyName || !data.contactPersonName || !data.contactPhone || !data.companyAddress) {
    throw new Error("companyName, contactPersonName, contactPhone, and companyAddress are required");
  }
  const { data: row, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .insert({
      applicant_uid: applicantUid,
      company_name: data.companyName,
      contact_person_name: data.contactPersonName,
      contact_phone: data.contactPhone,
      contact_email: data.contactEmail || null,
      company_address: data.companyAddress,
      registration_number: data.registrationNumber || null,
      coverage_areas: data.coverageAreas || null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toApplication(row);
}

export async function getMyApplications(supabase: SupabaseClient, applicantUid: string) {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .select("*")
    .eq("applicant_uid", applicantUid)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(toApplication);
}

export async function listApplications(supabase: SupabaseClient, status?: string) {
  let query = supabase.from(APPLICATIONS_TABLE).select("*").order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(toApplication);
}

export async function decideApplication(
  supabase: SupabaseClient,
  applicationId: string,
  adminUid: string,
  decision: "approved" | "rejected",
  notes?: string
) {
  const { data: application, error: fetchError } = await supabase
    .from(APPLICATIONS_TABLE)
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!application) throw new Error("Application not found");

  const { data: row, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .update({
      status: decision,
      admin_notes: notes || "",
      reviewed_at: new Date().toISOString(),
      reviewed_by: adminUid,
    })
    .eq("id", applicationId)
    .select("*")
    .single();
  if (error) throw error;

  if (decision === "approved") {
    const { error: profileError } = await supabase
      .from("profiles")
      .update({ is_logistics_partner: true })
      .eq("uid", application.applicant_uid);
    if (profileError) throw profileError;
  }

  await notifyUser(supabase, application.applicant_uid, {
    type: decision === "approved" ? "logistics_application_approved" : "logistics_application_rejected",
    title: decision === "approved" ? "You're now a delivery partner" : "Delivery partner application declined",
    body:
      decision === "approved"
        ? "Your logistics partner application was approved - you can now manage deliveries from the app."
        : notes
          ? `Your logistics partner application was declined: ${notes}`
          : "Your logistics partner application was declined.",
    relatedType: "logistics_application",
    relatedId: applicationId,
    important: true,
  }).catch((err) => console.error("notifyUser (logistics application decision) failed:", err));

  return toApplication(row);
}

// Approved partners near a point, for the deal-creation "pick a delivery
// partner" step. Distance is computed in JS (small result set, no PostGIS
// dependency in this project) - same tradeoff as everywhere else nearby
// filtering happens in this codebase.
export async function listNearbyPartners(
  supabase: SupabaseClient,
  { latitude, longitude, limit = 20 }: { latitude?: number; longitude?: number; limit?: number }
) {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .select("*")
    .eq("status", "approved")
    .order("created_at", { ascending: false });
  if (error) throw error;

  let partners = (data || []).map(toApplication);
  if (latitude != null && longitude != null) {
    const distanceKm = (lat: number, lng: number) => {
      const R = 6371;
      const dLat = ((lat - latitude) * Math.PI) / 180;
      const dLng = ((lng - longitude) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((latitude * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    partners = partners
      .map((p) => ({ ...p, distanceKm: p.latitude != null && p.longitude != null ? distanceKm(p.latitude, p.longitude) : null }))
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  }
  return partners.slice(0, limit);
}

// Called right after an agreement is created (see escrowService.createAgreement)
// - a no-op unless the agreement actually has a logistics tranche. Only the
// original (migration_39) flow creates agreements that way now - kept so an
// older app build still works. Reads the already-materialized agreement (with
// real tranche ids) rather than the raw input, so it always reflects exactly
// what got persisted.
// deno-lint-ignore no-explicit-any
export async function createDeliveryForAgreementIfNeeded(supabase: SupabaseClient, agreement: any) {
  // deno-lint-ignore no-explicit-any
  const logisticsTranche = (agreement.tranches || []).find((t: any) => t.trancheType === "logistics");
  if (!logisticsTranche) return null;
  const itemTranche = agreement.tranches.find(
    // deno-lint-ignore no-explicit-any
    (t: any) => t.id === logisticsTranche.linkedItemTrancheId
  );
  if (!itemTranche) return null;

  const { data: row, error } = await supabase
    .from(DELIVERIES_TABLE)
    .insert({
      agreement_id: agreement.id,
      logistics_tranche_id: logisticsTranche.id,
      item_tranche_id: itemTranche.id,
      seller_id: agreement.sellerId,
      buyer_id: agreement.buyerId,
      partner_id: logisticsTranche.recipientId,
    })
    .select("*")
    .single();
  if (error) throw error;

  await notifyUser(supabase, logisticsTranche.recipientId, {
    type: "delivery_assigned",
    title: "New delivery assigned",
    body: agreement.title ? `A delivery for "${agreement.title}" was assigned to you.` : "A new delivery was assigned to you.",
    relatedType: "delivery",
    relatedId: row.id,
    important: true,
  }).catch((err) => console.error("notifyUser (delivery_assigned) failed:", err));

  return enrichOne(supabase, row);
}

export async function listDeliveriesForPartner(supabase: SupabaseClient, partnerId: string, status?: string) {
  let query = supabase.from(DELIVERIES_TABLE).select("*").eq("partner_id", partnerId).order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return enrichDeliveries(supabase, data || []);
}

export async function listDeliveriesForAgreement(supabase: SupabaseClient, agreementId: string) {
  const { data, error } = await supabase
    .from(DELIVERIES_TABLE)
    .select("*")
    .eq("agreement_id", agreementId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return enrichDeliveries(supabase, data || []);
}

// One delivery, but only for someone who's actually a party to it (buyer,
// seller, the partner) or an admin.
export async function getDeliveryDetail(supabase: SupabaseClient, deliveryId: string, requesterUid: string, isAdmin: boolean) {
  const row = await getDeliveryOrThrow(supabase, deliveryId);
  const isParty = [row.buyer_id, row.seller_id, row.partner_id].includes(requesterUid);
  if (!isParty && !isAdmin) throw new Error("Not authorized to view this delivery");
  return enrichOne(supabase, row);
}

async function assertIsAssignedPartner(supabase: SupabaseClient, deliveryId: string, partnerUid: string) {
  const delivery = await getDeliveryOrThrow(supabase, deliveryId);
  if (delivery.partner_id !== partnerUid) throw new Error("Not your delivery");
  return delivery;
}

// Legacy (migration_39) flow only: a partner accepting a delivery that was
// assigned to them outright, with no negotiation. New deliveries are
// accepted by agreeing a price - see deliveryNegotiationService.ts.
export async function acceptDelivery(supabase: SupabaseClient, deliveryId: string, partnerUid: string) {
  const delivery = await assertIsAssignedPartner(supabase, deliveryId, partnerUid);
  if (delivery.status !== "assigned") throw new Error(`Cannot accept from status "${delivery.status}"`);

  const { data: row, error } = await supabase
    .from(DELIVERIES_TABLE)
    .update({ status: "accepted", accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .select("*")
    .single();
  if (error) throw error;

  await notifyUser(supabase, delivery.seller_id, {
    type: "delivery_status_updated",
    title: "Delivery accepted",
    body: "A logistics partner accepted this delivery.",
    relatedType: "escrow",
    relatedId: delivery.agreement_id,
  }).catch((err) => console.error("notifyUser (delivery accepted) failed:", err));

  return enrichOne(supabase, row);
}

// Legacy (migration_39) flow only - declining an outright-assigned delivery
// refunds the logistics tranche to the buyer via
// escrow_reject_logistics_tranche without touching the item tranche.
export async function rejectDelivery(supabase: SupabaseClient, deliveryId: string, partnerUid: string, reason?: string) {
  const delivery = await assertIsAssignedPartner(supabase, deliveryId, partnerUid);
  if (delivery.status !== "assigned") throw new Error(`Cannot reject from status "${delivery.status}"`);

  const { error: rpcError } = await supabase.rpc("escrow_reject_logistics_tranche", {
    p_tranche_id: delivery.logistics_tranche_id,
    p_partner_uid: partnerUid,
    p_reason: reason || null,
  });
  if (rpcError) throw new Error(rpcError.message);

  const { data: row, error } = await supabase
    .from(DELIVERIES_TABLE)
    .update({ status: "rejected", rejection_reason: reason || null, updated_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .select("*")
    .single();
  if (error) throw error;

  await notifyUser(supabase, delivery.seller_id, {
    type: "delivery_status_updated",
    title: "Delivery declined",
    body: reason
      ? `The logistics partner declined this delivery: ${reason}. You can arrange delivery yourself instead.`
      : "The logistics partner declined this delivery. You can arrange delivery yourself instead.",
    relatedType: "escrow",
    relatedId: delivery.agreement_id,
    important: true,
  }).catch((err) => console.error("notifyUser (delivery rejected) failed:", err));

  return enrichOne(supabase, row);
}

const STATUS_ORDER = ["accepted", "picked_up", "in_transit", "delivered"];

// Partner-driven physical-delivery status update. Deliberately NEVER
// touches escrow_tranches/escrow_agreements - see migration_39's doc
// comment: delivery status and money release are fully independent, the
// buyer's own confirmation is still the only thing that releases anything.
// This only updates the deliveries row and notifies the seller.
//
// New-flow deliveries (a negotiated price) can't start until the buyer has
// actually paid it in - a partner shouldn't be moving goods against money
// that isn't in escrow yet.
export async function updateDeliveryStatus(
  supabase: SupabaseClient,
  deliveryId: string,
  partnerUid: string,
  newStatus: "picked_up" | "in_transit" | "delivered"
) {
  const delivery = await assertIsAssignedPartner(supabase, deliveryId, partnerUid);
  const currentIndex = STATUS_ORDER.indexOf(delivery.status);
  const newIndex = STATUS_ORDER.indexOf(newStatus);
  if (currentIndex === -1 || newIndex !== currentIndex + 1) {
    throw new Error(`Cannot move from "${delivery.status}" to "${newStatus}"`);
  }

  if (delivery.agreed_amount_kobo != null) {
    const payment = await getDeliveryPaymentStatus(supabase, delivery);
    if (payment !== "paid") {
      throw new Error("Waiting for the buyer to pay for the delivery - you can start once it's in escrow.");
    }
  }

  const timestampColumn = { picked_up: "picked_up_at", in_transit: "in_transit_at", delivered: "delivered_at" }[newStatus];
  const { data: row, error } = await supabase
    .from(DELIVERIES_TABLE)
    .update({ status: newStatus, [timestampColumn]: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .select("*")
    .single();
  if (error) throw error;

  const labels = { picked_up: "picked up", in_transit: "on the way", delivered: "delivered" };
  await notifyUser(supabase, delivery.seller_id, {
    type: "delivery_status_updated",
    title: "Delivery update",
    body: `Your delivery is now ${labels[newStatus]}.`,
    relatedType: "escrow",
    relatedId: delivery.agreement_id,
  }).catch((err) => console.error("notifyUser (delivery status update) failed:", err));

  // The buyer doesn't get a push for every hop, only the meaningful one -
  // "delivered" is when they need to go check the item and confirm. For a
  // delivery carried by its own deal, that confirmation happens on THAT deal.
  if (newStatus === "delivered") {
    await notifyUser(supabase, delivery.buyer_id, {
      type: "delivery_status_updated",
      title: "Your delivery has arrived",
      body: "The logistics partner marked your delivery as delivered - check your item and confirm when you're ready.",
      relatedType: "escrow",
      relatedId: delivery.delivery_agreement_id ?? delivery.agreement_id,
      important: true,
    }).catch((err) => console.error("notifyUser (delivery delivered -> buyer) failed:", err));
  }

  return enrichOne(supabase, row);
}

// Seller's proof-of-handover photo - path only (private bucket), same
// "signed URL generated server-side for authorized parties" pattern as
// identity-documents (migration_11). Only the seller on this exact delivery
// may set it.
export async function setHandoverPhoto(supabase: SupabaseClient, deliveryId: string, sellerUid: string, photoPath: string) {
  const delivery = await getDeliveryOrThrow(supabase, deliveryId);
  if (delivery.seller_id !== sellerUid) throw new Error("Not your delivery");

  const { data: row, error } = await supabase
    .from(DELIVERIES_TABLE)
    .update({ handover_photo_path: photoPath, updated_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .select("*")
    .single();
  if (error) throw error;

  await notifyUser(supabase, delivery.partner_id, {
    type: "delivery_status_updated",
    title: "Handover photo added",
    body: "The seller added a handover photo for this delivery.",
    relatedType: "delivery",
    relatedId: deliveryId,
  }).catch((err) => console.error("notifyUser (handover photo) failed:", err));

  return enrichOne(supabase, row);
}

// Signed URL for the handover photo - only a party to this exact delivery
// (buyer, seller, the assigned partner) or an admin may fetch it. Short
// expiry (1 hour) since a fresh one is cheap to re-request, same as the
// verification-photo pattern elsewhere in this codebase.
export async function getHandoverPhotoUrl(
  supabase: SupabaseClient,
  deliveryId: string,
  requesterUid: string,
  isAdmin: boolean
) {
  const delivery = await getDeliveryOrThrow(supabase, deliveryId);
  const isParty = [delivery.buyer_id, delivery.seller_id, delivery.partner_id].includes(requesterUid);
  if (!isParty && !isAdmin) throw new Error("Not authorized to view this photo");
  if (!delivery.handover_photo_path) return null;

  const { data, error } = await supabase.storage
    .from("delivery-photos")
    .createSignedUrl(delivery.handover_photo_path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// Admin overview of recent deliveries, each with a short-lived signed URL for
// the seller's handover photo (when there is one) so the dashboard can show it
// inline. Admin-only - the caller (admin function) enforces that.
export async function listDeliveriesForAdmin(supabase: SupabaseClient, limit = 100) {
  const { data, error } = await supabase
    .from(DELIVERIES_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = data || [];
  const enriched = await enrichDeliveries(supabase, rows);
  return await Promise.all(
    // deno-lint-ignore no-explicit-any
    enriched.map(async (d: any, i: number) => {
      const path = rows[i].handover_photo_path;
      if (!path) return { ...d, handoverPhotoUrl: null };
      const { data: signed } = await supabase.storage.from("delivery-photos").createSignedUrl(path, 3600);
      return { ...d, handoverPhotoUrl: signed?.signedUrl ?? null };
    })
  );
}
