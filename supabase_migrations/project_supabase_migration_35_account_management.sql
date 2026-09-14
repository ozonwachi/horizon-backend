-- Task: account-management gap fixes - avatar upload, and keeping
-- public.profiles.email in sync after a user confirms an email change.
-- (Change password / forgot password / edit display name need no schema
-- changes at all - they're pure gotrue/auth.updateUser calls and a plain
-- column update, see change_password_screen.dart, reset_password_screen.dart,
-- and UserProfileService.setName.)
--
-- Run this in the Supabase SQL Editor after migration_34.
-- Safe to run once; re-running is a no-op everywhere it matters.
--
-- ONE MANUAL DASHBOARD STEP THIS FILE CANNOT DO FOR YOU:
-- Go to Supabase Dashboard -> Authentication -> URL Configuration -> Redirect
-- URLs, and add:
--   io.projecthorizon.auth://reset-callback/
-- This is the custom-scheme deep link the forgot-password email link (and
-- the confirmation link Supabase sends for an email-address change) points
-- back into the app with (see AndroidManifest.xml's new intent-filter and
-- SupabaseConfig.passwordResetRedirectUrl). Without this entry in the
-- allow-list, Supabase's GoTrue rejects the redirect and those links won't
-- open the app - everything else in this feature still works, that one
-- link just won't complete.

-- ----------------------------------------------------------------------------
-- profiles.avatar_url
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_url text;

-- ----------------------------------------------------------------------------
-- Storage bucket for profile pictures
-- ----------------------------------------------------------------------------
-- Public read (a profile picture needs to be visible to anyone viewing that
-- user's public profile, signed in or not) - same public-read/owner-write
-- shape as the listing-media bucket (migration_04), just a separate bucket
-- since avatars are a single file per user with a fixed filename (upsert
-- overwrite, see AvatarUploadService), not an open-ended folder of photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880, -- 5MB - a profile picture is always a single cropped/compressed image
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- RLS on storage.objects for the avatars bucket
-- ----------------------------------------------------------------------------
-- Path convention: "{auth.uid()}/avatar.{ext}" - see AvatarUploadService.
-- storage.foldername(name)[1] is always the uploader's own uid for anything
-- written through the app.
drop policy if exists "Public read access to avatars" on storage.objects;
create policy "Public read access to avatars"
on storage.objects for select
using (bucket_id = 'avatars');

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can update their own avatar" on storage.objects;
create policy "Users can update their own avatar"
on storage.objects for update
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete their own avatar" on storage.objects;
create policy "Users can delete their own avatar"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ----------------------------------------------------------------------------
-- Keep public.profiles.email in sync after a confirmed email change
-- ----------------------------------------------------------------------------
-- ChangeEmailScreen calls auth.updateUser(email: ...), which only starts the
-- change - Supabase emails a confirmation link (to the new address, and to
-- the old one too if "Secure email change" is on in the dashboard) and
-- auth.users.email doesn't actually update until the user clicks it, which
-- can happen minutes later with the app long since closed. There's no
-- client-side hook for that moment, so this is a server-side trigger instead
-- - the exact same reasoning as why profile creation itself is normally
-- triggered off auth.users, just for an update instead of an insert.
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where uid = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.sync_profile_email();
