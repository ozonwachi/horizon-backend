import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser } from "./notificationService.ts";
import { recordAuditLog } from "./auditLogService.ts";

const TABLE = "verification_requests";
const BUCKET = "identity-documents";

// How long a signed URL stays valid. Doesn't matter for the "retrievable
// later" requirement - a fresh one is minted every time an admin opens a
// request's detail (see getVerificationRequestDetail below), so the photos
// stay reachable indefinitely even though any single URL expires quickly.
const SIGNED_URL_TTL_SECONDS = 60 * 10;

export type VerificationRequest = {
  id: string;
  uid: string;
  documentType: string;
  status: string;
  adminNotes: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

// deno-lint-ignore no-explicit-any
function toRequest(row: any): VerificationRequest {
  return {
    id: row.id,
    uid: row.uid,
    documentType: row.document_type,
    status: row.status,
    adminNotes: row.admin_notes,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

/// Admin-only - every verification request regardless of status (so a
/// previously-decided one can still be revisited), newest first. Submission
/// itself goes straight to Postgres from the client via RLS (see "users can
/// file their own verification requests" in
/// project_supabase_migration_11_identity_verification.sql) - no Edge
/// Function route needed for that half, same split as reports.
export async function listVerificationRequests(
  supabase: SupabaseClient
): Promise<VerificationRequest[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map(toRequest);
}

/// Admin-only - one request's full detail, including a name attached to the
/// applicant (profiles is looked up separately since verification_requests
/// only stores uid) and freshly-signed URLs for whichever of
/// front/back/selfie paths are set on this request. Called every time an
/// admin opens the detail view, not just at review time, so "pull up the
/// photo later" keeps working no matter how old the request is - the
/// signed URLs themselves expire, but the underlying storage objects and
/// this route don't.
export async function getVerificationRequestDetail(
  supabase: SupabaseClient,
  id: string
): Promise<
  (VerificationRequest & {
    applicantName: string;
    applicantEmail: string | null;
    frontUrl: string;
    backUrl: string | null;
    selfieUrl: string;
  }) | null
> {
  const { data: row, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const [{ data: profile }, frontSigned, backSigned, selfieSigned] = await Promise.all([
    supabase.from("profiles").select("name, email").eq("uid", row.uid).maybeSingle(),
    supabase.storage.from(BUCKET).createSignedUrl(row.front_path, SIGNED_URL_TTL_SECONDS),
    row.back_path
      ? supabase.storage.from(BUCKET).createSignedUrl(row.back_path, SIGNED_URL_TTL_SECONDS)
      : Promise.resolve({ data: null, error: null }),
    supabase.storage.from(BUCKET).createSignedUrl(row.selfie_path, SIGNED_URL_TTL_SECONDS),
  ]);

  if (frontSigned.error) throw frontSigned.error;
  if (backSigned.error) throw backSigned.error;
  if (selfieSigned.error) throw selfieSigned.error;

  return {
    ...toRequest(row),
    applicantName: profile?.name ?? "",
    applicantEmail: profile?.email ?? null,
    frontUrl: frontSigned.data!.signedUrl,
    backUrl: backSigned.data?.signedUrl ?? null,
    selfieUrl: selfieSigned.data!.signedUrl,
  };
}

/// Admin-only - approve or reject a request. Approving is the ONLY thing in
/// the app that sets a profile's trust_level to 'verified' - and only ever
/// an upgrade: a profile already at 'trusted_business' (a higher tier) is
/// left alone rather than being downgraded back to 'verified'.
export async function decideVerificationRequest(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  status: string,
  adminNotes: string
): Promise<VerificationRequest> {
  if (!["approved", "rejected"].includes(status)) {
    throw new Error(`Unknown verification decision "${status}"`);
  }

  const { data: existing, error: existingError } = await supabase
    .from(TABLE)
    .select("uid, status")
    .eq("id", id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw new Error("Verification request not found");

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status,
      admin_notes: adminNotes,
      reviewed_at: new Date().toISOString(),
      reviewed_by: adminUid,
    })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: status === "approved" ? "verification_approved" : "verification_rejected",
    targetType: "verification_request",
    targetId: id,
    newValue: { status, adminNotes },
  }).catch((err) => console.error("recordAuditLog (verification decision) failed:", err));

  if (status === "approved") {
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("trust_level")
      .eq("uid", existing.uid)
      .maybeSingle();
    if (profileError) throw profileError;

    if (profile?.trust_level === "basic" || !profile?.trust_level) {
      const { error: updateError } = await supabase
        .from("profiles")
        .update({ trust_level: "verified" })
        .eq("uid", existing.uid);
      if (updateError) throw updateError;
    }
  }

  // Feature Registry item #66: this used to update the row and stop there -
  // the applicant had no way to know their ID had even been looked at
  // short of reopening the app and checking. One notifyUser() call closes
  // that, using the same in-app + push pipeline every other notification
  // in the app already goes through.
  await notifyUser(supabase, existing.uid, {
    type: status === "approved" ? "verification_approved" : "verification_rejected",
    title: status === "approved" ? "You're verified!" : "Verification not approved",
    body:
      status === "approved"
        ? "Your ID was approved - you now have a verified badge on your profile."
        : adminNotes
          ? `Your ID wasn't approved: ${adminNotes}`
          : "Your ID wasn't approved this time. You can resubmit from your profile.",
    relatedType: "verification",
    relatedId: id,
    important: true,
  });

  return toRequest(data);
}
