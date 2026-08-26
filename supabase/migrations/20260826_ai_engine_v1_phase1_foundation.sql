-- AI Engine V1 -- Phase 1: Database Foundation.
--
-- Schema-only, fully additive. Nothing in this migration is read or
-- written by any application, API, or n8n code yet -- client_feature_
-- integrations.config remains the live source for AI prompt assembly
-- until an explicit later-phase cutover (see the AI Engine V1 blueprint /
-- Phase 0 report). No existing table, column, constraint, index, or RLS
-- policy is altered or removed. Run this manually against the Supabase
-- project -- it is NOT executed automatically by this repo, and was NOT
-- run as part of this change.
--
-- Scope, per the approved blueprint amendments:
--   1. clients        -- add the 3 missing Business Profile fields only
--                         (website, timezone, structured working_hours).
--                         business_name/business_description/phone/address
--                         already exist and are untouched.
--   2. client_ai_behavior          -- new, one row max per client. Complete
--                                      AI Behavior V1 field set: reply_tone,
--                                      default_language, personality,
--                                      special_instructions,
--                                      booking_instructions,
--                                      escalation_instructions,
--                                      forbidden_rules.
--   3. client_knowledge_documents,
--      client_knowledge_chunks     -- new, relational foundation only.
--      No vector/embedding column yet -- see the header comment on
--      section 3 below for exactly why and what must happen first.
--
-- Explicitly OUT of scope for this migration (per instruction):
--   - No change to client_whatsapp/client_facebook/client_telegram/
--     client_instagram or to client_feature_integrations.
--   - No ingestion/RAG code, no vector column, no embeddings.
--   - No removal of any client_feature_integrations.config field.
--   - No Business Profile backfill from config into clients (Phase 0
--     found real drift there; clients.* stays authoritative pending
--     manual review, per instruction -- never automatic).
--   AI Behavior backfill (reply_tone/language/special_instructions from
--   config) is a SEPARATE migration file
--   (20260826_ai_engine_v1_phase1_backfill.sql), kept apart from this
--   pure-DDL file on purpose so the two can be reviewed/run
--   independently.

begin;

-- ===========================================================================
-- 1. clients -- missing Business Profile fields only
-- ===========================================================================
-- All nullable, all additive. No default forced on timezone/working_hours
-- -- an unset value must stay genuinely unset (null), not a guessed
-- default that could silently misrepresent a specific client's real hours
-- or timezone.
--
-- working_hours shape (documented here, not enforced by a CHECK -- kept
-- deliberately loose at the DB level in v1, exactly like every other free-
-- form-ish jsonb column already in this schema, e.g. conversation_events.
-- metadata/conversations.context): the AI Context builder (a later phase)
-- is what actually reads and renders this into prompt text, so validation
-- belongs there, not in a CHECK constraint that would have to be revised
-- every time the shape evolves.
--   {
--     "timezone": "Asia/Hebron",
--     "days": {
--       "sunday":   [{"open": "09:00", "close": "17:00"}],
--       "monday":   [{"open": "09:00", "close": "17:00"}],
--       "friday":   []
--     }
--   }
-- An empty array for a day = closed that day. Multiple entries in one
-- day's array = multiple periods (e.g. a lunch-break split shift).
-- Holiday/exception scheduling is explicitly NOT part of this shape yet
-- (out of scope for v1, per instruction).
alter table public.clients
  add column if not exists website text null,
  add column if not exists timezone text null,
  add column if not exists working_hours jsonb null;

comment on column public.clients.website is
  'Business Profile: public website URL. Nullable -- most clients will not have one set initially. Client-wide, edited via the same Account Settings page as business_name/business_description/phone/address.';
comment on column public.clients.timezone is
  'Business Profile: IANA timezone identifier (e.g. "Asia/Hebron"), used to interpret working_hours and any future "are we open right now" logic. Nullable -- no default forced, since guessing wrong would silently misrepresent a specific client.';
comment on column public.clients.working_hours is
  'Business Profile: structured working hours, {"timezone": "...", "days": {"sunday": [{"open","close"}, ...], ...}}. See this migration''s header comment for the full shape. Rendered into prompt text by the AI Context builder (a later phase) -- the AI never reads this raw jsonb directly. No holiday/exception scheduling in v1.';

