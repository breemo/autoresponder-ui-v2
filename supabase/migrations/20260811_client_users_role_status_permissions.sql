-- Phase 3A: client_users foundation (role, status, reserved permission overrides)
--
-- Approved 2026-08-11. Run this manually against the Supabase project
-- (SQL editor or your migration tooling) — it is not executed automatically
-- by this repo, and no code in this repo has a live DB connection to run it.
--
-- Backfill rationale: every client_users row that exists today was created
-- by the single "create client" flow in AdminClients.jsx (one row per
-- client, linking its original/primary account). No other code path has
-- ever inserted into this table in production, so every existing row is
-- unconditionally the account owner.

begin;

alter table public.client_users
  add column if not exists role text not null default 'agent',
  add column if not exists is_active boolean not null default true,
  add column if not exists permissions_overrides jsonb;

alter table public.client_users
  add constraint client_users_role_check
  check (role in ('owner', 'manager', 'agent'));

update public.client_users
set role = 'owner';

commit;
