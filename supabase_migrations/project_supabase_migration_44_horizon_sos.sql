-- ============================================================================
-- Horizon SOS / Security Circle.
--
-- Safety-critical, so the design is deliberately stricter than ordinary
-- marketplace data:
--   * Every table has RLS enabled with NO policies: nothing is readable or
--     writable from the client at all. Everything goes through the `sos` edge
--     function (service role), which does its own authorization - a circle
--     member can only ever read the alert of someone who added them, accepted,
--     and was snapshotted as a recipient of THAT alert.
--   * emergency_audit_logs is append-only, enforced by triggers (no UPDATE,
--     DELETE or TRUNCATE, even for the service role). Cancelling an alert never
--     removes anything.
--   * Only verified users (profiles.trust_level <> 'basic') may activate; the
--     edge function checks this server-side.
--
-- Future-proofing (Phase 3) is in the schema already, unused for now:
--   emergency_alerts.activation_method ('button' now, 'silent' later) and
--   emergency_alerts.audience ('circle' now; a future 'nearby_verified' mode
--   would be added to the check, with its own limited-information payload).
--
-- Run in the Supabase SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. profiles: admin-imposed SOS restriction (never automatic - an admin
--    decides, and the action is audited).
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists sos_restricted boolean not null default false;
alter table public.profiles add column if not exists sos_restricted_reason text;
alter table public.profiles add column if not exists sos_restricted_at timestamptz;

-- ----------------------------------------------------------------------------
-- 2. emergency_contacts (the Security Circle)
--    status: pending  = added by the owner, waiting for the contact to accept
--            active   = accepted; receives alerts
--            declined = the contact said no
--            removed  = owner removed them (row kept so past alerts still
--                       reference who was notified)
-- ----------------------------------------------------------------------------
create table if not exists public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.profiles(uid),
  contact_user_id uuid references public.profiles(uid),
  contact_name text not null,
  phone_number text,
  relationship text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'declined', 'removed')),
  -- Permission to receive SOS alerts. Set true only when the contact accepts.
  alerts_enabled boolean not null default false,
  -- The owner explicitly confirmed adding this person (required by the API).
  owner_confirmed_at timestamptz not null default now(),
  -- For contacts who are not on Horizon yet: a code the owner shares (the
  -- invitee enters it after signing up). There is no SMS provider wired in,
  -- so the invite is delivered by the owner sharing it themselves.
  invite_code text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_user_id is not null or phone_number is not null),
  check (contact_user_id is null or contact_user_id <> owner_user_id)
);

create index if not exists emergency_contacts_owner_idx on public.emergency_contacts (owner_user_id);
create index if not exists emergency_contacts_contact_user_idx on public.emergency_contacts (contact_user_id) where contact_user_id is not null;
create index if not exists emergency_contacts_phone_idx on public.emergency_contacts (phone_number) where phone_number is not null;
create unique index if not exists emergency_contacts_invite_code_uidx on public.emergency_contacts (invite_code) where invite_code is not null;
create unique index if not exists emergency_contacts_owner_user_uidx
  on public.emergency_contacts (owner_user_id, contact_user_id)
  where contact_user_id is not null and status in ('pending', 'active');
create unique index if not exists emergency_contacts_owner_phone_uidx
  on public.emergency_contacts (owner_user_id, phone_number)
  where contact_user_id is null and phone_number is not null and status in ('pending', 'active');

alter table public.emergency_contacts enable row level security;

-- ----------------------------------------------------------------------------
-- 3. emergency_alerts
-- ----------------------------------------------------------------------------
create table if not exists public.emergency_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(uid),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'ACKNOWLEDGED', 'CANCELLED_BY_USER', 'RESOLVED', 'EXPIRED', 'FLAGGED_FOR_REVIEW')),
  emergency_type text
    check (emergency_type is null or emergency_type in
      ('immediate_danger', 'robbery', 'attack', 'followed', 'accident', 'medical', 'other')),
  activation_method text not null default 'button' check (activation_method in ('button', 'silent')),
  audience text not null default 'circle' check (audience in ('circle')),
  activated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours'),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(uid),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(uid),
  resolution_note text,

  initial_latitude double precision,
  initial_longitude double precision,
  initial_accuracy double precision,
  -- Latest known location, denormalised so recipients' polling is one row read.
  last_latitude double precision,
  last_longitude double precision,
  last_accuracy double precision,
  last_location_at timestamptz,

  -- Coarse device/session context only (platform, app version) - no IDs.
  device_info jsonb,

  -- Abuse review. Flagging is advisory: it puts the alert in front of an
  -- admin; nothing is punished automatically.
  flagged boolean not null default false,
  flag_reason text,
  admin_note text,
  preserved boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists emergency_alerts_user_idx on public.emergency_alerts (user_id, activated_at desc);
