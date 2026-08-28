-- Task: "report abuse" on a listing (extensible to job/barter posts too -
-- target_type already allows for it, just nothing files one yet). A report
-- snapshots the target's title/owner and the reporter's name at filing time
-- so it stays meaningful to an admin even if the post is later edited,
-- deleted, or the poster changes their name.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('listing', 'job', 'barter')),
  target_id uuid not null,
  target_title text not null default '',
  target_owner_uid uuid not null references public.profiles(uid),
  target_owner_name text not null default '',
  reporter_uid uuid not null references public.profiles(uid),
  reporter_name text not null default '',
  reason text not null,
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(uid)
);
create index reports_status_created_idx on public.reports (status, created_at desc);

alter table public.reports enable row level security;

-- Any signed-in user can file a report as themselves, and only as
-- themselves. There is deliberately no select policy for regular users -
-- reports are for admin review only, read via the service-role admin Edge
-- Function route (see admin/index.ts's GET/PATCH /reports), same pattern as
-- the audit log.
create policy "users can file their own reports" on public.reports
  for insert with check (auth.uid() = reporter_uid);
