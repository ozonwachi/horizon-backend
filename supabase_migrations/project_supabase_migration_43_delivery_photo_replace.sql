-- ============================================================================
-- Let a seller REPLACE their handover photo.
--
-- migration_39 only gave delivery-photos an INSERT and a SELECT policy. The app
-- uploads with upsert: true, so replacing an existing photo is an UPDATE on
-- storage.objects, which had no policy and was refused. Same own-folder rule
-- as the insert policy.
-- ============================================================================

drop policy if exists "Sellers can replace their own handover photos" on storage.objects;
create policy "Sellers can replace their own handover photos"
on storage.objects for update
to authenticated
using (
  bucket_id = 'delivery-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'delivery-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);
