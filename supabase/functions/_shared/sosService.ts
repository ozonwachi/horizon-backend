import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { notifyUser } from "./notificationService.ts";

// Horizon SOS / Security Circle - see migration_44 for the data model and the
// reasoning behind the security posture. Everything here runs with the
// service role, so EVERY function does its own authorization; nothing in the
// client can read these tables directly (RLS on, no policies).
//
// What this deliberately does NOT do:
//  - claim emergency services were contacted (only a circle member confirming
//    it, in the app, sets help_contacted_at - and it's always attributed);
//  - notify people who aren't on Horizon yet (there is no SMS provider; those
//    contacts stay 'pending' until they sign up and accept, and activation
//    reports how many people could not be reached);
//  - expose a location to anyone who isn't the owner, an accepted+active
//    circle member that was snapshotted onto THAT alert, or an authorised admin.

const CONTACTS = "emergency_contacts";
const ALERTS = "emergency_alerts";
const LOCATIONS = "emergency_locations";
const RECIPIENTS = "emergency_alert_recipients";
const AUDIT = "emergency_audit_logs";

export const SOS_NOT_VERIFIED = "Horizon SOS is available only to verified users.";
const MAX_CONTACTS = 10;
const OPEN_STATUSES = ["ACTIVE", "ACKNOWLEDGED"];
const EMERGENCY_TYPES = ["immediate_danger", "robbery", "attack", "followed", "accident", "medical", "other"];
const SAFETY_LINE = "DO NOT CONFRONT SUSPECTS OR PUT YOURSELF IN DANGER. CONTACT EMERGENCY SERVICES.";

// deno-lint-ignore no-explicit-any
type Row = any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type SosLocation = { latitude: number; longitude: number; accuracy?: number | null };

export function parseLocation(raw: Row): SosLocation | null {
  if (!raw || raw.latitude == null || raw.longitude == null) return null;
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new SosError("Invalid location.");
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new SosError("Invalid location.");
  let accuracy: number | null = null;
  if (raw.accuracy != null) {
    accuracy = Number(raw.accuracy);
    if (!Number.isFinite(accuracy) || accuracy < 0) throw new SosError("Invalid location accuracy.");
  }
  return { latitude, longitude, accuracy };
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\+/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (cleaned.startsWith("+") ? "+" : "") + digits;
}

function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\+/g, "");
  return [...new Set([phone, digits, "+" + digits])];
}

function newInviteCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function recordSosAudit(
  supabase: SupabaseClient,
  entry: {
    alertId?: string | null;
    actorUserId?: string | null;
    actorRole?: "user" | "contact" | "admin" | "system";
    action: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await supabase.from(AUDIT).insert({
    emergency_alert_id: entry.alertId ?? null,
    actor_user_id: entry.actorUserId ?? null,
    actor_role: entry.actorRole ?? "user",
    action: entry.action,
    metadata: entry.metadata ?? {},
  });
  // The audit trail is the point of the system: if it can't be written, fail
  // the action rather than let something sensitive happen unrecorded.
  if (error) throw error;
}

/// Verified = has completed ID verification (trust_level above 'basic'; see
/// verificationService.ts). Checked server-side on every SOS/circle call.
async function requireVerifiedUser(supabase: SupabaseClient, uid: string): Promise<Row> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("uid, name, phone, trust_level, sos_restricted, sos_restricted_reason, account_status")
    .eq("uid", uid)
    .maybeSingle();
  if (error) throw error;
  if (!profile || !profile.trust_level || profile.trust_level === "basic") {
    throw new SosError(SOS_NOT_VERIFIED, 403, "NOT_VERIFIED");
  }
  return profile;
}

export class SosError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "SosError";
    this.status = status;
    this.code = code;
  }
}

async function expireIfStale(supabase: SupabaseClient, alert: Row): Promise<Row> {
  if (!OPEN_STATUSES.includes(alert.status) || new Date(alert.expires_at).getTime() > Date.now()) return alert;
  const { data } = await supabase
    .from(ALERTS)
    .update({ status: "EXPIRED", updated_at: new Date().toISOString() })
    .eq("id", alert.id)
    .in("status", OPEN_STATUSES)
    .select("*")
    .maybeSingle();
  if (data) {
    await recordSosAudit(supabase, { alertId: alert.id, actorRole: "system", action: "expired" });
    return data;
  }
  return alert;
}

// ---------------------------------------------------------------------------
// Security Circle
// ---------------------------------------------------------------------------

function toContact(row: Row) {
  return {
    id: row.id,
    contactUserId: row.contact_user_id,
    name: row.contact_name,
    phoneNumber: row.phone_number,
    relationship: row.relationship,
    status: row.status,
    isActive: row.status === "active" && row.alerts_enabled === true,
    hasAccepted: row.accepted_at != null,
    alertsEnabled: row.alerts_enabled,
    isHorizonUser: row.contact_user_id != null,
    inviteCode: row.status === "pending" && !row.contact_user_id ? row.invite_code : null,
    createdAt: row.created_at,
  };
}

