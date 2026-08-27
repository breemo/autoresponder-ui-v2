-- AI Engine V1 -- Phase 2B: include document title in lexical retrieval.
--
-- Additive, non-destructive evolution of the Phase 2 lexical migration
-- (20260827_ai_engine_v1_phase2_lexical_retrieval.sql). Does NOT touch
-- match_knowledge_chunks (vector search), does NOT touch chunking,
-- embeddings, or any table data, does NOT drop or change the existing
-- GIN index. Run this manually against the Supabase project -- it is NOT
-- executed automatically by this repo, and was NOT run as part of this
-- change.
--
-- ---------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------
-- Confirmed limitation (Phase 2B diagnostic report): lexical search only
-- ever indexed/matched against c.content -- a document's own title (e.g.
-- "02_Tasty_Menu_Price_List") never participated in matching at all,
-- even though it's a real, human-readable label that can share genuine
-- words with a customer's query (a query containing "menu" should be
-- able to match a document titled "...Menu...", independent of whatever
-- specific wording the body content happens to use).
--
-- category is deliberately NOT included: it's a short internal enum
-- value (menu/price_list/brochure/services_catalog/faq/policy/other),
-- effectively always English, and not something a real customer query
-- would plausibly ever contain verbatim -- including it would add
-- tsvector matching surface for no realistic recall benefit. title is a
-- genuine, often human-authored label; category is internal metadata.
-- This is a deliberate, explained scope decision, not an oversight.
--
-- ---------------------------------------------------------------------
-- Why no index change (a subtlety worth documenting)
-- ---------------------------------------------------------------------
-- A single GIN expression index covering "title + content" combined is
-- NOT possible directly on client_knowledge_chunks: title lives on the
-- joined client_knowledge_documents row, and Postgres expression/index
-- definitions cannot reference another table via a subquery/join -- an
-- index can only be a deterministic function of the indexed table's own
-- columns. Denormalizing title onto client_knowledge_chunks (a new
-- column, kept in sync at ingestion time) would solve that, but is
-- explicitly out of scope for Phase 2B (no changes to
-- api/_lib/knowledgeIngestion.js, no new column, no backfill/trigger
-- complexity).
--
-- Instead, this migration keeps the EXISTING content-only GIN index
-- exactly as-is (it remains fully useful for the content half of
-- matching) and adds title matching as a SEPARATE, un-indexed OR-branch
-- inside the RPC, computed on the fly per already client_id-filtered
-- row. This is the same tradeoff already made -- and already documented
-- -- for the vector path itself: match_knowledge_chunks's own migration
-- states "No ANN index yet... a plain sequential scan pre-filtered by
-- client_id is both exact and fast enough today." Title text is short
-- (a handful of words at most) and the row set is already narrowed by
-- client_id via the existing client_knowledge_chunks_client_id_idx
-- b-tree index before this ever runs, so computing to_tsvector('simple',
-- title) per candidate row is cheap at current and near-term scale.
--
-- ---------------------------------------------------------------------
-- What changes
-- ---------------------------------------------------------------------
-- match_knowledge_chunks_lexical is replaced (CREATE OR REPLACE, same
-- signature -- (uuid, text, int) -- so existing grants remain valid;
-- re-stated explicitly below anyway, matching this repo's convention of
-- never relying on implicit grant preservation). Isolation logic
-- (client_id x2, status='ready'), null-safety, and the exception-guarded
-- to_tsquery() parsing are otherwise unchanged from the Phase 2 version.
-- A chunk now matches if EITHER its own content OR its document's title
-- matches the query; lexical_rank is the greater of the two individual
-- ts_rank scores (never summed -- a title-only hit and a content-only
-- hit are not "more relevant together" just because both formulas exist,
-- they are two independent ways to reach the same relevance signal).
--
-- Vector search (match_knowledge_chunks) is completely untouched by this
-- migration.

begin;

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
    -- sanitization) -- degrade to "no matches", never propagate a hard
    -- error to the caller.
    return;
  end;

  return query
    select
      c.id as chunk_id,
      c.document_id,
      d.title as document_title,
      d.category,
      c.content,
      greatest(
        ts_rank(to_tsvector('simple', c.content), v_query),
        ts_rank(to_tsvector('simple', coalesce(d.title, '')), v_query)
      ) as lexical_rank
    from public.client_knowledge_chunks c
    join public.client_knowledge_documents d
      on d.id = c.document_id
     and d.client_id = c.client_id
    where c.client_id = p_client_id
      and d.client_id = p_client_id
      and d.status = 'ready'
      and (
        to_tsvector('simple', c.content) @@ v_query
        or to_tsvector('simple', coalesce(d.title, '')) @@ v_query
      )
    order by lexical_rank desc, c.id asc
    limit greatest(coalesce(p_match_count, 5), 0);
end;
$$;

comment on function public.match_knowledge_chunks_lexical is
  'Phase 2B: tenant-scoped lexical/keyword retrieval, matching against EITHER chunk content OR its document''s title (category deliberately excluded -- see this migration''s header comment). Additive alongside match_knowledge_chunks (vector search) -- the two are fused client-side via Reciprocal Rank Fusion, not combined in SQL. client_id is checked on BOTH the chunk and its document independently, status must be ready -- identical isolation discipline to match_knowledge_chunks. p_tsquery is a pre-built PostgreSQL tsquery string (OR-combined, prefix-matched tokens) constructed in application code, never raw user input passed through directly. plpgsql with an exception handler around to_tsquery() so a malformed query string degrades to zero rows rather than an error.';

revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from public;
revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from anon;
revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from authenticated;
grant execute on function public.match_knowledge_chunks_lexical(uuid, text, int) to service_role;

commit;
