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

// ---------------------------------------------------------------------
// Phase 1 — Context-Aware Knowledge Retrieval (deterministic, no LLM call)
// ---------------------------------------------------------------------
// Root cause being addressed: retrieval previously embedded ONLY the
// current message, never conversation history, so a conversational
// follow-up ("طيب بتوصلوا داخل نابلس؟" after a prior delivery-outside-
// Nablus question) was retrieved as if it were a completely isolated
// query. This is a small, cheap, purely deterministic enrichment step —
// no additional OpenAI/LLM call is added here (see the report: LLM query
// rewriting stays a possible future Phase 1B, only if evaluation proves
// it necessary).
//
// Generic across every client/business type on purpose — no business-
// domain vocabulary (delivery/menu/etc.) appears anywhere below, only
// generic discourse-connector words and structural signals.
const FOLLOWUP_MARKERS = [
  // Arabic — checked as sentence-initial markers (see startsWithAnyMarker)
  "طيب", "طب", "وبالنسبة", "وهل", "وكمان", "ماذا عن", "شو عن", "وماذا عن", "وشو عن",
  // English
  "then", "what about", "and", "also",
];

const SHORT_MESSAGE_WORD_COUNT = 2; // "very short" secondary signal — see isLikelyFollowUp
const MAX_CONTEXTUAL_QUERY_LENGTH = 500; // hard cap — see buildContextualRetrievalQuery

function startsWithAnyMarker(text) {
  const normalized = text.trim().toLowerCase();
  return FOLLOWUP_MARKERS.some((marker) => normalized.startsWith(marker.toLowerCase()));
}

// Deliberately conservative: a fully standalone factual question ("كم سعر
// وجبة المشاوي المشكلة؟") must NOT trigger this — it has neither a
// leading discourse marker nor is it "very short". A message opening
// with a known follow-up/discourse word, or a very short message (<=2
// words, e.g. "ليش؟"), is treated as likely depending on the previous
// turn to be understood.
//
// Known tradeoff (Phase 2B diagnostic): this also fires for ordinary
// short standalone requests ("عرض المنيو", "طلب وجبة" — both 2 words).
// That is intentionally NOT "fixed" by narrowing this heuristic in
// Phase 2B — instead, buildLexicalTsQuery (below) is redesigned so that,
// even when this heuristic fires, the current message's own words can
// never be crowded out of the lexical query by whatever prior-turn
// context gets attached. See that function's own comment.
function isLikelyFollowUp(text) {
  if (startsWithAnyMarker(text)) return true;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return wordCount > 0 && wordCount <= SHORT_MESSAGE_WORD_COUNT;
}

// Finds the most recent user+assistant exchange STRICTLY BEFORE the
// current message. If history's own last entry already IS the current
// message (the normal production shape — n8n's `insert message` node
// writes it before /api/ai-context is ever called, exactly like
// promptBuilder.js's own "alreadyPresent" check for the prompt-messages
// path), that entry is skipped here too, so it's never duplicated into
// the retrieval query. Never throws — any unexpected shape (non-array
// history, malformed entries) simply yields fewer/no context pieces.
function findPreviousTurn(trimmedCurrent, history) {
  if (!Array.isArray(history) || history.length === 0) return null;

  const last = history[history.length - 1];
  const currentAlreadyInHistory =
    !!last && last.role === "user" && typeof last.content === "string" && last.content.trim() === trimmedCurrent;

  const priorHistory = currentAlreadyInHistory ? history.slice(0, -1) : history;
  if (priorHistory.length === 0) return null;

  let assistantMsg = null;
  let userMsg = null;
  for (let i = priorHistory.length - 1; i >= 0; i--) {
    const item = priorHistory[i];
    if (!item || typeof item.content !== "string" || !item.content.trim()) continue;
    if (!assistantMsg && item.role === "assistant") {
      assistantMsg = item.content.trim();
      continue;
    }
    if (assistantMsg && !userMsg && item.role === "user") {
      userMsg = item.content.trim();
      break;
    }
  }

  // No complete exchange found (e.g. two user messages in a row before
  // any reply, or a lone earlier assistant message) — still fall back to
  // the single most recent user message, if any, rather than nothing.
  if (!userMsg && !assistantMsg) {
    for (let i = priorHistory.length - 1; i >= 0; i--) {
      const item = priorHistory[i];
      if (item && item.role === "user" && typeof item.content === "string" && item.content.trim()) {
        userMsg = item.content.trim();
        break;
      }
    }
  }

  if (!userMsg && !assistantMsg) return null;
  return { userMsg, assistantMsg };
}

