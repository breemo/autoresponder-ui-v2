import test from "node:test";
import assert from "node:assert/strict";
import { embedTexts, embedText, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../openaiEmbeddings.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

function mockFetchOnce(responder) {
  globalThis.fetch = async (...args) => responder(...args);
}

function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
}

function fakeVector(dims = EMBEDDING_DIMENSIONS) {
  return new Array(dims).fill(0.01);
}

test("embedTexts: empty array input is rejected without calling the API", async (t) => {
  let called = false;
  mockFetchOnce(() => { called = true; return { ok: true, json: async () => ({}) }; });
  t.after(restore);

  const result = await embedTexts([]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_input");
  assert.equal(called, false);
});

test("embedTexts: an array containing a blank string is rejected", async (t) => {
  mockFetchOnce(() => ({ ok: true, json: async () => ({}) }));
  t.after(restore);

  const result = await embedTexts(["real text", "   "]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_input");
});

test("embedTexts: missing OPENAI_API_KEY is rejected before any network call", async (t) => {
  let called = false;
  mockFetchOnce(() => { called = true; return { ok: true, json: async () => ({}) }; });
  delete process.env.OPENAI_API_KEY;
  t.after(restore);

  const result = await embedTexts(["hello"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_api_key");
  assert.equal(called, false);
});

test("embedTexts: a non-2xx OpenAI response is reported as api_error with the status code, never thrown", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetchOnce(() => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }));
  t.after(restore);

  const result = await embedTexts(["hello"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "api_error");
  assert.equal(result.status, 401);
});

test("embedTexts: an invalid/unparseable response body is rejected", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetchOnce(() => ({ ok: true, json: async () => { throw new Error("not json"); } }));
  t.after(restore);

  const result = await embedTexts(["hello"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_response");
});

test("embedTexts: a response shape missing the data array is rejected", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetchOnce(() => ({ ok: true, json: async () => ({ unexpected: "shape" }) }));
  t.after(restore);

  const result = await embedTexts(["hello"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "count_mismatch");
});

test("embedTexts: a result count mismatch (fewer embeddings than inputs) is rejected", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetchOnce(() => ({
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: fakeVector() }] }),
  }));
  t.after(restore);

  const result = await embedTexts(["one", "two"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "count_mismatch");
});

test("embedTexts: a wrong-dimension embedding is rejected, never silently truncated/padded", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetchOnce(() => ({
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: fakeVector(1024) }] }),
  }));
  t.after(restore);

  const result = await embedTexts(["hello"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_dimension");
});

test("embedTexts: happy path returns embeddings re-ordered by each item's own index, batched in one request", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  let requestBody = null;
  let callCount = 0;
  mockFetchOnce((url, options) => {
    callCount += 1;
    requestBody = JSON.parse(options.body);
    // Deliberately returned out of order — embedTexts must re-sort by index.
    return {
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: fakeVector().map((v) => v + 1) },
          { index: 0, embedding: fakeVector().map((v) => v + 0) },
        ],
      }),
    };
  });
  t.after(restore);

  const result = await embedTexts(["first chunk", "second chunk"]);
  assert.equal(result.ok, true);
  assert.equal(result.embeddings.length, 2);
  assert.equal(result.embeddings[0][0], 0.01); // index 0's vector, not index 1's
  assert.equal(result.embeddings[1][0], 1.01); // index 1's vector

  // One HTTP request for both chunks — not one request per chunk.
  assert.equal(callCount, 1);
  assert.equal(requestBody.model, EMBEDDING_MODEL);
  assert.deepEqual(requestBody.input, ["first chunk", "second chunk"]);
});

test("embedTexts: the API key is never present in the returned result or a thrown error", async (t) => {
  process.env.OPENAI_API_KEY = "sk-super-secret-value";
  mockFetchOnce(() => ({ ok: false, status: 401, json: async () => ({}) }));
  t.after(restore);

  const result = await embedTexts(["hello"]);
  assert.equal(JSON.stringify(result).includes("sk-super-secret-value"), false);
});

test("embedText: single-text convenience wrapper returns one embedding, not an array of arrays", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetchOnce(() => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: fakeVector() }] }) }));
  t.after(restore);

  const result = await embedText("customer question");
  assert.equal(result.ok, true);
  assert.equal(result.embedding.length, EMBEDDING_DIMENSIONS);
});