export async function addContact(
  supabase: SupabaseClient,
  ownerUid: string,
  input: { contactUserId?: string; phone?: string; name?: string; relationship?: string; confirmed?: boolean }
) {
  const owner = await requireVerifiedUser(supabase, ownerUid);
  if (input.confirmed !== true) {
    throw new SosError("You must explicitly confirm that you want to add this person to your Security Circle.");
  }

  const { count } = await supabase
    .from(CONTACTS)
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", ownerUid)
    .in("status", ["pending", "active"]);
  if ((count ?? 0) >= MAX_CONTACTS) {
    throw new SosError(`Your Security Circle can have at most ${MAX_CONTACTS} people.`);
  }

  const relationship = (input.relationship || "").trim().slice(0, 60) || null;
  let contactUserId: string | null = null;
  let contactName = (input.name || "").trim().slice(0, 80);
  let phone = normalizePhone(input.phone);

  if (input.contactUserId) {
    const { data: p, error } = await supabase
      .from("profiles")
      .select("uid, name, phone, account_status")
      .eq("uid", input.contactUserId)
      .maybeSingle();
    if (error) throw error;
    if (!p) throw new SosError("That Horizon user was not found.", 404);
    contactUserId = p.uid;
    contactName = contactName || p.name || "Horizon user";
    // Don't copy their phone from the profile: the circle stores only what
    // the owner typed, and Horizon users are reached through the app.
  } else if (phone) {
    const { data: matches } = await supabase.from("profiles").select("uid, name").in("phone", phoneVariants(phone)).limit(1);
    if (matches && matches.length > 0) {
      contactUserId = matches[0].uid;
      contactName = contactName || matches[0].name || "Horizon user";
    }
  } else {
    throw new SosError("Choose a Horizon user or enter a phone number.");
  }

  if (!contactName) throw new SosError("A name is required for this contact.");
  if (contactUserId === ownerUid) throw new SosError("You can't add yourself.");
  if (!contactUserId && phone && owner.phone && phoneVariants(phone).includes(owner.phone)) {
    throw new SosError("You can't add yourself.");
  }

  const { data: row, error } = await supabase
    .from(CONTACTS)
    .insert({
      owner_user_id: ownerUid,
      contact_user_id: contactUserId,
      contact_name: contactName,
      phone_number: phone,
      relationship,
      status: "pending",
      alerts_enabled: false,
      invite_code: contactUserId ? null : newInviteCode(),
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") throw new SosError("That person is already in your Security Circle.");
    throw error;
  }

  await recordSosAudit(supabase, {
    actorUserId: ownerUid,
    action: "contact_added",
    metadata: { contactId: row.id, linkedHorizonUser: Boolean(contactUserId) },
  });

  if (contactUserId) {
    await notifyUser(supabase, contactUserId, {
      type: "security_circle_invite",
      title: "Emergency contact request",
      body:
        `${owner.name || "Someone"} has added you as an emergency contact. If they activate Horizon SOS you may receive ` +
        "emergency notifications and location information to help coordinate assistance. Open Security Circle to accept or decline.",
      relatedType: "security_circle",
      relatedId: row.id,
    }).catch((err) => console.error("notifyUser (circle invite) failed:", err));
  }

  return toContact(row);
}

export async function listCircle(supabase: SupabaseClient, uid: string) {
  const { data: profile } = await supabase.from("profiles").select("phone, trust_level, sos_restricted").eq("uid", uid).maybeSingle();

  const { data: mine, error } = await supabase
    .from(CONTACTS)
    .select("*")
    .eq("owner_user_id", uid)
    .in("status", ["pending", "active", "declined"])
    .order("created_at", { ascending: true });
  if (error) throw error;

  // Requests for me to accept: addressed to my user id, or to my phone
  // number before I had an account.
  const invitesQuery = supabase.from(CONTACTS).select("*").eq("status", "pending");
  const { data: invites, error: invErr } = profile?.phone
    ? await invitesQuery.or(`contact_user_id.eq.${uid},and(contact_user_id.is.null,phone_number.in.(${phoneVariants(profile.phone).join(",")}))`)
    : await invitesQuery.eq("contact_user_id", uid);
  if (invErr) throw invErr;

  const { data: trusting, error: trErr } = await supabase
    .from(CONTACTS)
    .select("*")
    .eq("contact_user_id", uid)
    .eq("status", "active");
  if (trErr) throw trErr;

  const ownerIds = [...new Set([...(invites || []), ...(trusting || [])].map((r: Row) => r.owner_user_id))];
  const names = new Map<string, string>();
  if (ownerIds.length) {
    const { data: ps } = await supabase.from("profiles").select("uid,name").in("uid", ownerIds);
    for (const p of ps || []) names.set(p.uid, p.name || "A Horizon user");
  }

  return {
    verified: Boolean(profile?.trust_level && profile.trust_level !== "basic"),
    restricted: profile?.sos_restricted === true,
    contacts: (mine || []).map(toContact),
    invitations: (invites || [])
      .filter((r: Row) => r.owner_user_id !== uid)
      .map((r: Row) => ({
        id: r.id,
        ownerName: names.get(r.owner_user_id) ?? "A Horizon user",
        relationship: r.relationship,
        createdAt: r.created_at,
      })),
    trustedBy: (trusting || []).map((r: Row) => ({
      id: r.id,
      ownerName: names.get(r.owner_user_id) ?? "A Horizon user",
      relationship: r.relationship,
    })),
  };
}

/// The invitee accepts/declines - by contact id (they saw it in their list)
/// or by the invite code the owner shared with them.
export async function respondToInvite(
  supabase: SupabaseClient,
  uid: string,
  input: { contactId?: string; inviteCode?: string; accept: boolean }
) {
  const { data: profile } = await supabase.from("profiles").select("uid, name, phone").eq("uid", uid).maybeSingle();
  if (!profile) throw new SosError("Account not found.", 404);

  let query = supabase.from(CONTACTS).select("*").eq("status", "pending");
  if (input.inviteCode) query = query.eq("invite_code", String(input.inviteCode).trim().toUpperCase());
  else if (input.contactId) query = query.eq("id", input.contactId);
  else throw new SosError("contactId or inviteCode is required.");
  const { data: row, error } = await query.maybeSingle();
  if (error) throw error;

  const addressedToMe =
    row &&
    (row.contact_user_id === uid ||
      (!row.contact_user_id && row.phone_number && profile.phone && phoneVariants(row.phone_number).includes(profile.phone)) ||
      // The invite code itself is the proof for someone whose number differs.
      (!row.contact_user_id && input.inviteCode));
  if (!row || !addressedToMe || row.owner_user_id === uid) throw new SosError("Invitation not found.", 404);

  const now = new Date().toISOString();

  // The same person can end up invited twice by one owner (e.g. by phone and
  // by account). Fold the duplicate into the existing entry rather than
  // tripping the one-entry-per-person index.
  const { data: existing } = await supabase
    .from(CONTACTS)
    .select("id")
    .eq("owner_user_id", row.owner_user_id)
    .eq("contact_user_id", uid)
    .in("status", ["pending", "active"])
    .neq("id", row.id)
    .maybeSingle();
  if (existing) {
    await supabase
      .from(CONTACTS)
      .update({ status: "removed", alerts_enabled: false, invite_code: null, updated_at: now })
      .eq("id", row.id);
    row.id = existing.id;
  }

  const { error: upErr } = await supabase
    .from(CONTACTS)
    .update(
      input.accept
        ? { status: "active", alerts_enabled: true, contact_user_id: uid, accepted_at: now, invite_code: null, updated_at: now }
        : { status: "declined", alerts_enabled: false, contact_user_id: uid, invite_code: null, updated_at: now }
    )
    .eq("id", row.id);
  if (upErr) throw upErr;

  await recordSosAudit(supabase, {
    actorUserId: uid,
    actorRole: "contact",
    action: input.accept ? "contact_accepted" : "contact_declined",
    metadata: { contactId: row.id, ownerUserId: row.owner_user_id },
  });

  await notifyUser(supabase, row.owner_user_id, {
    type: "security_circle_response",
    title: input.accept ? "Emergency contact accepted" : "Emergency contact declined",
    body: `${profile.name || "Your contact"} ${input.accept ? "accepted" : "declined"} your emergency contact request.`,
    relatedType: "security_circle",
    relatedId: row.id,
  }).catch((err) => console.error("notifyUser (circle response) failed:", err));

  return { ok: true, accepted: input.accept };
}

/// The owner removes someone, or the contact leaves a circle they accepted.
export async function removeContact(supabase: SupabaseClient, uid: string, contactId: string) {
  const { data: row, error } = await supabase.from(CONTACTS).select("*").eq("id", contactId).maybeSingle();
  if (error) throw error;
  if (!row || (row.owner_user_id !== uid && row.contact_user_id !== uid)) throw new SosError("Contact not found.", 404);

  const asOwner = row.owner_user_id === uid;
  const { error: upErr } = await supabase
    .from(CONTACTS)
    .update({ status: asOwner ? "removed" : "declined", alerts_enabled: false, invite_code: null, updated_at: new Date().toISOString() })
    .eq("id", contactId);
  if (upErr) throw upErr;

  await recordSosAudit(supabase, {
    actorUserId: uid,
    actorRole: asOwner ? "user" : "contact",
    action: asOwner ? "contact_removed" : "contact_left",
    metadata: { contactId, ownerUserId: row.owner_user_id },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function formatAccuracy(a: number | null | undefined): string {
  return a == null ? "accuracy unknown" : `approximately ${Math.round(a)} metres`;
}

function locationView(alert: Row) {
  if (alert.last_latitude == null || alert.last_longitude == null) return null;
  const at = alert.last_location_at ? new Date(alert.last_location_at) : null;
  const ageSeconds = at ? Math.max(0, Math.round((Date.now() - at.getTime()) / 1000)) : null;
  return {
    latitude: alert.last_latitude,
    longitude: alert.last_longitude,
    accuracy: alert.last_accuracy,
    recordedAt: alert.last_location_at,
    ageSeconds,
    // The client must not present this as "live" once fixes stop arriving.
    isLive: ageSeconds != null && ageSeconds <= 90,
  };
}

async function loadAlertOrThrow(supabase: SupabaseClient, alertId: string): Promise<Row> {
  const { data, error } = await supabase.from(ALERTS).select("*").eq("id", alertId).maybeSingle();
  if (error) throw error;
  if (!data) throw new SosError("Alert not found.", 404);
  return await expireIfStale(supabase, data);
}

export async function activateSos(
  supabase: SupabaseClient,
  uid: string,
  input: { emergencyType?: string; location?: Row; deviceInfo?: Row; method?: string }
) {
  const profile = await requireVerifiedUser(supabase, uid);
  if (profile.sos_restricted) {
    throw new SosError("Horizon SOS is currently unavailable on your account. Please contact support.", 403, "SOS_RESTRICTED");
  }

  // Double press / retry: return the live alert instead of erroring.
  const { data: existing } = await supabase.from(ALERTS).select("*").eq("user_id", uid).in("status", OPEN_STATUSES).maybeSingle();
  if (existing) {
    const fresh = await expireIfStale(supabase, existing);
    if (OPEN_STATUSES.includes(fresh.status)) return await ownerView(supabase, fresh, { reused: true });
  }

  const emergencyType = input.emergencyType && EMERGENCY_TYPES.includes(input.emergencyType) ? input.emergencyType : null;
  const loc = parseLocation(input.location);
  // Only 'button' exists today; 'silent' is reserved for Phase 3.
  const method = input.method === "silent" ? "silent" : "button";
  const device = input.deviceInfo && typeof input.deviceInfo === "object"
    ? { platform: String(input.deviceInfo.platform ?? "").slice(0, 20), appVersion: String(input.deviceInfo.appVersion ?? "").slice(0, 20) }
    : null;

  const { data: contacts, error: cErr } = await supabase
    .from(CONTACTS)
    .select("*")
    .eq("owner_user_id", uid)
    .eq("status", "active")
    .eq("alerts_enabled", true)
    .not("contact_user_id", "is", null);
  if (cErr) throw cErr;
  if (!contacts || contacts.length === 0) {
    throw new SosError(
      "Nobody in your Security Circle can receive alerts yet. Add an emergency contact who has accepted before using Horizon SOS.",
      400,
      "NO_CONTACTS"
    );
  }

  const now = new Date().toISOString();
  const { data: alert, error } = await supabase
    .from(ALERTS)
    .insert({
      user_id: uid,
      status: "ACTIVE",
      emergency_type: emergencyType,
      activation_method: method,
      activated_at: now,
      initial_latitude: loc?.latitude ?? null,
      initial_longitude: loc?.longitude ?? null,
      initial_accuracy: loc?.accuracy ?? null,
      last_latitude: loc?.latitude ?? null,
      last_longitude: loc?.longitude ?? null,
      last_accuracy: loc?.accuracy ?? null,
      last_location_at: loc ? now : null,
      device_info: device,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: again } = await supabase.from(ALERTS).select("*").eq("user_id", uid).in("status", OPEN_STATUSES).maybeSingle();
      if (again) return await ownerView(supabase, again, { reused: true });
    }
    throw error;
  }

  if (loc) {
    await supabase.from(LOCATIONS).insert({
      emergency_alert_id: alert.id,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy ?? null,
    });
  }

  await supabase.from(RECIPIENTS).insert(
    contacts.map((c: Row) => ({
      emergency_alert_id: alert.id,
      contact_id: c.id,
      recipient_user_id: c.contact_user_id,
      contact_name: c.contact_name,
      phone_number: c.phone_number,
    }))
  );

  await recordSosAudit(supabase, {
    alertId: alert.id,
    actorUserId: uid,
    action: "activated",
    metadata: {
      method,
      emergencyType,
      hadLocation: Boolean(loc),
      accuracy: loc?.accuracy ?? null,
      recipients: contacts.length,
      device,
    },
  });

  // Abuse heuristic - advisory only, never punitive. Three or more
  // activations inside 24 hours puts this alert in front of an admin.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: recent } = await supabase
    .from(ALERTS)
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .gte("activated_at", since);
  if ((recent ?? 0) >= 3) {
    await supabase.from(ALERTS).update({ flagged: true, flag_reason: `${recent} activations within 24 hours` }).eq("id", alert.id);
    await recordSosAudit(supabase, {
      alertId: alert.id,
      actorRole: "system",
      action: "auto_flagged_for_review",
      metadata: { activationsIn24h: recent },
    });
  }

  const name = profile.name || "A Horizon user";
  const locLine = loc
    ? `📍 Current location available (${formatAccuracy(loc.accuracy)}).`
    : "📍 Location not available yet - call them and check back.";
  const notified: string[] = [];
  await Promise.all(
    contacts.map(async (c: Row) => {
      try {
        await notifyUser(supabase, c.contact_user_id, {
          type: "sos_alert",
          title: "🔴 HORIZON SOS",
          body: `${name} has activated an emergency alert and may need immediate assistance.\n${locLine}\n⚠️ Please contact emergency services and give them the location.\n${SAFETY_LINE}`,
          relatedType: "sos",
          relatedId: alert.id,
          important: true,
        });
        notified.push(c.id);
      } catch (err) {
        console.error("SOS notify failed for contact", c.id, err);
      }
    })
  );
  if (notified.length > 0) {
    await supabase
      .from(RECIPIENTS)
      .update({ notified_at: new Date().toISOString() })
      .eq("emergency_alert_id", alert.id)
      .in("contact_id", notified);
    await recordSosAudit(supabase, {
      alertId: alert.id,
      actorRole: "system",
      action: "contacts_notified",
      metadata: { notified: notified.length, attempted: contacts.length },
    });
  }

  // Circle members we could not reach (still pending / not on Horizon).
  const { count: unreachable } = await supabase
    .from(CONTACTS)
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", uid)
    .eq("status", "pending");

  return await ownerView(supabase, alert, { notifiedCount: notified.length, attemptedCount: contacts.length, unreachableCount: unreachable ?? 0 });
}

async function recipientsOf(supabase: SupabaseClient, alertId: string) {
  const { data, error } = await supabase.from(RECIPIENTS).select("*").eq("emergency_alert_id", alertId);
  if (error) throw error;
  return data || [];
}

async function ownerView(supabase: SupabaseClient, alert: Row, extra: Record<string, unknown> = {}) {
  const recipients = await recipientsOf(supabase, alert.id);
  return {
    id: alert.id,
    role: "owner",
    status: alert.status,
    emergencyType: alert.emergency_type,
    activatedAt: alert.activated_at,
    expiresAt: alert.expires_at,
    cancelledAt: alert.cancelled_at,
    location: locationView(alert),
    recipients: recipients.map((r: Row) => ({
      name: r.contact_name,
      notifiedAt: r.notified_at,
      viewedAt: r.viewed_at,
      acknowledgedAt: r.acknowledged_at,
      helpContactedAt: r.help_contacted_at,
    })),
    ...extra,
  };
}

export async function addLocationUpdate(supabase: SupabaseClient, uid: string, alertId: string, rawLocation: Row) {
  const alert = await loadAlertOrThrow(supabase, alertId);
  if (alert.user_id !== uid) throw new SosError("Alert not found.", 404);
  if (!OPEN_STATUSES.includes(alert.status)) throw new SosError("This alert is no longer active.", 409, "NOT_ACTIVE");
  const loc = parseLocation(rawLocation);
  if (!loc) throw new SosError("A location is required.");

  const now = new Date().toISOString();
  const { error } = await supabase.from(LOCATIONS).insert({
    emergency_alert_id: alertId,
    latitude: loc.latitude,
    longitude: loc.longitude,
    accuracy: loc.accuracy ?? null,
  });
  if (error) throw error;

  // Set an initial location too if activation had none.
  const patch: Row = {
    last_latitude: loc.latitude,
    last_longitude: loc.longitude,
    last_accuracy: loc.accuracy ?? null,
    last_location_at: now,
    updated_at: now,
  };
  if (alert.initial_latitude == null) {
    patch.initial_latitude = loc.latitude;
    patch.initial_longitude = loc.longitude;
    patch.initial_accuracy = loc.accuracy ?? null;
    await recordSosAudit(supabase, {
      alertId,
      actorUserId: uid,
      action: "first_location_received",
      metadata: { accuracy: loc.accuracy ?? null },
    });
  }
  await supabase.from(ALERTS).update(patch).eq("id", alertId);
  return { ok: true, recordedAt: now };
}

/// Owner or an accepted, still-active circle member snapshotted on THIS alert.
/// Anyone else gets a 404 (not 403) so alert ids can't be probed.
export async function getAlert(supabase: SupabaseClient, requesterUid: string, alertId: string) {
  const alert = await loadAlertOrThrow(supabase, alertId);
  if (alert.user_id === requesterUid) return await ownerView(supabase, alert);

  const { data: rec } = await supabase
    .from(RECIPIENTS)
    .select("*")
    .eq("emergency_alert_id", alertId)
    .eq("recipient_user_id", requesterUid)
    .maybeSingle();
  if (!rec) throw new SosError("Alert not found.", 404);

  // Removed from the circle mid-alert => access ends immediately.
  const { data: contact } = await supabase.from(CONTACTS).select("status, alerts_enabled").eq("id", rec.contact_id).maybeSingle();
  if (!contact || contact.status !== "active" || !contact.alerts_enabled) throw new SosError("Alert not found.", 404);

  if (!rec.viewed_at) {
    await supabase.from(RECIPIENTS).update({ viewed_at: new Date().toISOString() }).eq("id", rec.id);
    await recordSosAudit(supabase, { alertId, actorUserId: requesterUid, actorRole: "contact", action: "viewed" });
  }

  const { data: victim } = await supabase.from("profiles").select("name, phone").eq("uid", alert.user_id).maybeSingle();
  const others = (await recipientsOf(supabase, alertId)).filter((r: Row) => r.recipient_user_id !== requesterUid);
  const isOpen = OPEN_STATUSES.includes(alert.status);

  return {
    id: alert.id,
    role: "contact",
    status: alert.status,
    emergencyType: alert.emergency_type,
    activatedAt: alert.activated_at,
    victimName: victim?.name || "A Horizon user",
    // Their number is shown only to people they explicitly trusted, and only
    // while the alert is open.
    victimPhone: isOpen ? victim?.phone || null : null,
    // Exact location is withheld once the alert is over.
    location: isOpen ? locationView(alert) : null,
    myAcknowledgedAt: rec.acknowledged_at,
    myHelpContactedAt: rec.help_contacted_at,
    otherContacts: others.map((r: Row) => ({
      name: r.contact_name,
      phoneNumber: isOpen ? r.phone_number : null,
      acknowledgedAt: r.acknowledged_at,
      // Only ever a member's own in-app confirmation.
      helpContactedAt: r.help_contacted_at,
    })),
    safetyNotice: SAFETY_LINE,
  };
}

/// Alerts that need my attention as a circle member (drives the banner).
export async function listAlertsForRecipient(supabase: SupabaseClient, uid: string) {
  const { data: recs, error } = await supabase.from(RECIPIENTS).select("emergency_alert_id, contact_id").eq("recipient_user_id", uid);
  if (error) throw error;
  if (!recs || recs.length === 0) return [];
  const { data: alerts } = await supabase
    .from(ALERTS)
    .select("id, user_id, status, activated_at, expires_at")
    .in("id", recs.map((r: Row) => r.emergency_alert_id))
    .in("status", OPEN_STATUSES);
  const live: Row[] = [];
  for (const a of alerts || []) {
    const fresh = await expireIfStale(supabase, a);
    if (OPEN_STATUSES.includes(fresh.status)) live.push(fresh);
  }
  if (live.length === 0) return [];
  const { data: ps } = await supabase.from("profiles").select("uid,name").in("uid", live.map((a) => a.user_id));
  const names = new Map<string, string>((ps || []).map((p: Row) => [p.uid, p.name || "A Horizon user"]));
  const activeContactIds = new Set(
    ((await supabase.from(CONTACTS).select("id").in("id", recs.map((r: Row) => r.contact_id)).eq("status", "active")).data || []).map((c: Row) => c.id)
  );
  return live
    .filter((a) => recs.some((r: Row) => r.emergency_alert_id === a.id && activeContactIds.has(r.contact_id)))
    .map((a) => ({ id: a.id, victimName: names.get(a.user_id) ?? "A Horizon user", status: a.status, activatedAt: a.activated_at }));
}

export async function getMyActiveAlert(supabase: SupabaseClient, uid: string) {
  const { data } = await supabase.from(ALERTS).select("*").eq("user_id", uid).in("status", OPEN_STATUSES).maybeSingle();
  if (!data) return null;
  const fresh = await expireIfStale(supabase, data);
  return OPEN_STATUSES.includes(fresh.status) ? await ownerView(supabase, fresh) : null;
}

async function requireRecipient(supabase: SupabaseClient, uid: string, alertId: string) {
  const alert = await loadAlertOrThrow(supabase, alertId);
  const { data: rec } = await supabase
    .from(RECIPIENTS)
    .select("*")
    .eq("emergency_alert_id", alertId)
    .eq("recipient_user_id", uid)
    .maybeSingle();
  if (!rec) throw new SosError("Alert not found.", 404);
  const { data: contact } = await supabase.from(CONTACTS).select("status, alerts_enabled").eq("id", rec.contact_id).maybeSingle();
  if (!contact || contact.status !== "active" || !contact.alerts_enabled) throw new SosError("Alert not found.", 404);
  return { alert, rec };
}

export async function acknowledgeAlert(supabase: SupabaseClient, uid: string, alertId: string) {
  const { alert, rec } = await requireRecipient(supabase, uid, alertId);
  if (!OPEN_STATUSES.includes(alert.status)) throw new SosError("This alert is no longer active.", 409, "NOT_ACTIVE");
  if (rec.acknowledged_at) return { ok: true };

  const now = new Date().toISOString();
  await supabase.from(RECIPIENTS).update({ acknowledged_at: now }).eq("id", rec.id);
  if (alert.status === "ACTIVE") {
    await supabase.from(ALERTS).update({ status: "ACKNOWLEDGED", updated_at: now }).eq("id", alertId).eq("status", "ACTIVE");
  }
  await recordSosAudit(supabase, { alertId, actorUserId: uid, actorRole: "contact", action: "acknowledged" });
  await notifyUser(supabase, alert.user_id, {
    type: "sos_update",
    title: "Someone has seen your alert",
    body: `${rec.contact_name} acknowledged your Horizon SOS.`,
    relatedType: "sos",
    relatedId: alertId,
  }).catch((err) => console.error("notifyUser (sos ack) failed:", err));
  return { ok: true };
}

const CONTACT_ACTIONS = ["help_contacted", "called_emergency", "called_person", "viewed_location"];

export async function contactAction(supabase: SupabaseClient, uid: string, alertId: string, action: string) {
  if (!CONTACT_ACTIONS.includes(action)) throw new SosError("Unknown action.");
  const { alert, rec } = await requireRecipient(supabase, uid, alertId);
  if (!OPEN_STATUSES.includes(alert.status)) throw new SosError("This alert is no longer active.", 409, "NOT_ACTIVE");

  if (action === "help_contacted") {
    if (rec.help_contacted_at) return { ok: true };
    await supabase.from(RECIPIENTS).update({ help_contacted_at: new Date().toISOString() }).eq("id", rec.id);
    // Tell the victim and the rest of the circle - worded as a claim BY this
    // person, never as something Horizon did.
    const others = (await recipientsOf(supabase, alertId)).filter((r: Row) => r.recipient_user_id !== uid);
    const message = `${rec.contact_name} says they have contacted emergency services.`;
    await Promise.all(
      [alert.user_id, ...others.map((r: Row) => r.recipient_user_id)].map((target) =>
        notifyUser(supabase, target, {
          type: "sos_update",
          title: "Emergency services contacted",
          body: message,
          relatedType: "sos",
          relatedId: alertId,
        }).catch((err) => console.error("notifyUser (sos help) failed:", err))
      )
    );
  }
  await recordSosAudit(supabase, { alertId, actorUserId: uid, actorRole: "contact", action: `contact_${action}` });
  return { ok: true };
}

async function endAlert(
  supabase: SupabaseClient,
  uid: string,
  alertId: string,
  status: "CANCELLED_BY_USER" | "RESOLVED",
  note?: string
) {
  const alert = await loadAlertOrThrow(supabase, alertId);
  if (alert.user_id !== uid) throw new SosError("Alert not found.", 404);
  if (!OPEN_STATUSES.includes(alert.status)) throw new SosError("This alert is already over.", 409, "NOT_ACTIVE");

  const now = new Date().toISOString();
  const patch: Row = { status, updated_at: now };
  if (status === "CANCELLED_BY_USER") {
    patch.cancelled_at = now;
    patch.cancelled_by = uid;
  } else {
    patch.resolved_at = now;
    patch.resolved_by = uid;
    patch.resolution_note = note ? String(note).slice(0, 500) : null;
  }
  const { error } = await supabase.from(ALERTS).update(patch).eq("id", alertId).in("status", OPEN_STATUSES);
  if (error) throw error;

  const seconds = Math.round((Date.now() - new Date(alert.activated_at).getTime()) / 1000);
  await recordSosAudit(supabase, {
    alertId,
    actorUserId: uid,
    action: status === "CANCELLED_BY_USER" ? "cancelled" : "resolved",
    metadata: { secondsAfterActivation: seconds },
  });

  // A very quick cancel is normal (accident) once; repeated ones go to review.
  if (status === "CANCELLED_BY_USER" && seconds <= 60) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { count } = await supabase
      .from(ALERTS)
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .eq("status", "CANCELLED_BY_USER")
      .gte("activated_at", since);
    if ((count ?? 0) >= 3) {
      await supabase.from(ALERTS).update({ flagged: true, flag_reason: `${count} cancellations in 30 days` }).eq("id", alertId);
      await recordSosAudit(supabase, { alertId, actorRole: "system", action: "auto_flagged_for_review", metadata: { cancellations30d: count } });
    }
  }

  const { data: profile } = await supabase.from("profiles").select("name").eq("uid", uid).maybeSingle();
  const name = profile?.name || "A Horizon user";
  const recipients = await recipientsOf(supabase, alertId);
  await Promise.all(
    recipients.map((r: Row) =>
      notifyUser(supabase, r.recipient_user_id, {
        type: "sos_update",
        title: status === "CANCELLED_BY_USER" ? "🟢 SOS CANCELLED" : "🟢 SOS ENDED",
        body:
          status === "CANCELLED_BY_USER"
            ? `${name} has cancelled the emergency alert.`
            : `${name} has marked their emergency as resolved.`,
        relatedType: "sos",
        relatedId: alertId,
      }).catch((err) => console.error("notifyUser (sos end) failed:", err))
    )
  );
  return { ok: true, status };
}

export function cancelAlert(supabase: SupabaseClient, uid: string, alertId: string, confirmed: boolean) {
  if (confirmed !== true) throw new SosError("Cancelling an emergency alert needs explicit confirmation.");
  return endAlert(supabase, uid, alertId, "CANCELLED_BY_USER");
}

export function resolveAlert(supabase: SupabaseClient, uid: string, alertId: string, note?: string) {
  return endAlert(supabase, uid, alertId, "RESOLVED", note);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function adminSummary(a: Row, names: Map<string, string>, recCounts: Map<string, { total: number; ack: number; help: number }>) {
  const rc = recCounts.get(a.id) ?? { total: 0, ack: 0, help: 0 };
  return {
    id: a.id,
    userId: a.user_id,
    userName: names.get(a.user_id) ?? "Unknown",
    status: a.status,
    emergencyType: a.emergency_type,
    activatedAt: a.activated_at,
    cancelledAt: a.cancelled_at,
    resolvedAt: a.resolved_at,
    flagged: a.flagged,
    flagReason: a.flag_reason,
    preserved: a.preserved,
    hasLocation: a.last_latitude != null,
    lastLocationAt: a.last_location_at,
    recipients: rc.total,
    acknowledged: rc.ack,
    helpContacted: rc.help,
  };
}

/// List view - deliberately carries NO coordinates. Listing is itself logged.
export async function listAlertsForAdmin(
  supabase: SupabaseClient,
  adminUid: string,
  filter: "active" | "flagged" | "all",
  limit = 100
) {
  // Sweep stale open alerts so "active" is honest.
  const { data: stale } = await supabase.from(ALERTS).select("*").in("status", OPEN_STATUSES).lt("expires_at", new Date().toISOString());
  for (const s of stale || []) await expireIfStale(supabase, s);

  let q = supabase.from(ALERTS).select("*").order("activated_at", { ascending: false }).limit(limit);
  if (filter === "active") q = q.in("status", OPEN_STATUSES);
  else if (filter === "flagged") q = q.or("flagged.eq.true,status.eq.FLAGGED_FOR_REVIEW");
  const { data, error } = await q;
  if (error) throw error;
  const alerts = data || [];

  const names = new Map<string, string>();
  const recCounts = new Map<string, { total: number; ack: number; help: number }>();
  if (alerts.length) {
    const { data: ps } = await supabase.from("profiles").select("uid,name").in("uid", [...new Set(alerts.map((a: Row) => a.user_id))]);
    for (const p of ps || []) names.set(p.uid, p.name || "Unknown");
    const { data: recs } = await supabase.from(RECIPIENTS).select("emergency_alert_id, acknowledged_at, help_contacted_at").in("emergency_alert_id", alerts.map((a: Row) => a.id));
    for (const r of recs || []) {
      const c = recCounts.get(r.emergency_alert_id) ?? { total: 0, ack: 0, help: 0 };
      c.total++;
      if (r.acknowledged_at) c.ack++;
      if (r.help_contacted_at) c.help++;
      recCounts.set(r.emergency_alert_id, c);
    }
  }

  await recordSosAudit(supabase, { actorUserId: adminUid, actorRole: "admin", action: "admin_viewed_list", metadata: { filter } });
  return alerts.map((a: Row) => adminSummary(a, names, recCounts));
}

/// Full detail incl. exact location trail, identity and audit history. The
/// route requires the OWNER staff role; this call itself is audited.
export async function getAlertForAdmin(supabase: SupabaseClient, adminUid: string, alertId: string) {
  const alert = await loadAlertOrThrow(supabase, alertId);
  const { data: profile } = await supabase
    .from("profiles")
    .select("uid, name, phone, email, trust_level, sos_restricted, sos_restricted_reason")
    .eq("uid", alert.user_id)
    .maybeSingle();
  const [{ data: locations }, { data: recipients }, { data: audit }, { count: priorAlerts }] = await Promise.all([
    supabase.from(LOCATIONS).select("latitude, longitude, accuracy, recorded_at").eq("emergency_alert_id", alertId).order("recorded_at", { ascending: true }).limit(2000),
    supabase.from(RECIPIENTS).select("*").eq("emergency_alert_id", alertId),
    supabase.from(AUDIT).select("*").eq("emergency_alert_id", alertId).order("timestamp", { ascending: true }),
    supabase.from(ALERTS).select("id", { count: "exact", head: true }).eq("user_id", alert.user_id),
  ]);

  await recordSosAudit(supabase, {
    alertId,
    actorUserId: adminUid,
    actorRole: "admin",
    action: "admin_viewed_detail",
    metadata: { sensitive: ["exact_location", "identity", "audit_log"] },
  });

  return {
    id: alert.id,
    status: alert.status,
    emergencyType: alert.emergency_type,
    activationMethod: alert.activation_method,
    activatedAt: alert.activated_at,
    cancelledAt: alert.cancelled_at,
    resolvedAt: alert.resolved_at,
    resolutionNote: alert.resolution_note,
    flagged: alert.flagged,
    flagReason: alert.flag_reason,
    adminNote: alert.admin_note,
    preserved: alert.preserved,
    deviceInfo: alert.device_info,
    user: profile
      ? {
          uid: profile.uid,
          name: profile.name,
          phone: profile.phone,
          email: profile.email ?? null,
          trustLevel: profile.trust_level,
          sosRestricted: profile.sos_restricted,
          sosRestrictedReason: profile.sos_restricted_reason,
        }
      : null,
    totalAlertsByUser: priorAlerts ?? 0,
    initialLocation:
      alert.initial_latitude != null
        ? { latitude: alert.initial_latitude, longitude: alert.initial_longitude, accuracy: alert.initial_accuracy }
        : null,
    lastLocation: locationView(alert),
    locations: (locations || []).map((l: Row) => ({ latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy, recordedAt: l.recorded_at })),
    recipients: (recipients || []).map((r: Row) => ({
      name: r.contact_name,
      phoneNumber: r.phone_number,
      notifiedAt: r.notified_at,
      viewedAt: r.viewed_at,
      acknowledgedAt: r.acknowledged_at,
      helpContactedAt: r.help_contacted_at,
    })),
    audit: (audit || []).map((a: Row) => ({
      action: a.action,
      actorUserId: a.actor_user_id,
      actorRole: a.actor_role,
      timestamp: a.timestamp,
      metadata: a.metadata,
    })),
  };
}

export async function adminAlertAction(
  supabase: SupabaseClient,
  adminUid: string,
  alertId: string,
  input: { action: string; note?: string }
) {
  const alert = await loadAlertOrThrow(supabase, alertId);
  const note = input.note ? String(input.note).trim().slice(0, 1000) : "";
  const now = new Date().toISOString();
  let patch: Row = {};
  switch (input.action) {
    case "flag":
      if (!note) throw new SosError("Add a reason when flagging an alert.");
      patch = { flagged: true, flag_reason: note };
      break;
    case "unflag":
      patch = { flagged: false, flag_reason: null };
      break;
    case "mark_review":
      if (OPEN_STATUSES.includes(alert.status)) throw new SosError("An active alert can't be moved to review - wait until it has ended.");
      patch = { status: "FLAGGED_FOR_REVIEW", flagged: true, flag_reason: alert.flag_reason ?? (note || "Marked for review") };
      break;
    case "note":
      if (!note) throw new SosError("The note is empty.");
      patch = { admin_note: note };
      break;
    case "preserve":
      patch = { preserved: true };
      break;
    case "unpreserve":
      patch = { preserved: false };
      break;
    default:
      throw new SosError("Unknown action.");
  }
  const { error } = await supabase.from(ALERTS).update({ ...patch, updated_at: now }).eq("id", alertId);
  if (error) throw error;
  await recordSosAudit(supabase, {
    alertId,
    actorUserId: adminUid,
    actorRole: "admin",
    action: `admin_${input.action}`,
    metadata: { note: note || null },
  });
  return { ok: true };
}

/// Restrict/allow a user's SOS access. An admin decision, with a mandatory
/// reason, never applied automatically.
export async function adminSetSosRestriction(
  supabase: SupabaseClient,
  adminUid: string,
  userId: string,
  restricted: boolean,
  reason: string
) {
  if (!reason || !reason.trim()) throw new SosError("A reason is required.");
  const { error } = await supabase
    .from("profiles")
    .update({
      sos_restricted: restricted,
      sos_restricted_reason: restricted ? reason.trim().slice(0, 500) : null,
      sos_restricted_at: restricted ? new Date().toISOString() : null,
    })
    .eq("uid", userId);
  if (error) throw error;
  await recordSosAudit(supabase, {
    actorUserId: adminUid,
    actorRole: "admin",
    action: restricted ? "admin_restricted_sos" : "admin_restored_sos",
    metadata: { userId, reason: reason.trim() },
  });
  return { ok: true };
}