-- ===========================================================================
-- 2. client_ai_behavior -- dedicated AI Behavior model, one row max/client
-- ===========================================================================
-- Deliberately does NOT include any Business Profile field (those live
-- only on `clients`) and does NOT include reply_mode (that is per-channel-
-- account operational config -- see this migration's header comment and
-- the "Channel Account Ownership" findings in the accompanying report;
-- it stays out of this table on purpose).
--
-- `client_id` is UNIQUE (not the primary key itself, per the exact column
-- list requested for this phase) -- this is what enforces "one row
-- maximum per client" at the database level: a second INSERT for the same
-- client_id fails outright instead of silently creating a duplicate the
-- way client_feature_integrations currently can (see the Phase 0 report --
-- this is the exact bug class being closed here).
--
-- updated_at is plain, caller-maintained -- no trigger -- matching this
-- schema's own established convention (see client_facebook/client_
-- telegram/client_instagram and the Conversation Model V2 tables for the
-- identical, already-reviewed reasoning).
create table if not exists public.client_ai_behavior (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients (id) on delete cascade,
  reply_tone             text null default 'friendly',
  default_language       text null default 'ar',
  personality            text null,
  special_instructions   text null,
  booking_instructions   text null,
  escalation_instructions text null,
  forbidden_rules        jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint client_ai_behavior_client_id_unique unique (client_id)
);

comment on table public.client_ai_behavior is
  'Client-wide AI Behavior -- HOW the AI communicates, never business facts (those stay on clients, WHAT the business is), never Knowledge Base content (WHAT the business knows), and never per-channel-account operational config like reply_mode (that stays on the channel account tables, HOW a specific account operates). At most one row per client, enforced by the UNIQUE constraint on client_id. Not yet read or written by any application/API/n8n code (Phase 1: schema only).';
comment on column public.client_ai_behavior.reply_tone is
  'Free-form tone descriptor (e.g. "friendly"). Same concept as the legacy client_feature_integrations.config["reply_tone"] key it will eventually replace as the read source -- see the accompanying report''s backfill section.';
comment on column public.client_ai_behavior.default_language is
  'AI reply language (e.g. "ar"/"en") -- DISTINCT from clients.default_language, which is UI portal language only (see 20260817_client_and_user_language_preference.sql) and must never be conflated with this column.';
comment on column public.client_ai_behavior.personality is
  'Free-form personality descriptor (e.g. "professional, warm, concise"). No legacy config equivalent exists -- always starts null until set through a future AI Behavior settings UI (never auto-populated/invented by any migration).';
comment on column public.client_ai_behavior.special_instructions is
  'Free-form additional instructions for the AI. Same concept as the legacy client_feature_integrations.config["special_instructions"] key it will eventually replace as the read source.';
comment on column public.client_ai_behavior.booking_instructions is
  'Free-form instructions for how the AI should handle booking/ordering intent (e.g. what to collect, how to confirm). No legacy config equivalent exists -- always starts null.';
comment on column public.client_ai_behavior.escalation_instructions is
  'Free-form instructions for when/how the AI should hand off to a human (human_request intent). No legacy config equivalent exists -- always starts null.';
comment on column public.client_ai_behavior.forbidden_rules is
  'List of things the AI must never say/do, as a jsonb array of strings (e.g. ["never quote prices not explicitly provided", "never promise delivery times"]). No legacy config equivalent exists -- always starts as an empty array, never invented.';

