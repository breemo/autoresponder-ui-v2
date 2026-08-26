-- AI Engine V1 -- Phase 4B: embeddings + semantic retrieval RPC.
--
-- Schema-only, fully additive. Does NOT edit any previously executed
-- migration -- see 20260826_ai_engine_v1_phase1_foundation.sql (created
-- client_knowledge_chunks) and 20260826_ai_engine_v1_phase4a_knowledge_
-- metadata.sql (added client_knowledge_documents.category) for the
-- tables' prior shape. Run this manually against the Supabase project --
-- it is NOT executed automatically by this repo, and was NOT run as
-- part of this change.
--
-- Preconditions verified LIVE before writing this file (per the Phase 4B
-- readiness report, not re-derived here): pgvector extension enabled,
-- version 0.8.0; embedding model approved as text-embedding-3-small,
-- native dimension 1536 -- see api/_lib/openaiEmbeddings.js, the single
-- place that model/dimension pair is declared in code. If that model
-- ever changes, this column's dimension must change with it in a new
-- migration -- the two are not independently adjustable without
-- re-embedding every existing chunk.

begin;

-- ===========================================================================
-- 1. client_knowledge_chunks.embedding
-- ===========================================================================
-- Nullable: every chunk written under Phase 4A (before this column
-- existed) has embedding = null and stays that way until its document is
-- reprocessed -- no retroactive backfill happens automatically. The
-- match_knowledge_chunks RPC below explicitly filters
-- `embedding is not null`, so those rows are simply invisible to
-- retrieval (not an error, not a crash) until a manual reprocess covers
-- them -- see the accompanying report's rollout note.
alter table public.client_knowledge_chunks
  add column if not exists embedding vector(1536) null;

comment on column public.client_knowledge_chunks.embedding is
  'text-embedding-3-small vector (1536 dims, native size -- not shortened). Null for any chunk written before this column existed, or if the ingestion pipeline''s embedding step failed for it (see api/_lib/knowledgeIngestion.js -- an embedding failure keeps the PREVIOUS successful chunk set in place rather than ever writing a chunk row with a null embedding on purpose). No ANN index yet -- see the accompanying report for why (row counts at this stage do not justify the recall/speed tradeoff an HNSW/IVFFlat index makes); a plain sequential scan pre-filtered by client_id is both exact and fast enough today.';

-- ===========================================================================
-- 2. match_knowledge_chunks -- tenant-scoped semantic retrieval
-- ===========================================================================
-- Every mandatory isolation condition lives in ONE place (this function),
-- not spread across caller code that could drift:
--   - c.client_id = p_client_id   (the chunk's own tenant)
--   - d.client_id = p_client_id   (its document's tenant, independently --
--     belt-and-suspenders against a hypothetical mismatched row, the same
--     "never trust one column alone" discipline already used elsewhere in
--     this schema, e.g. conversations_channel_identity_fk's composite FK)
--   - d.status = 'ready'          (never surface a document mid-reprocess
--     or a currently-failed one -- see knowledgeIngestion.js's failure-
--     semantics comment for exactly when a document's chunks do/don't
--     stay associated with a 'ready' status)
--   - c.embedding is not null     (pre-4B or embedding-failed chunks are
--     silently excluded, never a null-comparison error)
--
-- <=> is COSINE DISTANCE, not similarity -- `1 - (c.embedding <=>
-- p_query_embedding)` converts it to similarity BEFORE the threshold is
-- ever applied, so p_min_similarity means what its name says. Ordered
-- highest-similarity-first (ascending distance = descending similarity,
-- used directly on the distance expression so the planner can use it
-- against a future index without an extra computed-column sort).
--
-- security definer is NOT used -- this function runs with the caller's
-- own privileges. It is intended to be called only via the service-role
-- Supabase client (api/_lib/knowledgeRetrieval.js), matching every other
-- RPC in this schema that assumes a trusted server-side caller and
-- performs no authorization of its own (see
-- apply_conversation_lifecycle_action's header comment for the identical
-- convention) -- p_client_id here is exactly as trustworthy as whatever
-- already validated it before calling this function, same as everywhere
-- else in this codebase.
create or replace function public.match_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 5,
  p_min_similarity float default 0.75
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  category text,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    c.id as chunk_id,
    c.document_id,
    d.title as document_title,
    d.category,
    c.content,
    1 - (c.embedding <=> p_query_embedding) as similarity
  from public.client_knowledge_chunks c
  join public.client_knowledge_documents d
    on d.id = c.document_id
   and d.client_id = c.client_id
  where c.client_id = p_client_id
    and d.client_id = p_client_id
    and d.status = 'ready'
    and c.embedding is not null
    and 1 - (c.embedding <=> p_query_embedding) >= p_min_similarity
  order by c.embedding <=> p_query_embedding asc
  limit p_match_count;
$$;

comment on function public.match_knowledge_chunks is
  'Tenant-scoped semantic retrieval for the AI Context layer (api/_lib/knowledgeRetrieval.js). client_id is checked on BOTH the chunk and its document independently, status must be ready, embedding must be non-null. Cosine similarity computed as 1 - (embedding <=> query) -- <=> itself returns distance, never confuse the two. No ANN index backing this yet (see the embedding column''s own comment) -- a sequential scan pre-filtered by client_id is intentional at this data volume.';

revoke all on function public.match_knowledge_chunks(uuid, vector, int, float) from public;
revoke all on function public.match_knowledge_chunks(uuid, vector, int, float) from anon;
revoke all on function public.match_knowledge_chunks(uuid, vector, int, float) from authenticated;
grant execute on function public.match_knowledge_chunks(uuid, vector, int, float) to service_role;

commit;