// Shared by buildContextualRetrievalQuery (vector's embedding string) and
// buildLexicalContextText (lexical's context-only tokens) — a single
// source of truth for "is this a follow-up, and if so what's the prior
// context", so the two retrieval methods can never disagree about it.
function resolveFollowUpContext(currentMessageText, history) {
  const trimmedCurrent = (currentMessageText || "").trim();
  if (!trimmedCurrent || !isLikelyFollowUp(trimmedCurrent)) {
    return { trimmedCurrent, contextParts: [] };
  }
  const previousTurn = findPreviousTurn(trimmedCurrent, history);
  if (!previousTurn) return { trimmedCurrent, contextParts: [] };

  const contextParts = [previousTurn.userMsg, previousTurn.assistantMsg].filter(Boolean);
  return { trimmedCurrent, contextParts };
}

// Pure, deterministic, network-free. Builds the string that actually
// gets embedded for VECTOR retrieval:
//   - a standalone message is returned unchanged (no unrelated history
//     injected — see the report's explicit requirement)
//   - a likely follow-up gets at most [previous user message, previous
//     assistant response, current message] prepended, space-joined,
//     hard-capped at MAX_CONTEXTUAL_QUERY_LENGTH characters (the current
//     message itself is never truncated — only the prepended context is,
//     if the combined length would exceed the cap)
// Never throws outward — any unexpected `history` shape degrades to
// returning the current message unchanged (see findPreviousTurn).
export function buildContextualRetrievalQuery(currentMessageText, history) {
  const { trimmedCurrent, contextParts } = resolveFollowUpContext(currentMessageText, history);
  if (!trimmedCurrent || contextParts.length === 0) return trimmedCurrent;

  let combined = [...contextParts, trimmedCurrent].join(" ");

  if (combined.length > MAX_CONTEXTUAL_QUERY_LENGTH) {
    const budget = MAX_CONTEXTUAL_QUERY_LENGTH - trimmedCurrent.length - 1;
    if (budget <= 0) return trimmedCurrent;
    const truncatedContext = contextParts.join(" ").slice(0, budget).trim();
    combined = truncatedContext ? `${truncatedContext} ${trimmedCurrent}` : trimmedCurrent;
  }

  return combined;
}

// Phase 2B: the prior-turn context TEXT ONLY (current message never
// mixed in here) — used by buildLexicalTsQuery so the current message's
// own tokens can be prioritized separately from context tokens. Same
// follow-up detection as buildContextualRetrievalQuery (shared via
// resolveFollowUpContext) — never drifts from it. Returns "" (not null)
// when there's no usable context, matching buildLexicalTsQuery's
// expected input shape.
export function buildLexicalContextText(currentMessageText, history) {
  const { contextParts } = resolveFollowUpContext(currentMessageText, history);
  return contextParts.join(" ");
}

