import test from "node:test";
import assert from "node:assert/strict";
import { retrieveRelevantKnowledge, KNOWLEDGE_MATCH_COUNT, KNOWLEDGE_MIN_SIMILARITY } from "../knowledgeRetrieval.js";
import { EMBEDDING_DIMENSIONS } from "../openaiEmbeddings.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

function mockEmbeddingFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.01) }] }),
  });
  process.env.OPENAI_API_KEY = "test-key";
}

function restore(t) {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
}

function mockSupabaseRpc(handler) {
  return { rpc: async (name, params) => handler(name, params) };
}

test("retrieveRelevantKnowledge: calls match_knowledge_chunks with the correct parameters, including defaults", async (t) => {
  mockEmbeddingFetch();
  t.after(() => restore(t));

  let capturedName, capturedParams;
  const supabase = mockSupabaseRpc((name, params) => {
    capturedName = name;
    capturedParams = params;
    return { data: [], error: null };
  });

  await retrieveRelevantKnowledge(supabase, { clientId: "client-1", queryText: "what are your hours?" });

  assert.equal(capturedName, "match_knowledge_chunks");
  assert.equal(capturedParams.p_client_id, "client-1");
  assert.equal(capturedParams.p_match_count, KNOWLEDGE_MATCH_COUNT);
  assert.equal(capturedParams.p_min_similarity, KNOWLEDGE_MIN_SIMILARITY);
  assert.equal(capturedParams.p_query_embedding.length, EMBEDDING_DIMENSIONS);
});

test("retrieveRelevantKnowledge: top_k default is 5", () => {
  assert.equal(KNOWLEDGE_MATCH_COUNT, 5);
});

test("retrieveRelevantKnowledge: similarity threshold default is 0.50", () => {
  assert.equal(KNOWLEDGE_MIN_SIMILARITY, 0.5);
});

test("retrieveRelevantKnowledge: custom match_count/min_similarity override the defaults", async (t) => {
  mockEmbeddingFetch();
  t.after(() => restore(t));

  let capturedParams;
  const supabase = mockSupabaseRpc((name, params) => {
    capturedParams = params;
    return { data: [], error: null };
  });

  await retrieveRelevantKnowledge(supabase, { clientId: "client-1", queryText: "menu?", matchCount: 3, minSimilarity: 0.9 });

  assert.equal(capturedParams.p_match_count, 3);
  assert.equal(capturedParams.p_min_similarity, 0.9);
});

test("retrieveRelevantKnowledge: empty RPC results are a normal, successful 'no match' outcome", async (t) => {
  mockEmbeddingFetch();
  t.after(() => restore(t));

  const supabase = mockSupabaseRpc(() => ({ data: [], error: null }));
  const result = await retrieveRelevantKnowledge(supabase, { clientId: "client-1", queryText: "unrelated question" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
});

test("retrieveRelevantKnowledge: normalizes RPC rows into clean grounding metadata, never a raw vector", async (t) => {
  mockEmbeddingFetch();
  t.after(() => restore(t));

  const supabase = mockSupabaseRpc(() => ({
    data: [
      { chunk_id: "chunk-1", document_id: "doc-1", document_title: "Menu", category: "menu", content: "Grilled chicken plate", similarity: 0.88, embedding: [1, 2, 3] },
    ],
    error: null,
  }));

  const result = await retrieveRelevantKnowledge(supabase, { clientId: "client-1", queryText: "what food do you serve?" });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  const row = result.results[0];
  assert.equal(row.document_id, "doc-1");
  assert.equal(row.document_title, "Menu");
  assert.equal(row.category, "menu");
  assert.equal(row.content, "Grilled chicken plate");
  assert.equal(row.similarity, 0.88);
  assert.equal(row.embedding, undefined, "raw vector must never be returned");
  assert.equal(row.chunk_id, undefined, "internal chunk id is not part of the grounding shape returned to the prompt");
});

test("retrieveRelevantKnowledge: RPC failure is reported, not thrown", async (t) => {
  mockEmbeddingFetch();
  t.after(() => restore(t));

  const supabase = mockSupabaseRpc(() => ({ data: null, error: { message: "function does not exist" } }));
  const result = await retrieveRelevantKnowledge(supabase, { clientId: "client-1", queryText: "hours?" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "rpc_failed");
  assert.deepEqual(result.results, []);
});

test("retrieveRelevantKnowledge: an embedding failure is reported without ever calling the RPC", async (t) => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => restore(t));

  let rpcCalled = false;
  const supabase = mockSupabaseRpc(() => { rpcCalled = true; return { data: [], error: null }; });

  const result = await retrieveRelevantKnowledge(supabase, { clientId: "client-1", queryText: "hours?" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "api_error");
  assert.equal(rpcCalled, false);
});

test("retrieveRelevantKnowledge: missing client_id or empty query text is rejected before any network/RPC call", async () => {
  const supabase = mockSupabaseRpc(() => { throw new Error("must not be called"); });
  const result1 = await retrieveRelevantKnowledge(supabase, { clientId: "", queryText: "hi" });
  const result2 = await retrieveRelevantKnowledge(supabase, { clientId: "client-1", queryText: "   " });
  assert.equal(result1.ok, false);
  assert.equal(result2.ok, false);
});
