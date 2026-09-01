-- Task: manual-review identity verification. A user submits a photo of an
-- ID document (front, optionally back) plus a selfie; an admin reviews them
-- by eye (no automated ID-matching/liveness vendor - see the in-chat
-- explanation of why manual review was chosen for this stage) and
-- approves or rejects. Approval is what flips profiles.trust_level from
-- 'basic' to 'verified' for the first time - this is the only thing that
-- sets trust_level today; nothing else in the app does.
--
-- Run this in the Supabase SQL Editor after migration_10.
-- Safe to run once; re-running is guarded everywhere it matters.

-- ----------------------------------------------------------------------------
-- verification_requests table
-- ----------------------------------------------------------------------------
create table public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references public.profiles(uid),
  document_type text not null
    check (document_type in ('national_id', 'drivers_license', 'passport', 'voters_card')),
  -- Storage OBJECT PATHS, not URLs - the bucket is private, so a URL alone
  -- would be useless. An admin gets a fresh signed URL generated on demand
  -- from this path each time they open the request (see admin/index.ts's
  -- GET /admin/verifications/:id) - that's what makes the photos
  -- retrievable indefinitely rather than only during a short-lived initial
  -- review window.
  front_path text not null,
  back_path text, -- null for document types with no back (e.g. passport)
  selfie_path text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_notes text not null default '',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(uid)
);
create index verification_requests_status_created_idx
  on public.verification_requests (status, created_at desc);
create index verification_requests_uid_idx on public.verification_requests (uid);

alter table public.verification_requests enable row level security;

-- A user can file their own request and check on its status, but there's no
-- update/delete policy for regular users - once submitted, a request is
-- reviewed or re-submitted as a brand new row, never edited in place.
-- Admin review goes through the service-role admin Edge Function route
-- (bypasses RLS entirely), same pattern as reports/audit log.
create policy "users can file their own verification requests"
  on public.verification_requests
  for insert with check (auth.uid() = uid);

create policy "users can read their own verification requests"
  on public.verification_requests
  for select using (auth.uid() = uid);

-- ----------------------------------------------------------------------------
-- Storage bucket - PRIVATE, unlike listing-media. ID photos and selfies are
-- sensitive; nothing about this bucket is public-read.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'identity-documents',
  'identity-documents',
  false,
  15728640, -- 15MB - stills only, no video
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- RLS on storage.objects for this bucket
-- ----------------------------------------------------------------------------
-- Same "{auth.uid()}/..." path-ownership convention as listing-media (see
-- migration_04) - (storage.foldername(name))[1] is always the uploader's
-- own uid for anything written through the app. Deliberately NO public (or
-- even cross-user authenticated) select policy - admin viewing goes through
-- server-side signed URLs from the service-role client in the Edge
-- Function, never a client-visible storage policy. Only the owner can read
-- their own upload back directly.
drop policy if exists "Users can upload their own identity documents" on storage.objects;
create policy "Users can upload their own identity documents"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'identity-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can read their own identity documents" on storage.objects;
create policy "Users can read their own identity documents"
on storage.objects for select
to authenticated
using (
  bucket_id = 'identity-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Deliberately no update/delete policy - a submitted document is immutable;
-- a mistaken submission is superseded by a new verification_requests row +
-- new storage objects, not edited/replaced in place.