export const KNOWLEDGE_MATCH_COUNT = 5;
// Lowered from 0.75 to 0.50 — live diagnostic against the Tasty client's
// real, ready documents (match_knowledge_chunks, p_min_similarity=0)
// showed the three genuinely relevant chunks scoring 0.5850/0.5398/0.5098,
// with the next-best result dropping to 0.3195 — 0.75 excluded every real
// match. 0.50 keeps that same clean separation from the drop-off. Model,
// dimensions, chunking, match count, and the RPC itself are unchanged.
//
// Phase 2B note: kept as the ONE similarity floor — both the "candidate
// generation" floor inside match_knowledge_chunks AND the de facto
// "final relevance" floor. No separate, lower internal candidate
// threshold was introduced in this phase: doing so would require picking
// a specific number with no evaluation data to justify it (explicitly
// not done — see the report's "Vector Candidate Threshold Decision").
// What DID change is candidate *count* (KNOWLEDGE_CANDIDATE_POOL_SIZE,
// below), which is a distinct, safely justifiable knob.
export const KNOWLEDGE_MIN_SIMILARITY = 0.5;

// Phase 2B: internal pre-fusion candidate pool size, distinct from the
// FINAL relevant_knowledge count. Both retrieval methods previously
// requested only KNOWLEDGE_MATCH_COUNT (5) candidates each — the same
// number as the final output — meaning RRF never had more than 10
// (already-deduped-down-further) candidates to fuse from, so a chunk
// ranked 6th-or-worse by BOTH methods individually could never be pulled
// up by cross-method agreement. 20 was chosen after inspecting the real
// Tasty dataset (7 chunks total across all 5 documents) — comfortably
// covers a small/typical Knowledge Base in full today, while remaining a
// cheap LIMIT for a larger one later. The FINAL relevant_knowledge array
// is still capped at KNOWLEDGE_MATCH_COUNT (5) after fusion — this
// constant only widens what RRF has to work with, never what reaches the
// prompt.
export const KNOWLEDGE_CANDIDATE_POOL_SIZE = 20;

// Internal — does the embed+RPC call and returns RAW rows (still
// including chunk_id, needed internally for Phase 2's cross-method
// dedup). retrieveRelevantKnowledge() below wraps this with its existing,
// unchanged public contract (chunk_id stripped, never exposed — see its
// own comment). Extracted as a pure refactor for Phase 2 reuse; behavior
// of retrieveRelevantKnowledge() itself is byte-for-byte unchanged.
async function embedAndSearchVector(supabase, { clientId, queryText, matchCount, minSimilarity }) {
  const trimmedQuery = (queryText || "").trim();
  if (!clientId || !trimmedQuery) {
    return { ok: false, reason: "missing_input", rows: [] };
  }

  const embedding = await embedText(trimmedQuery);
  if (!embedding.ok) {
    return { ok: false, reason: embedding.reason, rows: [] };
  }

  const { data, error } = await supabase.rpc("match_knowledge_chunks", {
    p_client_id: clientId,
    p_query_embedding: embedding.embedding,
    p_match_count: matchCount,
    p_min_similarity: minSimilarity,
  });

  if (error) {
    return { ok: false, reason: "rpc_failed", rows: [] };
  }

  return { ok: true, rows: data || [] };
}

export async function retrieveRelevantKnowledge(supabase, { clientId, queryText, matchCount = KNOWLEDGE_MATCH_COUNT, minSimilarity = KNOWLEDGE_MIN_SIMILARITY }) {
  const search = await embedAndSearchVector(supabase, { clientId, queryText, matchCount, minSimilarity });
  if (!search.ok) {
    return { ok: false, reason: search.reason, results: [] };
  }

  // Never returns the raw vector — only grounding metadata a prompt can
  // use. `rows` may legitimately be empty (no match above the threshold,
  // or the client has no ready documents yet) — that's a normal,
  // successful "no results" outcome, not a failure.
  const results = search.rows.map((row) => ({
    document_id: row.document_id,
    document_title: row.document_title,
    category: row.category,
    content: row.content,
    similarity: row.similarity,
  }));

  return { ok: true, results };
}

