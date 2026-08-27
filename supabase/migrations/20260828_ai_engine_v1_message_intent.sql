-- AI Engine V1 — Message Intent tracking (AI Agent architecture).
--
-- Schema-only, fully additive. Adds three nullable columns to
-- public.messages so every AI-processed inbound message can carry the
-- semantic intent the AI Agent resolved for it (for future CRM /
-- analytics). Does NOT touch any other table, index, constraint, RLS
-- policy, or existing column. Run this manually against the Supabase
-- project (SQL editor / your own tooling) — it is NOT executed
-- automatically by this repo, and was NOT run as part of this change.
--
-- ---------------------------------------------------------------------
-- Why on public.messages (not a new table)
-- ---------------------------------------------------------------------
-- Intent is a property of one specific inbound customer message, 1:1 with
-- the row that already exists for it (n8n's `insert message` node writes
-- every inbound message before the AI branch runs). A separate table
-- would need its own FK, its own insert path, and a join on every read
-- for no benefit at V1 scale. If richer per-message CRM signals are ever
-- needed, intent_metadata (jsonb) below is the extension point — no
-- schema change required to start storing structured detail there.
--
-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
--   intent            text  null  — the resolved V1 intent, one of the
--                                   fixed taxonomy below, or NULL for any
--                                   message not processed by the AI Agent
--                                   (every message that exists today, and
--                                   every AUTO / WELCOME_ONLY / human
--                                   message going forward — unchanged).
--   intent_confidence real  null  — optional 0..1 signal. NULL when the
--                                   intent was derived deterministically
--                                   from a tool the Agent invoked
--                                   (start_order -> order, etc.) rather
--                                   than classified.
--   intent_metadata   jsonb null  — optional structured detail
--                                   (e.g. { "tool": "request_handover",
--                                   "source": "agent_classification" }).
--                                   Never customer PII beyond what the
--                                   message row itself already holds.
--
-- The taxonomy is intentionally small and closed (CHECK-enforced). It
-- matches the AI Agent build spec (engineering/processes/) and the
-- backend validator in api/_lib/aiTools.js — keep all three in sync if
-- this set ever changes.

begin;

alter table public.messages
  add column if not exists intent text null,
  add column if not exists intent_confidence real null,
  add column if not exists intent_metadata jsonb null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'messages_intent_check'
  ) then
    alter table public.messages
      add constraint messages_intent_check
      check (
        intent is null or intent in (
          'greeting',
          'knowledge',
          'price',
          'order',
          'booking',
          'asset_request',
          'support',
          'complaint',
          'human_request',
          'lead',
          'closing',
          'unknown'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'messages_intent_confidence_check'
  ) then
    alter table public.messages
      add constraint messages_intent_confidence_check
      check (
        intent_confidence is null
        or (intent_confidence >= 0 and intent_confidence <= 1)
      );
  end if;
end
$$;

comment on column public.messages.intent is
  'AI Engine V1 — semantic intent the AI Agent resolved for this inbound message. One of: greeting | knowledge | price | order | booking | asset_request | support | complaint | human_request | lead | closing | unknown. NULL for every message not processed by the AI Agent (all existing rows, and all AUTO / WELCOME_ONLY / human messages). Written only by api/_lib/aiTools.js (server-side, conversation_id-derived client scope). Taxonomy is CHECK-enforced (messages_intent_check) and mirrored in api/_lib/aiTools.js and the AI Agent build spec — keep in sync.';
comment on column public.messages.intent_confidence is
  'Optional 0..1 confidence for a classified intent. NULL when intent was derived deterministically from a tool the Agent invoked rather than classified.';
comment on column public.messages.intent_metadata is
  'Optional jsonb detail about how the intent was resolved (e.g. originating tool). Extension point for future CRM signals without a schema change. Never additional customer PII.';

commit;

-- ---------------------------------------------------------------------
-- No index added here on purpose
-- ---------------------------------------------------------------------
-- No query path in this change filters messages by intent. A future
-- analytics/CRM read that groups by intent should add a partial index
-- then, chosen for that query's real shape, e.g.:
--   create index concurrently messages_client_intent_idx
--     on public.messages (client_id, intent) where intent is not null;
-- Adding it now, with nothing reading it, is exactly the speculative-
-- index risk the Phase 1 foundation migration was explicit about avoiding.
