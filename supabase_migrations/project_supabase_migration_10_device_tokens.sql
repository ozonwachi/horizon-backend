-- Task: push notifications when someone messages you, even with the app
-- fully closed. This table is the one new piece of state - one row per
-- device a user has opened the app on, holding the FCM token for that
-- device. `token` is the primary key (not `uid`) because a user can have
-- more than one device, and because upserting on conflict(token) is
-- exactly the right behavior when the same physical device later signs in
-- as a different account (the token moves to whoever's currently signed in
-- on it, instead of erroring or leaving a stale owner).
--
-- Registration/removal happens directly from the Flutter client via RLS
-- (see push_notification_service.dart) - no Edge Function route needed for
-- that half, same reasoning as favorites. Sending is admin-only (service
-- role bypasses RLS to read every token for a given recipient) - see
-- pushService.ts / the webhooks function's new /message-notify route.
create table public.device_tokens (
  token text primary key,
  uid uuid not null references public.profiles(uid) on delete cascade,
  platform text not null check (platform in ('android', 'ios')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index device_tokens_uid_idx on public.device_tokens (uid);

alter table public.device_tokens enable row level security;

create policy "users manage their own device tokens" on public.device_tokens
  for all using (auth.uid() = uid) with check (auth.uid() = uid);
