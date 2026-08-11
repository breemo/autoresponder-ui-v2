-- Final role model: owner / agent / it (manager removed).
--
-- The Phase 3A migration (20260811_client_users_role_status_permissions.sql)
-- allowed owner/manager/agent. This migration converts any existing
-- 'manager' rows to 'agent' (agent is the intended successor to the old
-- operational Manager role) and then tightens the constraint to only
-- owner/agent/it. Must run AFTER 20260811 has been applied.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo.

begin;

update public.client_users
set role = 'agent'
where role = 'manager';

alter table public.client_users
  drop constraint if exists client_users_role_check;

alter table public.client_users
  add constraint client_users_role_check
  check (role in ('owner', 'agent', 'it'));

commit;