create index if not exists emergency_alerts_activated_idx on public.emergency_alerts (activated_at desc);
create index if not exists emergency_alerts_open_idx on public.emergency_alerts (status) where status in ('ACTIVE', 'ACKNOWLEDGED');
create index if not exists emergency_alerts_flagged_idx on public.emergency_alerts (flagged) where flagged;
-- At most one live alert per user: a double activation returns the existing one.
create unique index if not exists emergency_alerts_one_open_per_user
  on public.emergency_alerts (user_id) where status in ('ACTIVE', 'ACKNOWLEDGED');

alter table public.emergency_alerts enable row level security;

-- ----------------------------------------------------------------------------
-- 4. emergency_locations - every location fix during an alert
-- ----------------------------------------------------------------------------
create table if not exists public.emergency_locations (
  id uuid primary key default gen_random_uuid(),
  emergency_alert_id uuid not null references public.emergency_alerts(id),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy double precision check (accuracy is null or accuracy >= 0),
  recorded_at timestamptz not null default now()
);

create index if not exists emergency_locations_alert_idx on public.emergency_locations (emergency_alert_id, recorded_at desc);

alter table public.emergency_locations enable row level security;

-- ----------------------------------------------------------------------------
-- 5. emergency_alert_recipients - who was notified for THIS alert. This is the
--    authorization list: only these people may read the alert.
-- ----------------------------------------------------------------------------
create table if not exists public.emergency_alert_recipients (
  id uuid primary key default gen_random_uuid(),
  emergency_alert_id uuid not null references public.emergency_alerts(id),
  contact_id uuid not null references public.emergency_contacts(id),
  recipient_user_id uuid not null references public.profiles(uid),
  contact_name text not null,
  phone_number text,
  notified_at timestamptz,
  viewed_at timestamptz,
  acknowledged_at timestamptz,
  -- Set ONLY when the contact confirms it in the app. Horizon has no
  -- emergency-services integration, so this is the only source of "help
  -- contacted" and it is always attributed to that person.
  help_contacted_at timestamptz,
  unique (emergency_alert_id, contact_id)
);

create index if not exists emergency_recipients_alert_idx on public.emergency_alert_recipients (emergency_alert_id);
create index if not exists emergency_recipients_user_idx on public.emergency_alert_recipients (recipient_user_id, emergency_alert_id);

alter table public.emergency_alert_recipients enable row level security;

-- ----------------------------------------------------------------------------
-- 6. emergency_audit_logs - append-only.
-- ----------------------------------------------------------------------------
create table if not exists public.emergency_audit_logs (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately NOT a foreign key with cascade: nothing may ever remove
  -- these rows. Null for events not tied to one alert (e.g. contact changes,
  -- an admin restricting someone's SOS access).
  emergency_alert_id uuid,
  actor_user_id uuid,
  actor_role text not null default 'user' check (actor_role in ('user', 'contact', 'admin', 'system')),
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  "timestamp" timestamptz not null default now()
);

create index if not exists emergency_audit_alert_idx on public.emergency_audit_logs (emergency_alert_id, "timestamp");
create index if not exists emergency_audit_actor_idx on public.emergency_audit_logs (actor_user_id, "timestamp" desc);

alter table public.emergency_audit_logs enable row level security;

create or replace function public.emergency_audit_logs_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'emergency_audit_logs is append-only';
end;
$$;

drop trigger if exists emergency_audit_no_update_delete on public.emergency_audit_logs;
create trigger emergency_audit_no_update_delete
  before update or delete on public.emergency_audit_logs
  for each row execute function public.emergency_audit_logs_immutable();

drop trigger if exists emergency_audit_no_truncate on public.emergency_audit_logs;
create trigger emergency_audit_no_truncate
  before truncate on public.emergency_audit_logs
  for each statement execute function public.emergency_audit_logs_immutable();