// ---------------------------------------------------------------------
// Phase 2 / 2B — Hybrid Knowledge Retrieval (vector + lexical, RRF fusion)
// ---------------------------------------------------------------------
// Root cause being addressed: a query like "عرض المنيو" can score below
// the (unchanged) 0.50 vector-similarity threshold even when a document
// contains the near-exact term — vector search alone has no mechanism to
// guarantee a near-exact keyword hit ranks highly. This adds a second,
// independent lexical candidate path (PostgreSQL full-text search, see
// the accompanying migrations' header comments for why the "simple"
// config was chosen, and why document title now participates too),
// fused with the existing vector path via Reciprocal Rank Fusion — never
// arbitrary score addition (a cosine similarity and a ts_rank are not the
// same unit and are never treated as such).
const MIN_LEXICAL_TOKEN_LENGTH = 2; // drops single-letter tokens (e.g. Arabic "و") without a keyword dictionary
const MAX_LEXICAL_TOKENS = 12; // total token budget — current-message tokens are NEVER subject to this cap (see buildLexicalTsQuery); only context tokens are
const RRF_K = 60; // standard Reciprocal Rank Fusion constant (Cormack et al.) — not exposed as a tunable knob in this phase

// Strips to letters (incl. Arabic) + digits + whitespace only, splits on
// whitespace, drops tokens shorter than MIN_LEXICAL_TOKEN_LENGTH. No
// manual keyword/stopword dictionary, and — as of Phase 2B — no length
// cap here either; the cap is applied by the caller (buildLexicalTsQuery)
// ONLY to context tokens, never to current-message tokens. "simple"
// tsvector already lowercases and tokenizes on the Postgres side
// identically for the indexed content, so the only normalization needed
// here is stripping punctuation/operator characters so the resulting
// string is always safe, valid tsquery syntax (see the migrations' own
// defensive handling too).
function tokenizeForLexicalSearch(text) {
  const cleaned = (text || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter((token) => token.length >= MIN_LEXICAL_TOKEN_LENGTH);
}

// Order-preserving de-duplication.
function dedupeTokens(tokens) {
  return [...new Set(tokens)];
}

// Pure, deterministic. Builds an OR-combined, prefix-matched tsquery
// string ("token1:* | token2:* | ...") — OR, not AND, so a longer query
// doesn't require every single word to be present to produce any
// candidate at all; ts_rank still scores a chunk matching MORE terms
// higher, so this doesn't sacrifice precision.
//
// Phase 2B fix (confirmed bug): current-message tokens are ALWAYS
// included in full and are NEVER subject to MAX_LEXICAL_TOKENS — only
// contextText's tokens are capped, to whatever budget remains after the
// current message's own (deduplicated) tokens are counted. Previously,
// a single flattened string (context + current) was tokenized and
// capped from the beginning, so a long prepended prior-turn context
// could consume the entire token budget before the current message's
// own words were ever reached — for a short message like "عرض المنيو"
// following any prior turn, the current message's tokens could be
// dropped from the query ENTIRELY. That can no longer happen: this
// function's contract guarantees every current-message token (that
// survives the length filter) is present in the output.
//
// Returns null when there are no usable tokens at all (current AND
// context both empty/too-short/punctuation-only) — callers must treat
// null as "skip lexical search", never call the RPC with it.
export function buildLexicalTsQuery({ currentMessageText, contextText } = {}) {
  const currentTokens = dedupeTokens(tokenizeForLexicalSearch(currentMessageText));
  const currentSet = new Set(currentTokens);

  const remainingBudget = Math.max(MAX_LEXICAL_TOKENS - currentTokens.length, 0);
  const contextTokens = dedupeTokens(tokenizeForLexicalSearch(contextText))
    .filter((token) => !currentSet.has(token))
    .slice(0, remainingBudget);

  const allTokens = [...currentTokens, ...contextTokens];
  if (allTokens.length === 0) return null;

  return allTokens.map((token) => `${token}:*`).join(" | ");
}

// Internal — mirrors embedAndSearchVector's shape (raw rows, including
// chunk_id) for the lexical path.
async function searchLexical(supabase, { clientId, currentMessageText, contextText, matchCount }) {
  const tsQuery = buildLexicalTsQuery({ currentMessageText, contextText });
  if (!clientId || !tsQuery) {
    return { ok: false, reason: "missing_input", rows: [] };
  }

  const { data, error } = await supabase.rpc("match_knowledge_chunks_lexical", {
    p_client_id: clientId,
    p_tsquery: tsQuery,
    p_match_count: matchCount,
  });

  if (error) {
    return { ok: false, reason: "rpc_failed", rows: [] };
  }

  return { ok: true, rows: data || [] };
}

// Public lexical-only entry point — same contract shape as
// retrieveRelevantKnowledge (never throws, { ok, results }), useful for
// direct testing/observability of the lexical path in isolation. No
// conversational context here (single string in, matching its existing
// contract) — routed through buildLexicalTsQuery with an empty
// contextText, so behavior for a plain string is unaffected by the
// Phase 2B current/context split.
export async function retrieveRelevantKnowledgeLexical(supabase, { clientId, queryText, matchCount = KNOWLEDGE_MATCH_COUNT }) {
  const search = await searchLexical(supabase, { clientId, currentMessageText: queryText, contextText: "", matchCount });
  if (!search.ok) {
    return { ok: false, reason: search.reason, results: [] };
  }

  const results = search.rows.map((row) => ({
    document_id: row.document_id,
    document_title: row.document_title,
    category: row.category,
    content: row.content,
    lexical_rank: row.lexical_rank,
  }));

  return { ok: true, results };
}

// Reciprocal Rank Fusion score for one already rank-ordered row list
// (both RPCs order their own results, vector by similarity desc, lexical
// by ts_rank desc — this function trusts that ordering, it does not
// re-sort by any raw score itself).
function computeRrfScores(rows) {
  const scores = new Map();
  rows.forEach((row, index) => {
    const rank = index + 1; // 1-based
    const key = dedupKey(row);
    const current = scores.get(key) || 0;
    scores.set(key, current + 1 / (RRF_K + rank));
  });
  return scores;
}

// chunk_id is the authoritative dedup identity (both RPCs always return
// it in real production use — see the migrations' own RETURNS TABLE
// definitions). Falls back to a document_id+content composite when it's
// ever absent, so a row is never silently dropped from the merge just
// because one column is missing — defensive robustness, not something
// real traffic should ever actually hit.
function dedupKey(row) {
  return row?.chunk_id || `${row?.document_id || ""}::${row?.content || ""}`;
}

// Merges + deduplicates (by chunk_id — the authoritative identity) +
// ranks two independent candidate lists via RRF, then maps down to the
// exact same public shape retrieveRelevantKnowledge already returns —
// promptBuilder.js and every existing downstream consumer remain
// completely unaware whether a result came from vector, lexical, or
// both. `similarity` is populated with the real cosine similarity when
// the chunk was found by vector search; null when it was lexical-only
// (never a fabricated number).
// Returns { results, diagnostics } — `results` is byte-for-byte the same
// value this function has always returned (the final, capped,
// promptBuilder-facing array); `diagnostics` is an ADDITIVE, log-only
// view of every fused candidate (not just the final `limit`), with each
// one's originating vector/lexical rank (if any), its fused RRF score,
// and whether it survived the final cap — added for the temporary
// diagnostic patch (see retrieveRelevantKnowledgeHybrid). Nothing about
// `results` itself, or the ranking/dedup logic that produces it, changed.
function fuseRankedResults({ vectorRows, lexicalRows, limit }) {
  const vectorScores = computeRrfScores(vectorRows);
  const lexicalScores = computeRrfScores(lexicalRows);

  const vectorRankByKey = new Map();
  vectorRows.forEach((row, index) => {
    if (row) vectorRankByKey.set(dedupKey(row), index + 1);
  });
  const lexicalRankByKey = new Map();
  lexicalRows.forEach((row, index) => {
    if (row) lexicalRankByKey.set(dedupKey(row), index + 1);
  });

  const byKey = new Map();
  for (const row of vectorRows) {
    if (!row) continue;
    byKey.set(dedupKey(row), { ...row });
  }
  for (const row of lexicalRows) {
    if (!row) continue;
    const key = dedupKey(row);
    const existing = byKey.get(key);
    if (existing) {
      // Already present from vector — keep its similarity, just merge in
      // whatever fields might be missing (defensive only; both RPCs
      // always populate document_title/category/content).
      byKey.set(key, { ...row, ...existing });
    } else {
      byKey.set(key, { ...row });
    }
  }

  const fused = Array.from(byKey.entries()).map(([key, row]) => ({
    key,
    row,
    rrfScore: (vectorScores.get(key) || 0) + (lexicalScores.get(key) || 0),
    vectorRank: vectorRankByKey.get(key) || null,
    lexicalRank: lexicalRankByKey.get(key) || null,
  }));

  fused.sort((a, b) => b.rrfScore - a.rrfScore);

  const selectedKeys = new Set(fused.slice(0, limit).map((f) => f.key));

  const results = fused.slice(0, limit).map(({ row }) => ({
    document_id: row.document_id,
    document_title: row.document_title,
    category: row.category,
    content: row.content,
    similarity: typeof row.similarity === "number" ? row.similarity : null,
  }));

  const diagnostics = fused.map((f) => ({
    chunk_id: f.row.chunk_id || null,
    document_title: f.row.document_title || null,
    category: f.row.category || null,
    vectorRank: f.vectorRank,
    lexicalRank: f.lexicalRank,
    rrfScore: f.rrfScore,
    selected: selectedKeys.has(f.key),
  }));

  return { results, diagnostics };
}

// The Phase 2/2B entry point — replaces retrieveRelevantKnowledge as the
// call api/_lib/aiContext.js makes. Runs vector and lexical search in
// PARALLEL (Promise.all — no added sequential latency), each already
// non-throwing on its own (embedAndSearchVector/searchLexical), with an
// additional .catch() as belt-and-suspenders so a genuinely unexpected
// exception in either path can never take down the other: if vector
// fails, lexical results (if any) are still used, and vice versa; only
// if BOTH fail does this return ok:false, which api/_lib/aiContext.js
// already degrades to relevant_knowledge: [] exactly as it does today
// for a single-method failure.
//
// `queryText` is the Phase-1 CONTEXTUAL query (already built by the
// caller via buildContextualRetrievalQuery) — used for vector embedding,
// unchanged from Phase 2. `currentMessageText`/`contextText` are the
// Phase 2B current/context SPLIT — used only for lexical, so the
// current message's own tokens are never starved (see
// buildLexicalTsQuery). If currentMessageText is omitted, it falls back
// to queryText (keeps this function usable with a single plain string,
// e.g. in tests, without requiring every caller to compute the split).
//
// Both retrieval methods request KNOWLEDGE_CANDIDATE_POOL_SIZE
// candidates internally (Phase 2B — wider pre-fusion pool); the final
// fused/returned array is still capped at `matchCount`
// (KNOWLEDGE_MATCH_COUNT, 5, unchanged).
//
// ---------------------------------------------------------------------
// TEMPORARY DIAGNOSTIC LOGGING — logging only, no behavior change.
// ---------------------------------------------------------------------
// Added to answer, from real Vercel runtime logs, exactly which stage
// (vector candidates / lexical candidates / RRF fusion / final cap) a
// specific query's expected chunk drops out at — see the diagnostic
// report this accompanies. `logTag` (optional; passed by
// api/_lib/aiContext.js as `${conversationId}:${short id}`) correlates
// every line for one customer message/request together in the log
// viewer. Every value logged here is metadata only — chunk_id, document
// title, category, numeric ranks/scores, and boolean flags. NEVER logged:
// embeddings, chunk content, API keys/secrets, auth headers, or full
// conversation history (only the single current message text and a
// length-capped preview of the Phase-1 contextual query, itself already
// capped upstream at 500 chars). Intended to be removed once the
// diagnosis is complete — search for "knowledgeRetrieval[DIAGNOSTIC]" to
// find every line this adds.
export async function retrieveRelevantKnowledgeHybrid(
  supabase,
  { clientId, queryText, currentMessageText, contextText = "", matchCount = KNOWLEDGE_MATCH_COUNT, minSimilarity = KNOWLEDGE_MIN_SIMILARITY, logTag }
) {
  const trimmedQuery = (queryText || "").trim();
  if (!clientId || !trimmedQuery) {
    return { ok: false, reason: "missing_input", results: [] };
  }
  const effectiveCurrentText = (currentMessageText || trimmedQuery || "").trim();
  const tag = logTag || "no-tag";

  const [vectorSearch, lexicalSearch] = await Promise.all([
    embedAndSearchVector(supabase, { clientId, queryText: trimmedQuery, matchCount: KNOWLEDGE_CANDIDATE_POOL_SIZE, minSimilarity }).catch(() => ({
      ok: false,
      reason: "vector_threw",
      rows: [],
    })),
    searchLexical(supabase, { clientId, currentMessageText: effectiveCurrentText, contextText, matchCount: KNOWLEDGE_CANDIDATE_POOL_SIZE }).catch(() => ({
      ok: false,
      reason: "lexical_threw",
      rows: [],
    })),
  ]);

  // Computed a second time purely for the log line below (buildLexicalTsQuery
  // is pure/deterministic — this has zero effect on the real lexical RPC
  // call, which already computed and used its own copy inside searchLexical).
  const lexicalTsQueryForLog = buildLexicalTsQuery({ currentMessageText: effectiveCurrentText, contextText });

  console.info("knowledgeRetrieval[DIAGNOSTIC]: query construction", {
    logTag: tag,
    currentMessageText: effectiveCurrentText,
    contextualQueryPreview: trimmedQuery.slice(0, 300),
    lexicalTsQuery: lexicalTsQueryForLog,
  });

  console.info("knowledgeRetrieval[DIAGNOSTIC]: vector candidates", {
    logTag: tag,
    ok: vectorSearch.ok,
    reason: vectorSearch.ok ? null : vectorSearch.reason,
    count: vectorSearch.ok ? vectorSearch.rows.length : 0,
    candidates: (vectorSearch.ok ? vectorSearch.rows : []).map((row, i) => ({
      rank: i + 1,
      chunk_id: row.chunk_id || null,
      document_title: row.document_title || null,
      category: row.category || null,
      similarity: row.similarity,
    })),
  });

  console.info("knowledgeRetrieval[DIAGNOSTIC]: lexical candidates", {
    logTag: tag,
    ok: lexicalSearch.ok,
    reason: lexicalSearch.ok ? null : lexicalSearch.reason,
    count: lexicalSearch.ok ? lexicalSearch.rows.length : 0,
    candidates: (lexicalSearch.ok ? lexicalSearch.rows : []).map((row, i) => ({
      rank: i + 1,
      chunk_id: row.chunk_id || null,
      document_title: row.document_title || null,
      category: row.category || null,
      lexical_rank: row.lexical_rank,
    })),
  });

  if (!vectorSearch.ok && !lexicalSearch.ok) {
    console.info("knowledgeRetrieval[DIAGNOSTIC]: both paths failed — no fusion attempted", { logTag: tag });
    return { ok: false, reason: vectorSearch.reason || lexicalSearch.reason || "retrieval_failed", results: [] };
  }

  const { results, diagnostics } = fuseRankedResults({
    vectorRows: vectorSearch.ok ? vectorSearch.rows : [],
    lexicalRows: lexicalSearch.ok ? lexicalSearch.rows : [],
    limit: matchCount,
  });

  console.info("knowledgeRetrieval[DIAGNOSTIC]: RRF fusion", { logTag: tag, candidates: diagnostics });

  console.info("knowledgeRetrieval[DIAGNOSTIC]: final relevant_knowledge", {
    logTag: tag,
    candidates: diagnostics
      .filter((d) => d.selected)
      .map((d) => ({ chunk_id: d.chunk_id, document_title: d.document_title, category: d.category })),
  });

  return { ok: true, results };
}
