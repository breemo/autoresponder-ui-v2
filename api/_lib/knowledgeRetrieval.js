// AI Engine V1 — Phase 4B: shared semantic retrieval helper.
//
// customer query text -> embedding -> public.match_knowledge_chunks RPC
// (tenant-scoped, client_id-mandatory, status='ready'-joined — see the
// migration's own header comment for the full isolation rationale) ->
// a clean, DB/raw-vector-free array shaped for relevant_knowledge.
//
// Never throws outward — every failure path (embedding failure, RPC
// failure) returns { ok: false, reason }, so api/_lib/aiContext.js can
// degrade to relevant_knowledge: [] instead of ever failing the whole AI
// Context request over a Knowledge Base problem (see that module's own
// call site for the enforcement of that rule).
import { embedText } from "./openaiEmbeddings.js";

export const KNOWLEDGE_MATCH_COUNT = 5;
export const KNOWLEDGE_MIN_SIMILARITY = 0.75;

export async function retrieveRelevantKnowledge(supabase, { clientId, queryText, matchCount = KNOWLEDGE_MATCH_COUNT, minSimilarity = KNOWLEDGE_MIN_SIMILARITY }) {
  const trimmedQuery = (queryText || "").trim();
  if (!clientId || !trimmedQuery) {
    return { ok: false, reason: "missing_input", results: [] };
  }

  const embedding = await embedText(trimmedQuery);
  if (!embedding.ok) {
    return { ok: false, reason: embedding.reason, results: [] };
  }

  const { data, error } = await supabase.rpc("match_knowledge_chunks", {
    p_client_id: clientId,
    p_query_embedding: embedding.embedding,
    p_match_count: matchCount,
    p_min_similarity: minSimilarity,
  });

  if (error) {
    return { ok: false, reason: "rpc_failed", results: [] };
  }

  // Never returns the raw vector — only grounding metadata a prompt can
  // use. `data` may legitimately be null/empty (no match above the
  // threshold, or the client has no ready documents yet) — that's a
  // normal, successful "no results" outcome, not a failure.
  const results = (data || []).map((row) => ({
    document_id: row.document_id,
    document_title: row.document_title,
    category: row.category,
    content: row.content,
    similarity: row.similarity,
  }));

  return { ok: true, results };
}