alter table public.client_ai_behavior enable row level security;
-- No policies added -- deliberately zero, matching the established
-- convention for every recently-added client-owned table in this schema
-- (client_facebook/client_telegram/client_instagram, conversation_events,
-- conversation_notes): the anon/browser-keyed Supabase client cannot
-- read or write this table at all. All access -- once a later phase
-- builds it -- must go through a service-role-backed API endpoint that
-- re-derives and enforces client_id server-side, exactly like every
-- existing endpoint in api/*.js (see api/client-facebook.js for the
-- directly analogous, most recent precedent). Never query this table
-- directly from React/browser Supabase code.

-- ===========================================================================
-- 3. client_knowledge_documents / client_knowledge_chunks -- Knowledge Base
--    relational foundation ONLY. No ingestion, no RAG, no vector column.
-- ===========================================================================
-- Vector/embedding column deliberately DEFERRED -- see the accompanying
-- report's "Vector / Embedding Deferred Items" section for the full
-- reasoning. Summary: this repository has zero confirmed pgvector usage,
-- zero confirmed embedding-model usage, and zero record of which Postgres
-- extensions are actually enabled on the live Supabase project (see
-- engineering/knowledge/SUPABASE.md, which explicitly lists "extensions
-- in use" as unverifiable from this repository). Adding `vector(1536)` (or
-- any other guessed dimension) now would risk creating a column that has
-- to be dropped and recreated the moment the real embedding model is
-- confirmed -- exactly the "do not guess" instruction this phase is
-- following. client_knowledge_chunks.content (the raw chunk text) is
-- created now because chunking/storage is independent of which embedding
-- model is eventually chosen; the embedding column itself is added by a
-- separate, later migration once pgvector availability and the model are
-- both verified live.
create table if not exists public.client_knowledge_documents (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients (id) on delete cascade,
  title             text null,
  file_name         text not null,
  storage_path      text not null,
  mime_type         text not null,
  file_size_bytes   bigint not null,
  status            text not null default 'uploaded',
  status_error      text null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint client_knowledge_documents_status_check
    check (status in ('uploaded', 'processing', 'ready', 'failed'))
);

comment on table public.client_knowledge_documents is
  'Business Knowledge Base v1 -- one row per uploaded document, strictly client-scoped. Relational/metadata foundation only (Phase 1) -- no ingestion, chunking, or retrieval code reads or writes this yet. storage_path points into a private Supabase Storage bucket (bucket/path convention to be finalized when the upload endpoint is built -- a later phase), never a public URL.';
comment on column public.client_knowledge_documents.title is
  'Optional human-readable display title, distinct from the raw uploaded file_name (e.g. "2026 Summer Menu" for a file named menu_v3_final.pdf). Nullable -- falls back to file_name for display when unset.';
comment on column public.client_knowledge_documents.status is
  'Processing lifecycle: uploaded (file stored, not yet processed) -> processing -> ready (chunks/embeddings available) or failed (see status_error). Set/advanced only by the future ingestion worker, never by this migration.';
comment on column public.client_knowledge_documents.status_error is
  'Failure reason when status = failed. Null otherwise. Never shown to end customers -- admin/client document-list UI only.';

create table if not exists public.client_knowledge_chunks (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  document_id   uuid not null references public.client_knowledge_documents (id) on delete cascade,
  chunk_index   integer not null,
  content       text not null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),

  constraint client_knowledge_chunks_document_chunk_unique unique (document_id, chunk_index)
);

comment on table public.client_knowledge_chunks is
  'Business Knowledge Base v1 -- chunked text content per document, strictly client-scoped. client_id is DENORMALIZED from client_knowledge_documents on purpose: every retrieval query (a later phase) filters and indexes this exact table by client_id directly, rather than depending on a join back to client_knowledge_documents to stay correct -- the same "filter the row you''re actually reading" principle behind the client_id fixes elsewhere in this project. No embedding column yet -- see this section''s header comment above. Not yet read or written by any application/API/n8n code (Phase 1: schema only).';
comment on column public.client_knowledge_chunks.chunk_index is
  'Zero-based position of this chunk within its document. Unique per (document_id, chunk_index) -- prevents a partial/duplicate reprocess from ever creating two chunks claiming the same position.';
comment on column public.client_knowledge_chunks.metadata is
  'Reserved free-form per-chunk metadata (e.g. page number, section heading) for the future ingestion worker to populate. Empty object by default -- nothing writes to it yet.';

create index if not exists client_knowledge_documents_client_id_idx
  on public.client_knowledge_documents (client_id);

create index if not exists client_knowledge_chunks_client_id_idx
  on public.client_knowledge_chunks (client_id);

create index if not exists client_knowledge_chunks_document_id_idx
  on public.client_knowledge_chunks (document_id);

alter table public.client_knowledge_documents enable row level security;
alter table public.client_knowledge_chunks enable row level security;
-- No policies added -- same zero-policy, service-role-API-only convention
-- as client_ai_behavior above. Knowledge documents/chunks must never be
-- reachable from the anon/browser-keyed Supabase client under any
-- circumstance, matching the "strict client isolation" requirement for
-- the Knowledge Base explicitly called out in the approved blueprint.

commit;
