// AI Engine V1 — Phase 4B: shared OpenAI embeddings helper.
//
// Server-only, fetch()-based — no `openai` SDK dependency added (matches
// this project's existing minimal-dependency discipline, and mirrors how
// n8n's own live OpenAI integration already calls the chat completions
// endpoint via plain HTTP rather than an SDK). OPENAI_API_KEY is read
// only from process.env here, never from a VITE_-prefixed variable
// (which Vite would bundle into the browser build), never logged, never
// echoed back in any error — every error path below returns a short
// reason code only.
//
// Model/dimension are fixed constants, not per-call parameters — one
// embedding model for the whole Knowledge Base is a deliberate v1
// simplification (mixing models/dimensions in one vector column would be
// silently wrong: cosine distance between vectors from two different
// embedding models is meaningless). Change both together, deliberately,
// if this is ever revisited.
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

// Batches every string in `texts` into ONE OpenAI request (the API's
// `input` field natively accepts an array — this is what "batching"
// means here, not manual request-splitting logic). Never throws — every
// failure path returns { ok: false, reason }, so callers (ingestion,
// retrieval) can always degrade safely instead of crashing.
//
// Validates, in order:
//   1. input is a non-empty array of non-empty strings
//   2. OPENAI_API_KEY is configured
//   3. the HTTP response is 2xx
//   4. the response body actually parses and has a `data` array
//   5. that array's length matches the input count
//   6. every returned embedding has exactly EMBEDDING_DIMENSIONS values
// Results are re-sorted by each item's own `index` field before being
// returned — OpenAI's response shape carries that field precisely
// because position-based ordering is not a contract to lean on blindly.
export async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: false, reason: "empty_input" };
  }
  if (texts.some((text) => typeof text !== "string" || text.trim() === "")) {
    return { ok: false, reason: "empty_input" };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "missing_api_key" };
  }

  let response;
  try {
    response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });
  } catch (error) {
    return { ok: false, reason: "network_error" };
  }

  if (!response.ok) {
    return { ok: false, reason: "api_error", status: response.status };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, reason: "invalid_response" };
  }

  const data = payload?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    return { ok: false, reason: "count_mismatch" };
  }

  const sorted = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  const embeddings = [];
  for (const item of sorted) {
    const vector = item?.embedding;
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
      return { ok: false, reason: "wrong_dimension" };
    }
    embeddings.push(vector);
  }

  return { ok: true, embeddings };
}

// Single-text convenience wrapper (used by retrieval, which only ever
// embeds one query at a time) — kept in this file so both call sites
// share the exact same request/validation logic, never two copies that
// could drift.
export async function embedText(text) {
  const result = await embedTexts([text]);
  if (!result.ok) return result;
  return { ok: true, embedding: result.embeddings[0] };
}
