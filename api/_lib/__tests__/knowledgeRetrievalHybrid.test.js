import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  retrieveRelevantKnowledgeHybrid,
  retrieveRelevantKnowledgeLexical,
  buildLexicalTsQuery,
  KNOWLEDGE_MATCH_COUNT,
  KNOWLEDGE_MIN_SIMILARITY,
} from "../knowledgeRetrieval.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../openaiEmbeddings.js";

// ===========================================================================
// AI Engine V1 — Phase 2: Hybrid Knowledge Retrieval test suite.
//
// This is a general retrieval evaluation set, not a Tasty-only test file —
// no business-domain assertions (menu/delivery/price wording) are baked in
// as pass/fail criteria; only the retrieval MECHANISM is under test here.
//
// IMPORTANT — what this file can and cannot prove (per explicit
// instruction: do not fabricate similarity scores):
//   - It CAN prove: RPC wiring/parameters, tenant isolation, merge/dedup
//     correctness, RRF ranking behavior, noise-protection tokenization,
//     failure isolation between the two retrieval paths, and the exact
//     output contract shape — all with mocked Supabase/OpenAI responses.
//   - It CANNOT prove actual retrieval QUALITY (whether a semantic
//     paraphrase, colloquial Arabic, or an Arabic/English mixed query
//     genuinely ranks the right chunk highest) — that requires real
//     OpenAI embeddings against a real, populated Supabase database. No
//     similarity/rank number below is invented to simulate that; every
//     mocked RPC response here is a deliberately constructed fixture
//     whose "correct" outcome follows mechanically from the fixture
//     itself, not from any claim about real-world retrieval quality. Real
//     quality evaluation belongs to the dedicated evaluation set described
//     in the Phase 0 architecture report (Tasty as one fixture among many
//     business types), run against live data — not this unit suite.
// ===========================================================================

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const FIXED_EMBEDDING = new Array(EMBEDDING_DIMENSIONS).fill(0.01);

function mockEmbeddingFetch() {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: FIXED_EMBEDDING }] }) });
  process.env.OPENAI_API_KEY = "test-key";
}

function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
}

// Routes by RPC name so vector and lexical paths can be independently
// controlled/failed per test.
function mockHybridSupabase({ vector, lexical }) {
  return {
    rpc: async (name, params) => {
      if (name === "match_knowledge_chunks") return vector ? vector(params) : { data: [], error: null };
      if (name === "match_knowledge_chunks_lexical") return lexical ? lexical(params) : { data: [], error: null };
      throw new Error(`unexpected RPC: ${name}`);
    },
  };
}

// --- 5/6/7/9/10/11/14 (mechanism only — see file header) -----------------

test("mechanism: an arbitrary query (menu/catalog request) runs both paths and returns the fused, capped shape", async (t) => {
  mockEmbeddingFetch();
  t.after(restore);

  const supabase = mockHybridSupabase({
    vector: () => ({ data: [{ chunk_id: "c1", document_id: "d1", document_title: "Menu", category: "menu", content: "Grilled chicken plate", similarity: 0.6 }], error: null }),
    lexical: () => ({ data: [], error: null }),
  });

  const result = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "عرض المنيو" });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.deepEqual(Object.keys(result.results[0]).sort(), ["category", "content", "document_id", "document_title", "similarity"].sort());
});

// --- 8. Numeric query -------------------------------------------------------

test("8. a numeric query tokenizes correctly for lexical search", () => {
  assert.equal(buildLexicalTsQuery("75"), "75:*");
  assert.equal(buildLexicalTsQuery("كم سعر 75"), "كم:* | سعر:* | 75:*");
});

// --- 12/13. Unknown / unrelated information --------------------------------

test("12/13. unknown or unrelated query: both paths legitimately empty is a normal, successful 'no results' outcome", async (t) => {
  mockEmbeddingFetch();
  t.after(restore);

  const supabase = mockHybridSupabase({
    vector: () => ({ data: [], error: null }),
    lexical: () => ({ data: [], error: null }),
  });

  const result = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "عندكم سوشي؟" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
});

// --- 15. Same chunk from vector + lexical -> returned once ------------------

