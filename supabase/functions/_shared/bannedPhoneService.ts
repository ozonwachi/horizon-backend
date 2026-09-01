import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Requested feature: an admin screen for banned_phones - previously the
// only way to see this table at all was Supabase Studio's raw Table
// Editor. Reuses the exact signed-URL pattern
// getVerificationRequestDetail (verificationService.ts) already uses for
// identity-verification photos, since banned_phones itself only stores
// phone/banned_uid/banned_at - name and ID photo both come from a join.
const BUCKET = "identity-documents";
const SIGNED_URL_TTL_SECONDS = 60 * 10;

export type BannedPhoneSnapshot = {
  id: string;
  phone: string;
  bannedUid: string;
  bannedAt: string;
  name: string;
  username: string;
  hasIdOnFile: boolean;
  idPhotoUrl: string | null;
};

export async function listBannedPhoneSnapshots(
  supabase: SupabaseClient,
  { query }: { query?: string } = {}
): Promise<BannedPhoneSnapshot[]> {
  const { data: rows, error } = await supabase
    .from("banned_phones")
    .select("id, phone, banned_uid, banned_at")
    .order("banned_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const uids = [...new Set(rows.map((r) => r.banned_uid as string))];

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("uid, name, username")
    .in("uid", uids);
  if (profilesError) throw profilesError;
  // deno-lint-ignore no-explicit-any
  const profileByUid = new Map((profiles ?? []).map((p: any) => [p.uid, p]));

  // Most recent verification_request per uid, if any - a banned account
  // that never submitted verification simply has none, which is a normal,
  // expected state here (not an error).
  const { data: verifications, error: verificationsError } = await supabase
    .from("verification_requests")
    .select("uid, front_path, created_at")
    .in("uid", uids)
    .order("created_at", { ascending: false });
  if (verificationsError) throw verificationsError;
  // deno-lint-ignore no-explicit-any
  const verificationByUid = new Map<string, any>();
  for (const v of verifications ?? []) {
    if (!verificationByUid.has(v.uid)) verificationByUid.set(v.uid, v);
  }

  const results: BannedPhoneSnapshot[] = [];
  for (const row of rows) {
    const profile = profileByUid.get(row.banned_uid);
    const verification = verificationByUid.get(row.banned_uid);

    let idPhotoUrl: string | null = null;
    if (verification) {
      const { data: signed, error: signError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(verification.front_path, SIGNED_URL_TTL_SECONDS);
      if (signError) {
        console.error("Signing banned-phone ID photo failed:", signError);
      } else {
        idPhotoUrl = signed?.signedUrl ?? null;
      }
    }

    results.push({
      id: row.id,
      phone: row.phone,
      bannedUid: row.banned_uid,
      bannedAt: row.banned_at,
      name: profile?.name || "(deleted account)",
      username: profile?.username || "",
      hasIdOnFile: !!verification,
      idPhotoUrl,
    });
  }

  if (!query || !query.trim()) return results;

  const q = query.trim().toLowerCase();
  return results.filter(
    (r) =>
      r.phone.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      r.username.toLowerCase().includes(q)
  );
}
