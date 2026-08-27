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

// Pure, deterministic, network-free. Builds the string that actually
// gets embedded for retrieval:
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
  const trimmedCurrent = (currentMessageText || "").trim();
  if (!trimmedCurrent) return trimmedCurrent;
  if (!isLikelyFollowUp(trimmedCurrent)) return trimmedCurrent;

  const previousTurn = findPreviousTurn(trimmedCurrent, history);
  if (!previousTurn) return trimmedCurrent;

  const contextParts = [previousTurn.userMsg, previousTurn.assistantMsg].filter(Boolean);
  if (contextParts.length === 0) return trimmedCurrent;

  let combined = [...contextParts, trimmedCurrent].join(" ");

  if (combined.length > MAX_CONTEXTUAL_QUERY_LENGTH) {
    const budget = MAX_CONTEXTUAL_QUERY_LENGTH - trimmedCurrent.length - 1;
    if (budget <= 0) return trimmedCurrent;
    const truncatedContext = contextParts.join(" ").slice(0, budget).trim();
    combined = truncatedContext ? `${truncatedContext} ${trimmedCurrent}` : trimmedCurrent;
  }

  return combined;
}

export const KNOWLEDGE_MATCH_COUNT = 5;
// Lowered from 0.75 to 0.50 — live diagnostic against the Tasty client's
// real, ready documents (match_knowledge_chunks, p_min_similarity=0)
// showed the three genuinely relevant chunks scoring 0.5850/0.5398/0.5098,
// with the next-best result dropping to 0.3195 — 0.75 excluded every real
// match. 0.50 keeps that same clean separation from the drop-off. Model,
// dimensions, chunking, match count, and the RPC itself are unchanged.
export const KNOWLEDGE_MIN_SIMILARITY = 0.5;

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
