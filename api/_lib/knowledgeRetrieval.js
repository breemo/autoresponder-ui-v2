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
// domain vocabulary (delivery/menu/appointment/product/etc.) appears
// anywhere below. Detection is built ONLY from closed-class function
// words — discourse markers, pronouns, demonstratives, comparatives and
// interrogatives — that exist in every language register and every
// industry.
//
// The rule (generic): a previous turn is prepended to the retrieval
// query ONLY when the current message genuinely needs an earlier
// referent to be understood — it is either referential ("كم سعره؟",
// "والثاني؟", "في غيره؟", "how much is it?") or elliptical ("متى بيكون؟",
// "شو بشمل؟", "ليش؟"). A short message that names its OWN topic is a NEW
// standalone query and retrieves on itself alone, no matter how short —
// "الموقع", "الأسعار", "التوصيل", "ساعات العمل", "طرق الدفع", "الحجز",
// "طلب وجبة", "وجبات اليوم". Message length ALONE is never a trigger
// (that was the confirmed regression: every <=2-word message, standalone
// topics included, was treated as a follow-up).

// Continuation / discourse openers — matched at the very start of the
// message (optionally after a single leading و / ف conjunction).
const FOLLOWUP_MARKERS = [
  "طيب", "طب", "بعدين", "وبعدين", "بعدها", "بعد هيك", "بالنسبة", "وبالنسبة",
  "كمان", "وكمان", "وهل", "بخصوص", "ماذا عن", "وماذا عن", "شو عن", "وشو عن",
  "ماذا بخصوص",
  "then", "what about", "how about", "and what about",
];

// Anaphora — a whole word (optionally after a leading و / ف) that points
// back at something already named earlier in the conversation.
const REFERENTIAL_TOKENS = new Set([
  // Arabic object pronouns / demonstratives. NB: "هو" / "هي" / "هما" are
  // deliberately excluded — in "ما هو سعرها؟" / "ما هي ساعات العمل؟" they
  // are the copula of a standalone question, not anaphora.
  "اياه", "اياها", "اياهم", "اياهن", "هم", "هن",
  "هاد", "هادا", "هاي", "هيدا", "هيدي", "هيك", "هذا", "هذه", "ذلك", "تلك",
  "نفسه", "نفسها", "نفسهم", "نفس",
  // Arabic comparatives / anaphoric ordinals
  "الثاني", "التاني", "الاول", "الأول", "التالت", "الثالث",
  "غيره", "غيرها", "غيرهم", "غيرو", "الباقي", "باقي",
  // English
  "it", "its", "that", "this", "these", "those", "them", "one", "ones",
  "other", "another", "same",
]);

// Bare interrogative openers — used only by the "elliptical question"
// test below (a question with no topic noun of its own).
const INTERROGATIVE_STARTERS = new Set([
  "شو", "إيش", "ايش", "وش", "كيف", "كيفية", "كم", "بكم", "قديش", "بقديش", "أديش",
  "وين", "فين", "منين", "متى", "إمتى", "امتى", "ليش", "لماذا", "علاش",
  "مين", "لمين", "اي", "أي", "هل",
  "what", "how", "when", "where", "who", "whom", "why", "which",
  "is", "are", "am", "do", "does", "did", "can", "could", "would", "will", "should",
]);

const MAX_CONTEXTUAL_QUERY_LENGTH = 500; // hard cap — see buildContextualRetrievalQuery
const MAX_ELLIPTICAL_TOKENS = 3; // an elliptical question is very short by nature

// A single leading و / ف is a conjunction, not part of the word.
function stripLeadingConjunction(token) {
  return token.replace(/^[وف]/, "");
}

function normalizeForFollowUp(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[؟?!.،,…:؛]+$/u, "")
    .trim();
}

function tokenizeNormalized(normalized) {
  return normalized.split(/\s+/).filter(Boolean);
}

function startsWithAnyMarker(normalized) {
  const stripped = stripLeadingConjunction(normalized);
  return FOLLOWUP_MARKERS.some((marker) => {
    const m = marker.toLowerCase();
    return (
      normalized === m || normalized.startsWith(m + " ") ||
      stripped === m || stripped.startsWith(m + " ")
    );
  });
}

function containsReferentialToken(tokens) {
  return tokens.some((t) => REFERENTIAL_TOKENS.has(t) || REFERENTIAL_TOKENS.has(stripLeadingConjunction(t)));
}

// An Arabic definite noun (ال- / وال- / بال- / لل- … prefixed) means the
// message carries its own topic noun, so it is NOT elliptical even when
// it is a short question ("وين الموقع؟", "كم الأسعار؟").
function hasDefiniteNoun(tokens) {
  return tokens.some((t) => /^[وفبكل]?(ال|لل)[ء-ي]{2,}/u.test(t));
}

// Elliptical question: a very short question opening with an
// interrogative word and carrying no topic noun of its own —
// "شو بشمل؟", "متى بيكون؟", "كم سعره؟", "ليش؟". Contrast "وين الموقع؟"
// (has a definite topic noun -> standalone).
function isEllipticalQuestion(tokens) {
  if (tokens.length === 0 || tokens.length > MAX_ELLIPTICAL_TOKENS) return false;
  const first = tokens[0];
  if (!INTERROGATIVE_STARTERS.has(first) && !INTERROGATIVE_STARTERS.has(stripLeadingConjunction(first))) {
    return false;
  }
  return !hasDefiniteNoun(tokens);
}

// Deliberately conservative. A self-contained query — long OR short —
// that names its own topic ("كم سعر وجبة المشاوي المشكلة؟", "الموقع",
// "طرق الدفع", "طلب وجبة") must NOT trigger this. Only a leading
// discourse marker, an explicit anaphoric token, or an elliptical
// interrogative does.
function isLikelyFollowUp(text) {
  const normalized = normalizeForFollowUp(text);
  if (!normalized) return false;
  if (startsWithAnyMarker(normalized)) return true;
  const tokens = tokenizeNormalized(normalized);
  if (containsReferentialToken(tokens)) return true;
  if (isEllipticalQuestion(tokens)) return true;
  return false;
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
// `logTag` is accepted (callers still pass a per-request correlation
// string) but no longer emitted — the temporary stage-by-stage diagnostic
// logging was removed once the retrieval pipeline was confirmed.
export async function retrieveRelevantKnowledgeHybrid(
  supabase,
  { clientId, queryText, currentMessageText, contextText = "", matchCount = KNOWLEDGE_MATCH_COUNT, minSimilarity = KNOWLEDGE_MIN_SIMILARITY, logTag }
) {
  const trimmedQuery = (queryText || "").trim();
  if (!clientId || !trimmedQuery) {
    return { ok: false, reason: "missing_input", results: [] };
  }
  const effectiveCurrentText = (currentMessageText || trimmedQuery || "").trim();

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

  if (!vectorSearch.ok && !lexicalSearch.ok) {
    return { ok: false, reason: vectorSearch.reason || lexicalSearch.reason || "retrieval_failed", results: [] };
  }

  const { results } = fuseRankedResults({
    vectorRows: vectorSearch.ok ? vectorSearch.rows : [],
    lexicalRows: lexicalSearch.ok ? lexicalSearch.rows : [],
    limit: matchCount,
  });

  return { ok: true, results };
}