test("15. a chunk found by BOTH vector and lexical search is returned exactly once, ranked above single-method matches", async (t) => {
  mockEmbeddingFetch();
  t.after(restore);

  const supabase = mockHybridSupabase({
    vector: () => ({
      data: [
        { chunk_id: "both-1", document_id: "d1", document_title: "Policy", category: "policy", content: "Found by both methods", similarity: 0.55 },
        { chunk_id: "vector-only", document_id: "d2", document_title: "Other", category: "other", content: "Vector only", similarity: 0.52 },
      ],
      error: null,
    }),
    lexical: () => ({
      data: [
        { chunk_id: "both-1", document_id: "d1", document_title: "Policy", category: "policy", content: "Found by both methods", lexical_rank: 0.9 },
        { chunk_id: "lexical-only", document_id: "d3", document_title: "Third", category: "other", content: "Lexical only", lexical_rank: 0.4 },
      ],
      error: null,
    }),
  });

  const result = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "test query" });

  assert.equal(result.ok, true);
  const chunkContents = result.results.map((r) => r.content);
  const occurrences = chunkContents.filter((c) => c === "Found by both methods").length;
  assert.equal(occurrences, 1, "a chunk present in both result sets must never be duplicated");
  assert.equal(result.results[0].content, "Found by both methods", "a chunk found by both methods should rank first");
  assert.ok(chunkContents.includes("Vector only"));
  assert.ok(chunkContents.includes("Lexical only"));
});

// --- 16. Tenant isolation ---------------------------------------------------

test("16. both the vector and lexical RPC calls are scoped to the exact client_id passed in — never any other id", async (t) => {
  mockEmbeddingFetch();
  t.after(restore);

  let vectorClientId, lexicalClientId;
  const supabase = mockHybridSupabase({
    vector: (params) => {
      vectorClientId = params.p_client_id;
      return { data: [], error: null };
    },
    lexical: (params) => {
      lexicalClientId = params.p_client_id;
      return { data: [], error: null };
    },
  });

  await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-A", queryText: "hours?" });

  assert.equal(vectorClientId, "client-A");
  assert.equal(lexicalClientId, "client-A");
});

// --- 17. Non-ready document exclusion (SQL-level — not JS-mockable) -------

test("17. the lexical migration enforces status='ready' and dual client_id scoping identically to the vector RPC (source-verified, not runnable here)", () => {
  // This property is enforced entirely inside the SQL function body — a
  // mocked RPC in this test file cannot prove it (the mock just returns
  // whatever fixture we hand it). Verified instead by inspecting the
  // actual migration source, the same guarantee real integration/manual
  // testing against a live Supabase project would need to confirm.
  const __filename = fileURLToPath(import.meta.url);
  const migrationPath = path.resolve(path.dirname(__filename), "../../../supabase/migrations/20260827_ai_engine_v1_phase2_lexical_retrieval.sql");
  const sql = fs.readFileSync(migrationPath, "utf-8");

  assert.match(sql, /c\.client_id\s*=\s*p_client_id/);
  assert.match(sql, /d\.client_id\s*=\s*p_client_id/);
  assert.match(sql, /d\.status\s*=\s*'ready'/);
  assert.match(sql, /grant execute on function public\.match_knowledge_chunks_lexical.* to service_role/);
  assert.match(sql, /revoke all on function public\.match_knowledge_chunks_lexical.* from public/);
  assert.match(sql, /revoke all on function public\.match_knowledge_chunks_lexical.* from anon/);
  assert.match(sql, /revoke all on function public\.match_knowledge_chunks_lexical.* from authenticated/);
});

// --- 18. Empty query ---------------------------------------------------------

test("18. an empty query is rejected before any network/RPC call, on both paths", async () => {
  const supabase = mockHybridSupabase({
    vector: () => { throw new Error("must not be called"); },
    lexical: () => { throw new Error("must not be called"); },
  });

  const result1 = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "   " });
  const result2 = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "", queryText: "hi" });

  assert.equal(result1.ok, false);
  assert.equal(result2.ok, false);
});

test("buildLexicalTsQuery returns null for empty/punctuation-only/too-short input — never calls the RPC", async () => {
  assert.equal(buildLexicalTsQuery(""), null);
  assert.equal(buildLexicalTsQuery("   "), null);
  assert.equal(buildLexicalTsQuery("؟!."), null);
  assert.equal(buildLexicalTsQuery("و"), null, "a single-letter token below the minimum length must be dropped, not searched");
});

// --- 19. Vector failure -> lexical still works ------------------------------

test("19. vector retrieval failing (RPC error) does not block lexical results", async (t) => {
  mockEmbeddingFetch();
  t.after(restore);

  const supabase = mockHybridSupabase({
    vector: () => ({ data: null, error: { message: "relation does not exist" } }),
    lexical: () => ({ data: [{ chunk_id: "l1", document_id: "d1", document_title: "FAQ", category: "faq", content: "Lexical result survives a vector failure", lexical_rank: 0.5 }], error: null }),
  });

  const result = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "test query" });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].content, "Lexical result survives a vector failure");
  assert.equal(result.results[0].similarity, null, "no fabricated similarity for a lexical-only result");
});

