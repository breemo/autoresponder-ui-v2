-- AI Engine V1 -- Phase 4A: Knowledge Base metadata additions.
--
-- Schema-only, fully additive. Does NOT edit
-- 20260826_ai_engine_v1_phase1_foundation.sql (already executed) -- see
-- that migration's own header for the table's original shape. Run this
-- manually against the Supabase project -- it is NOT executed
-- automatically by this repo, and was NOT run as part of this change.
--
-- Why this is needed: the Phase 1 client_knowledge_documents table has no
-- `category` column at all. The Knowledge Base UI (KnowledgeBaseSection.jsx,
-- built ahead of the backend in an earlier phase) already has a fixed
-- category picker (Menu / Price List / Brochure / Services Catalog / FAQ /
-- Policy / Other Document) with nowhere to persist the choice until now.
-- `uploaded_by` is added alongside it for the same reason `solved_by`/
-- `assigned_user_id`/`reopened_by` already exist elsewhere in this schema:
-- an auditable actor trail on a table whose own header comment (Phase 1)
-- explicitly calls for transitions to be "deterministic and auditable in
-- the row" -- this phase is exactly where that starts to matter, since
-- real uploads happen now.
--
-- Deliberately NOT added here (still out of scope for Phase 4A): a
-- version/history column. Replace is implemented as an in-place update of
-- the existing row (new file_name/storage_path/mime_type/file_size_bytes,
-- status reset to 'uploaded') -- no version history UI was requested, and
-- adding a counter with nothing reading it yet would be exactly the
-- speculative-field risk this project's own Phase 1 migration was
-- explicit about avoiding. Can be added additively later if a version-
-- history feature is actually approved.

begin;

alter table public.client_knowledge_documents
  add column if not exists category text null,
  add column if not exists uploaded_by uuid null references public.users (id) on delete set null;

comment on column public.client_knowledge_documents.category is
  'Fixed category the client chose at upload time: menu | price_list | brochure | services_catalog | faq | policy | other. Nullable -- documents uploaded before this column existed (none should exist yet, since no upload API was live before Phase 4A) have no category. Enforced by CHECK below; the exact value set matches src/lib/knowledgeDocuments.js''s KNOWLEDGE_CATEGORIES, the single source of truth the upload API validates against -- keep both in sync if this set ever changes.';
comment on column public.client_knowledge_documents.uploaded_by is
  'Who uploaded or most recently replaced this document -- set by api/knowledge-documents.js on create_upload_intent/finalize_upload (both new uploads and replace). ON DELETE SET NULL matches every other actor-reference column added in this schema (system_assigned_user_id, solved_by, reopened_by, ...) -- see 20260820_conversation_lifecycle_tracking.sql''s header comment for the identical reasoning: no code path in this app hard-deletes users rows today, this is a defensive default for a deletion path that doesn''t currently exist.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_knowledge_documents_category_check') then
    alter table public.client_knowledge_documents
      add constraint client_knowledge_documents_category_check
      check (category is null or category in ('menu', 'price_list', 'brochure', 'services_catalog', 'faq', 'policy', 'other'));
  end if;
end $$;

commit;
