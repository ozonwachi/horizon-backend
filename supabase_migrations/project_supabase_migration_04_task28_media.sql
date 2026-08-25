-- Task #28: product photo + video upload on Supabase Storage.
-- Run this in the Supabase SQL Editor after migration_02 and migration_03.
-- Safe to run once; re-running is guarded everywhere it matters.
--
-- No ALTER TABLE needed here: listings, jobs, and barter_posts already got
-- `photo_urls text[]` and `video_url text` columns back in the original
-- project_supabase_schema.sql (Task #22 anticipated this feature ahead of
-- time) - if you already ran that file, those columns exist. This
-- migration only adds the Storage bucket + RLS those columns needed to
-- actually be usable.

-- ----------------------------------------------------------------------------
-- Storage bucket
-- ----------------------------------------------------------------------------
-- Public read (anyone browsing a listing/job/barter post needs to see its
-- photos, signed in or not) - writes are locked down by the RLS policies
-- below instead of by bucket privacy. Shared by all three post types -
-- despite the name, "listing-media" is really "post media"; renaming it
-- would just be migration churn for no functional benefit, so the comment
-- here is the correction instead. file_size_limit is in bytes; keep
-- MediaUploadService's maxImageBytes/maxVideoBytes in the Flutter app in
-- sync with these if you change them - the client-side check exists only
-- to fail fast with a friendly message, this is the check that actually
-- matters.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-media',
  'listing-media',
  true,
  104857600, -- 100MB (covers the video case; images are checked client-side to 8MB)
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'video/mp4', 'video/quicktime', 'video/webm'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- RLS on storage.objects for this bucket
-- ----------------------------------------------------------------------------
-- Path convention enforced here: "{auth.uid()}/images/..." or
-- "{auth.uid()}/videos/..." - see MediaUploadService._upload in
-- lib/services/media_upload_service.dart. storage.foldername(name) splits
-- the object path into its folder segments, so segment [1] is always the
-- uploader's own uid for anything written through the app, regardless of
-- which post type (listing/job/barter) it ends up attached to.
drop policy if exists "Public read access to listing media" on storage.objects;
create policy "Public read access to listing media"
on storage.objects for select
using (bucket_id = 'listing-media');

drop policy if exists "Users can upload listing media to their own folder" on storage.objects;
create policy "Users can upload listing media to their own folder"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'listing-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can update their own listing media" on storage.objects;
create policy "Users can update their own listing media"
on storage.objects for update
to authenticated
using (
  bucket_id = 'listing-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users can delete their own listing media" on storage.objects;
create policy "Users can delete their own listing media"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'listing-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);
