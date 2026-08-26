-- AI Engine V1 -- Phase 1: AI Behavior backfill from legacy config.
--
-- Kept in its OWN migration file, separate from
-- 20260826_ai_engine_v1_phase1_foundation.sql (pure DDL) on purpose: this
-- file is pure DML (one INSERT ... SELECT) so it can be reviewed, run, or
-- skipped independently of the schema-creation migration. Requires
-- 20260826_ai_engine_v1_phase1_foundation.sql to have already been run
-- (client_ai_behavior must exist).
--
-- Run this manually against the Supabase project -- it is NOT executed
-- automatically by this repo, and was NOT run as part of this change.
--
-- EXACT SCOPE -- read this before running:
--   - Migrates ONLY 3 AI Behavior fields: reply_tone, language (->
--     default_language), special_instructions -- read from
--     client_feature_integrations.config for each client's ai_auto_reply
--     integration row.
--   - client_ai_behavior's other 4 AI Behavior V1 columns --
--     personality, booking_instructions, escalation_instructions,
--     forbidden_rules -- have NO legacy config equivalent anywhere
--     (verified: no such keys exist in client_feature_integrations.config
--     today). This statement does not list them in its INSERT column
--     list, so every backfilled row gets them at their table default --
--     personality/booking_instructions/escalation_instructions = null,
--     forbidden_rules = '[]'::jsonb -- never an invented value.
--   - Does NOT touch `clients` in any way. Business Profile fields
--     (business_name, business_description, phone, working_hours) are
--     explicitly excluded, per instruction -- Phase 0 found real drift
--     between clients.* and config.* for at least one client (the "birds"
--     incident's client, client pro), and clients.* remains authoritative
--     pending manual, per-client review -- never an automatic migration.
--   - Never overwrites an existing client_ai_behavior row. client_id is
--     UNIQUE on that table; this statement is
--     `insert ... on conflict (client_id) do nothing`, so it only ever
--     CREATES a row where none exists yet. Safe to run more than once --
--     every re-run after the first is a no-op.
--   - A client with no ai_auto_reply client_feature_integrations row gets
--     no client_ai_behavior row from this migration (nothing to seed
--     from) -- not an error, not a default-filled row.
--   - Empty-string config values are stored as NULL (via nullif(btrim(...),
--     '')), not as an empty string -- so a client whose config.reply_tone
--     was "" ends up with reply_tone = null, which the application layer
--     (a later phase) already treats the same as "use the friendly/ar
--     default" when it reads this table.
--
-- Concretely, for the specific client already identified in the Phase 0
-- report (client pro, 89c06af9-6d4f-428e-9574-beefd648632e), whose live
-- config was already verified to hold reply_tone="friendly",
-- language="ar", and no special_instructions: this creates one
-- client_ai_behavior row with reply_tone='friendly', default_language='ar',
-- special_instructions=null -- clients.business_name/business_description/
-- phone/working_hours are completely untouched by this file, exactly as
-- instructed.

begin;

insert into public.client_ai_behavior (client_id, reply_tone, default_language, special_instructions)
select
  cfi.client_id,
  nullif(btrim(cfi.config->>'reply_tone'), ''),
  nullif(btrim(cfi.config->>'language'), ''),
  nullif(btrim(cfi.config->>'special_instructions'), '')
from public.client_feature_integrations cfi
join public.features f
  on f.id = cfi.feature_id
 and f.slug = 'ai_auto_reply'
on conflict (client_id) do nothing;

commit;
