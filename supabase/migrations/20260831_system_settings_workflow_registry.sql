-- Central n8n Workflow registry — seed rows for Admin -> Settings -> System.
--
-- Run this manually against the Supabase project (SQL editor / your own
-- tooling) — it is NOT executed automatically by this repo, and was NOT
-- run as part of this change.
--
-- ---------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------
-- Reusable n8n workflows (AI-Agent-Core, Inbound-Media-Core) are invoked
-- from the parent workflows with `Execute Workflow` nodes. Previously the
-- target workflow ID was hardcoded in every parent, so importing a new
-- Core version (new workflow ID) meant re-editing every parent.
--
-- The parents now read the Core workflow IDs at runtime from
-- public.system_settings (resourceLocator "id" mode expression on the
-- Execute Workflow node). This migration just makes sure the rows exist
-- with the current live IDs. Human Reply keeps its existing
-- `human_reply_webhook_url` row and behavior — unchanged.
--
-- ---------------------------------------------------------------------
-- Scope / safety
-- ---------------------------------------------------------------------
-- - public.system_settings predates this repo's migrations; its exact
--   columns are (key text, value text) as used by api/system-settings.js
--   and api/_lib/humanReply.js. This migration touches only those two
--   columns and adds rows only where the key does not already exist.
-- - The UNIQUE(key) guard below is a no-op if the constraint/PK already
--   exists (it is treated as unique in practice by all existing code:
--   `.eq("key", ...).maybeSingle()` and `UPDATE ... WHERE key = ...`).
-- - No existing row is modified. `human_reply_webhook_url` is left exactly
--   as-is (only listed here so a fresh DB gets an empty placeholder row).

begin;

-- 1. Ensure key uniqueness (idempotent). Skipped if any unique index on
--    (key) already exists.
do $$
begin
  if not exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and tablename = 'system_settings'
       and indexdef ilike '%unique%'
       and indexdef ilike '%(key)%'
  ) then
    alter table public.system_settings
      add constraint system_settings_key_key unique (key);
  end if;
end $$;

-- 2. Seed the registry rows. Uses `where not exists` (not ON CONFLICT) so
--    it is safe regardless of the exact constraint name.
insert into public.system_settings (key, value)
select v.key, v.value
  from (values
    ('ai_agent_core_workflow_id',      'x2T6z94nazQWk2NY'),
    ('inbound_media_core_workflow_id', 'EAWx4flzCX0b7RJ6'),
    ('ai_agent_core_workflow_url',     ''),
    ('inbound_media_core_workflow_url',''),
    ('human_reply_webhook_url',        '')
  ) as v(key, value)
 where not exists (
   select 1 from public.system_settings s where s.key = v.key
 );

commit;

-- ---------------------------------------------------------------------
-- OPTIONAL — only if system_settings has RLS ENABLED and it blocks the
-- read the n8n parent workflows now make (they read these two keys with
-- the anon apikey, the same way every other parent Supabase read works).
-- If the other parent reads already work against RLS-protected tables,
-- this is not needed. Review before running.
-- ---------------------------------------------------------------------
-- alter table public.system_settings enable row level security;
-- drop policy if exists system_settings_read_workflow_registry on public.system_settings;
-- create policy system_settings_read_workflow_registry
--   on public.system_settings
--   for select
--   using (key in ('ai_agent_core_workflow_id', 'inbound_media_core_workflow_id'));
