import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser } from "./notificationService.ts";

const TABLE = "commission_negotiations";

// Commission negotiation - see migration_25's doc comment for the overall
// design (request/accept, not live back-and-forth; only ever applied as a
// cap in createAgreement, never able to raise the rate above standard).

export type CommissionNegotiation = {
  id: string;
  requesterUid: string;
  counterpartyUid: string;
  amountKobo: number;
  proposedMode: "percentage" | "flat";
  proposedValue: number;
  message: string;
  status: string;
  createdAt: string;
  respondedAt: string | null;
  usedAt: string | null;
};

// deno-lint-ignore no-explicit-any
function toNegotiation(row: any): CommissionNegotiation {
  return {
    id: row.id,
    requesterUid: row.requester_uid,
    counterpartyUid: row.counterparty_uid,
    amountKobo: row.amount_kobo,
    proposedMode: row.proposed_mode,
    proposedValue: row.proposed_value,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    usedAt: row.used_at,
  };
}

function describeProposal(mode: string, value: number): string {
  return mode === "percentage" ? `${value}%` : `₦${(value / 100).toFixed(2)} flat`;
}

export async function proposeCommissionNegotiation(
  supabase: SupabaseClient,
  requesterUid: string,
  {
    counterpartyUid,
    amountKobo,
    proposedMode,
    proposedValue,
    message,
  }: {
    counterpartyUid: string;
    amountKobo: number;
    proposedMode: string;
    proposedValue: number;
    message?: string;
  }
): Promise<CommissionNegotiation> {
  if (counterpartyUid === requesterUid) {
    throw new Error("You can't negotiate a deal with yourself.");
  }
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
    throw new Error("amountKobo must be a positive number.");
  }
  if (proposedMode !== "percentage" && proposedMode !== "flat") {
    throw new Error('proposedMode must be "percentage" or "flat".');
  }
  if (!Number.isFinite(proposedValue) || proposedValue < 0) {
    throw new Error("proposedValue must be zero or a positive number.");
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      requester_uid: requesterUid,
      counterparty_uid: counterpartyUid,
      amount_kobo: amountKobo,
      proposed_mode: proposedMode,
      proposed_value: proposedValue,
      message: (message || "").trim(),
    })
    .select()
    .single();
  if (error) throw error;

  const negotiation = toNegotiation(data);

  await notifyUser(supabase, counterpartyUid, {
    type: "commission_negotiation_proposed",
    title: "New commission proposal",
    body: `A commission rate of ${describeProposal(proposedMode, proposedValue)} was proposed for a ₦${(
      amountKobo / 100
    ).toFixed(2)} deal.`,
    relatedType: "commission_negotiation",
    relatedId: negotiation.id,
    important: true,
  }).catch((err) => console.error("notifyUser (commission_negotiation_proposed) failed:", err));

  return negotiation;
}

export async function getCommissionNegotiation(
  supabase: SupabaseClient,
  callerUid: string,
  id: string
): Promise<CommissionNegotiation> {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Negotiation not found.");
  if (data.requester_uid !== callerUid && data.counterparty_uid !== callerUid) {
    throw new Error("You don't have access to this negotiation.");
  }
  return toNegotiation(data);
}

export async function respondToCommissionNegotiation(
  supabase: SupabaseClient,
  counterpartyUid: string,
  id: string,
  accept: boolean
): Promise<CommissionNegotiation> {
  const { data: existing, error: fetchError } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!existing) throw new Error("Negotiation not found.");
  if (existing.counterparty_uid !== counterpartyUid) {
    throw new Error("Only the counterparty can respond to this proposal.");
  }
  if (existing.status !== "pending") {
    throw new Error(`This proposal is already "${existing.status}".`);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: accept ? "accepted" : "declined", responded_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;

  const negotiation = toNegotiation(data);

  await notifyUser(supabase, negotiation.requesterUid, {
    type: accept ? "commission_negotiation_accepted" : "commission_negotiation_declined",
    title: accept ? "Your commission proposal was accepted" : "Your commission proposal was declined",
    body: accept
      ? `You can now open the deal at ${describeProposal(negotiation.proposedMode, negotiation.proposedValue)}.`
      : "The other party declined your proposed rate.",
    relatedType: "commission_negotiation",
    relatedId: negotiation.id,
    important: true,
  }).catch((err) =>
    console.error("notifyUser (commission_negotiation_responded) failed:", err)
  );

  return negotiation;
}

/// Marks an accepted negotiation as consumed, so it can't be reused for a
/// second agreement. Called by createAgreement once it's actually applied
/// the negotiated rate.
export async function markCommissionNegotiationUsed(
  supabase: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ status: "used", used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
