-- AI Engine V1 -- Phase 2: lexical (keyword) retrieval, additive to the
-- existing vector-only Knowledge Base search.
--
-- Schema-only, fully additive. Does NOT edit, drop, or replace anything
-- from the Phase 1/4A/4B migrations -- match_knowledge_chunks (vector
-- search) is left completely untouched and remains the primary semantic
-- retrieval path. Run this manually against the Supabase project -- it is
-- NOT executed automatically by this repo, and was NOT run as part of
-- this change (see the accompanying Phase 2 report's "Database Stop
-- Point").
--
-- ---------------------------------------------------------------------
-- Why lexical search, and why this specific mechanism
-- ---------------------------------------------------------------------
-- Confirmed problem (Phase 2 report): a query like "عرض المنيو" can score
-- below the (unchanged) 0.50 vector-similarity threshold even when a
-- document's content contains the near-exact term. Vector search alone
-- has no way to guarantee an exact/near-exact keyword hit ranks highly.
--
-- Mechanism chosen: PostgreSQL's built-in full-text search using the
-- 'simple' text search configuration -- deliberately NOT 'english' (this
-- app's content is frequently Arabic, and English stemming rules make no
-- sense applied to it) and NOT a language-specific 'arabic' configuration
-- either, for two reasons: (1) this schema has no per-chunk language tag
-- to reliably pick the right config per row, and content is frequently
-- CODE-MIXED within one document, and (2) 'simple' requires ZERO Postgres
-- extension -- to_tsvector/to_tsquery/GIN indexing on it are core
-- PostgreSQL functionality, available on every Postgres instance
-- (including this project's Supabase project) with no "does the
-- extension exist" uncertainty at all. 'simple' does no stemming and no
-- stopword removal -- it only tokenizes on whitespace/punctuation and
-- lowercases -- which is exactly "near-exact term matching", not fuzzy
-- semantic matching (that's what the existing vector path is for).
--
-- pg_trgm (trigram similarity) was considered (see the Phase 2 report's
-- option comparison) but not chosen for this pass: it would need
-- `create extension pg_trgm` (an added dependency this migration avoids
-- entirely by using only core tsvector/GIN), and its fuzzy float score is
-- harder to reason about consistently across languages than a plain
-- term-presence-based rank. Nothing here precludes adding it later.
--
-- ---------------------------------------------------------------------
-- Query construction (app-side, not this migration)
-- ---------------------------------------------------------------------
-- The tsquery string this function receives (p_tsquery) is built in
-- api/_lib/knowledgeRetrieval.js (buildLexicalTsQuery), NOT from raw user
-- input directly -- tokens are pre-normalized to letters/digits only (no
-- tsquery operator characters ever reach this function from an untrusted
-- source), each token is used as a prefix match ("token:*", a lightweight
-- allowance for Arabic morphological variation given 'simple' does no
-- stemming), and tokens are OR-combined (not AND) so a longer contextual
-- query (Phase 1's enriched follow-up query) doesn't require every single
-- word to be present to produce any match at all -- ts_rank still scores
-- a chunk matching MORE of the query's terms higher, so this doesn't
-- sacrifice precision, only recall floor.
--
-- ---------------------------------------------------------------------
-- Isolation -- identical discipline to match_knowledge_chunks
-- ---------------------------------------------------------------------
--   - c.client_id = p_client_id   (the chunk's own tenant)
--   - d.client_id = p_client_id   (its document's tenant, independently)
--   - d.status = 'ready'          (never surface a mid-reprocess/failed
--     document's chunks)
-- security definer is NOT used -- runs with the caller's own privileges,
-- intended to be called only via the service-role Supabase client
-- (api/_lib/knowledgeRetrieval.js), matching match_knowledge_chunks'
-- exact convention.
--
-- ---------------------------------------------------------------------
-- Null/error safety
-- ---------------------------------------------------------------------
-- plpgsql (not plain sql, unlike match_knowledge_chunks) specifically so
-- a malformed p_tsquery can never propagate a hard error up through the
-- RPC call to the application -- it returns zero rows instead. In normal
-- operation the app-side sanitization already guarantees well-formed
-- input; this is defense-in-depth, not the primary safeguard.

begin;

-- ===========================================================================
-- 1. GIN expression index for lexical search over existing chunk content
-- ===========================================================================
-- No new column, no data migration -- indexes the existing `content`
-- column directly via a functional/expression index. Safe to build
-- against a table already holding rows (CONCURRENTLY is not used here
-- since this repo's migrations are run manually, one at a time, outside
-- of application traffic windows -- consistent with how every other
-- migration in this project is applied).
create index if not exists client_knowledge_chunks_content_simple_fts_idx
  on public.client_knowledge_chunks
  using gin (to_tsvector('simple', content));

comment on index public.client_knowledge_chunks_content_simple_fts_idx is
  'Phase 2: supports lexical/keyword retrieval (match_knowledge_chunks_lexical) via PostgreSQL full-text search, "simple" configuration (no stemming, language-agnostic tokenization -- see this migration''s header comment for why). Purely additive; match_knowledge_chunks (vector search) is unaffected.';

-- ===========================================================================
-- 2. match_knowledge_chunks_lexical -- tenant-scoped lexical retrieval
-- ===========================================================================
create or replace function public.match_knowledge_chunks_lexical(
  p_client_id uuid,
  p_tsquery text,
  p_match_count int default 5
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  category text,
  content text,
  lexical_rank float
)
language plpgsql
stable
as $$
declare
  v_query tsquery;
begin
  -- Null/empty input -- no match, never an error. The app never calls
  -- this with an empty p_tsquery (buildLexicalTsQuery returns null and
  -- the caller skips the RPC entirely), but this function does not rely
  -- on that discipline alone.
  if p_client_id is null or p_tsquery is null or length(trim(p_tsquery)) = 0 then
    return;
  end if;

  begin
    v_query := to_tsquery('simple', p_tsquery);
  exception when others then
    -- Malformed tsquery syntax (should not happen given app-side
    -- sanitization -- see header comment) -- degrade to "no matches",
    -- never propagate a hard error to the caller.
    return;
  end;

  return query
    select
      c.id as chunk_id,
      c.document_id,
      d.title as document_title,
      d.category,
      c.content,
      ts_rank(to_tsvector('simple', c.content), v_query) as lexical_rank
    from public.client_knowledge_chunks c
    join public.client_knowledge_documents d
      on d.id = c.document_id
     and d.client_id = c.client_id
    where c.client_id = p_client_id
      and d.client_id = p_client_id
      and d.status = 'ready'
      and to_tsvector('simple', c.content) @@ v_query
    order by lexical_rank desc, c.id asc
    limit greatest(coalesce(p_match_count, 5), 0);
end;
$$;

comment on function public.match_knowledge_chunks_lexical is
  'Phase 2: tenant-scoped lexical/keyword retrieval for the AI Context layer (api/_lib/knowledgeRetrieval.js), additive alongside match_knowledge_chunks (vector search) -- the two are fused client-side via Reciprocal Rank Fusion, not combined in SQL. client_id is checked on BOTH the chunk and its document independently, status must be ready -- identical isolation discipline to match_knowledge_chunks. p_tsquery is a pre-built PostgreSQL tsquery string (OR-combined, prefix-matched tokens) constructed in application code, never raw user input passed through directly. plpgsql with an exception handler around to_tsquery() so a malformed query string degrades to zero rows rather than an error.';

revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from public;
revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from anon;
revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from authenticated;
grant execute on function public.match_knowledge_chunks_lexical(uuid, text, int) to service_role;

commit;
