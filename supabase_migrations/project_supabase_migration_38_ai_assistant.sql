-- ============================================================================
-- AI Assistant plumbing (Item 3): dispute-triage suggestions and fraud-scan
-- flags both need somewhere to persist so an admin can review them without
-- re-running the (paid) AI call every time. The other three features
-- (natural-language search, listing help/pricing, FAQ chatbot) are
-- stateless request/response and need no table.
--
-- Everything the AI produces here is advisory only - see
-- supabase/functions/_shared/aiService.ts's doc comment. No table here is
-- ever written to by anything except the `ai` edge function (service-role
-- client), and no RLS policy grants the anon/authenticated Flutter client
-- direct access - same "admin-only table, no policies" pattern as
-- withdrawal_approvals/audit_logs (see migration_36).
--
-- Run this in the Supabase SQL Editor after migration_37.
-- ============================================================================

create table if not exists public.ai_dispute_suggestions (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.escrow_agreements(id),
  tranche_id uuid references public.escrow_tranches(id),
  suggestion text not null,
  requested_by uuid not null references public.profiles(uid),
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_dispute_suggestions_agreement_idx
  on public.ai_dispute_suggestions (agreement_id, created_at desc);

alter table public.ai_dispute_suggestions enable row level security;

create table if not exists public.ai_fraud_flags (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('user', 'listing', 'job', 'barter_post', 'agreement')),
  subject_id uuid not null,
  reason text not null,
  severity text not null check (severity in ('low', 'medium', 'high')),
  signals jsonb,
  model text not null,
  resolved boolean not null default false,
  resolved_by uuid references public.profiles(uid),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now()
);

create index if not exists ai_fraud_flags_unresolved_idx
  on public.ai_fraud_flags (resolved, created_at desc);

alter table public.ai_fraud_flags enable row level security;
