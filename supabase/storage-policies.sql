-- Run this in Supabase → SQL Editor (lets logged-in users upload videos,
-- and lets anyone view them). Needed in addition to making the 'videos' bucket public.

create policy "videos public read"
  on storage.objects for select
  using (bucket_id = 'videos');

create policy "videos authenticated upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'videos');
