-- AI Engine V1 -- Phase 2C: repository/Production drift fix for
-- match_knowledge_chunks_lexical's lexical_rank column type.
--
-- Corrective, additive migration -- does NOT rewrite either historical
-- lexical migration (20260827_ai_engine_v1_phase2_lexical_retrieval.sql,
-- 20260827_ai_engine_v1_phase2b_lexical_title_search.sql), consistent
-- with this repo's convention of never editing an already-committed
-- migration file; a bug found after the fact is corrected by a NEW
-- migration, not a rewrite of history. Does NOT touch match_knowledge_chunks
-- (vector search), chunking, embeddings, or any table data.
--
-- ---------------------------------------------------------------------
-- Root cause (confirmed live in Production)
-- ---------------------------------------------------------------------
-- PostgreSQL's ts_rank(...) returns `real` (4-byte float). Both prior
-- lexical migrations declared the function's RETURNS TABLE column as
-- `lexical_rank double precision` (8-byte float) but never cast the
-- returned expression to match:
--   - Phase 2:  ts_rank(...) as lexical_rank
--   - Phase 2B: greatest(ts_rank(...), ts_rank(...)) as lexical_rank
-- (greatest(real, real) also returns real -- the mismatch was present
-- from the very first lexical migration, not newly introduced by 2B.)
-- This produced, live in Production, exactly:
--   ERROR 42804: structure of query does not match function result type
--   DETAIL: Returned type real does not match expected type double
--   precision in column 6.
-- Production was manually repaired by adding an explicit
-- ::double precision cast to the returned expression -- lexical
-- retrieval has been working correctly in Production since. This
-- migration brings the repository back in sync with that live,
-- manually-applied fix so a fresh environment applying migrations from
-- git in order never reproduces the same failure.
--
-- ---------------------------------------------------------------------
-- Scope of the correction
-- ---------------------------------------------------------------------
-- The ONLY behavioral change from the Phase 2B definition is the
-- ::double precision cast on the returned lexical_rank expression.
-- Everything else is byte-for-byte identical to Phase 2B:
--   - matches EITHER chunk content OR document title (to_tsvector('simple', ...))
--   - c.client_id = p_client_id AND d.client_id = p_client_id (tenant isolation)
--   - d.status = 'ready'
--   - same ordering (lexical_rank desc, c.id asc)
--   - same p_match_count / limit behavior
--   - same plpgsql exception handling around to_tsquery() parsing
--   - same RETURNS TABLE contract (chunk_id, document_id, document_title,
--     category, content, lexical_rank) -- unchanged column set/types as
--     declared (only the returned VALUE for lexical_rank is now
--     correctly cast to match its own declared type)
--   - same grants: execute revoked from public/anon/authenticated,
--     granted only to service_role
--
-- ---------------------------------------------------------------------
-- Production action required
-- ---------------------------------------------------------------------
-- NONE at this time. Production already has the corrected, working
-- definition applied manually. This migration exists to eliminate
-- repository/Production drift and to correctly seed any FUTURE fresh
-- environment (staging, disaster recovery, a new Supabase project) --
-- it is not itself required to run again against the current Production
-- database unless a live inspection ever shows Production's actual
-- definition differs from what's written here.

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
  lexical_rank double precision
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
      )::double precision as lexical_rank
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
  'Phase 2C: same behavior as Phase 2B (tenant-scoped lexical/keyword retrieval, matching against EITHER chunk content OR document title, category deliberately excluded) with one correction -- lexical_rank is now explicitly cast to double precision to match its declared RETURNS TABLE type (ts_rank()/greatest() both return real; the prior definitions never cast, causing a live "structure of query does not match function result type" error, manually repaired in Production and now reflected here). client_id checked on BOTH the chunk and its document independently, status must be ready. p_tsquery is a pre-built PostgreSQL tsquery string constructed in application code, never raw user input passed through directly.';

revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from public;
revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from anon;
revoke all on function public.match_knowledge_chunks_lexical(uuid, text, int) from authenticated;
grant execute on function public.match_knowledge_chunks_lexical(uuid, text, int) to service_role;

commit;