test("19b. vector retrieval failing at the embedding step (no OPENAI_API_KEY) does not block lexical results", async (t) => {
  t.after(restore);
  // No mockEmbeddingFetch() — embedText() fails with missing_api_key.

  const supabase = mockHybridSupabase({
    lexical: () => ({ data: [{ chunk_id: "l1", document_id: "d1", document_title: "FAQ", category: "faq", content: "Lexical still works without OpenAI", lexical_rank: 0.5 }], error: null }),
  });

  const result = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "test query" });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].content, "Lexical still works without OpenAI");
});

// --- 20. Lexical failure -> vector still works ------------------------------

test("20. lexical retrieval failing (RPC error — e.g. migration not yet applied) does not block vector results", async (t) => {
  mockEmbeddingFetch();
  t.after(restore);

  const supabase = mockHybridSupabase({
    vector: () => ({ data: [{ chunk_id: "v1", document_id: "d1", document_title: "Policy", category: "policy", content: "Vector result survives a lexical failure", similarity: 0.6 }], error: null }),
    lexical: () => ({ data: null, error: { message: "function match_knowledge_chunks_lexical does not exist" } }),
  });

  const result = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "test query" });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].content, "Vector result survives a lexical failure");
  assert.equal(result.results[0].similarity, 0.6);
});

test("both retrieval paths failing degrades to ok:false, matching today's single-method failure contract", async (t) => {
  mockEmbeddingFetch();
  t.after(restore);

  const supabase = mockHybridSupabase({
    vector: () => ({ data: null, error: { message: "boom" } }),
    lexical: () => ({ data: null, error: { message: "boom" } }),
  });

  const result = await retrieveRelevantKnowledgeHybrid(supabase, { clientId: "client-1", queryText: "test query" });

  assert.equal(result.ok, false);
  assert.deepEqual(result.results, []);
});

// --- retrieveRelevantKnowledgeLexical (public wrapper, direct) ------------

test("retrieveRelevantKnowledgeLexical: calls match_knowledge_chunks_lexical with an OR-combined prefix tsquery, scoped by client_id", async () => {
  let capturedName, capturedParams;
  const supabase = {
    rpc: async (name, params) => {
      capturedName = name;
      capturedParams = params;
      return { data: [], error: null };
    },
  };

  await retrieveRelevantKnowledgeLexical(supabase, { clientId: "client-1", queryText: "عرض المنيو" });

  assert.equal(capturedName, "match_knowledge_chunks_lexical");
  assert.equal(capturedParams.p_client_id, "client-1");
  assert.equal(capturedParams.p_tsquery, "عرض:* | المنيو:*");
  assert.equal(capturedParams.p_match_count, KNOWLEDGE_MATCH_COUNT);
});

test("retrieveRelevantKnowledgeLexical: RPC failure is reported, not thrown", async () => {
  const supabase = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
  const result = await retrieveRelevantKnowledgeLexical(supabase, { clientId: "client-1", queryText: "hours" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rpc_failed");
  assert.deepEqual(result.results, []);
});

test("retrieveRelevantKnowledgeLexical: normalizes rows into clean grounding metadata, never a raw chunk_id", async () => {
  const supabase = {
    rpc: async () => ({
      data: [{ chunk_id: "c1", document_id: "d1", document_title: "Menu", category: "menu", content: "Grilled chicken plate", lexical_rank: 0.4 }],
      error: null,
    }),
  };
  const result = await retrieveRelevantKnowledgeLexical(supabase, { clientId: "client-1", queryText: "chicken" });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].chunk_id, undefined);
});

// --- Constants unchanged (explicit re-confirmation for Phase 2) -----------

test("Phase 2 confirmation: KNOWLEDGE_MIN_SIMILARITY remains 0.50", () => {
  assert.equal(KNOWLEDGE_MIN_SIMILARITY, 0.5);
});

test("Phase 2 confirmation: KNOWLEDGE_MATCH_COUNT remains 5", () => {
  assert.equal(KNOWLEDGE_MATCH_COUNT, 5);
});

test("Phase 2 confirmation: embedding model/dimensions unchanged", () => {
  assert.equal(EMBEDDING_MODEL, "text-embedding-3-small");
  assert.equal(EMBEDDING_DIMENSIONS, 1536);
});
