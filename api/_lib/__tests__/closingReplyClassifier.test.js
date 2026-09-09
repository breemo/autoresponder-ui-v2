import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyClosingReply, CLASSIFIER_MODEL, VALID_DECISIONS } from "../closingReplyClassifier.js";

// Semantic closing-confirm reply classifier — module behaviour.
//
// The network call is mocked; these tests pin the CONTRACT: one small
// structured call to the smallest existing OpenAI chat model, exactly
// three possible decisions, and a conservative "substantive" on every
// failure path (never "confirm" on uncertainty). They also guard that no
// affirmative/negative word list has crept back into the module.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

function mockFetch(responder) {
  globalThis.fetch = async (...args) => responder(...args);
}
function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
}
function okBody(decision) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decision }) } }] }) };
}

test("uses the smallest existing chat model, one structured JSON call, tiny max_tokens, temp 0", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  let body = null;
  mockFetch((url, opts) => {
    body = JSON.parse(opts.body);
    assert.match(url, /api\.openai\.com\/v1\/chat\/completions/);
    return okBody("confirm");
  });
  t.after(restore);

  await classifyClosingReply("يعطيكم العافية");
  assert.equal(CLASSIFIER_MODEL, "gpt-4o-mini");
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.temperature, 0);
  assert.ok(body.max_tokens <= 20);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content, "يعطيكم العافية");
});

test("only the customer's message is sent — no KB, profile, tools, or transcript", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  let body = null;
  mockFetch((_u, opts) => { body = JSON.parse(opts.body); return okBody("substantive"); });
  t.after(restore);

  await classifyClosingReply("كم سعر التوصيل؟");
  assert.equal(body.tools, undefined);
  assert.equal(body.messages.length, 2); // system + the one customer message, nothing else
  // system prompt frames the task; user turn is exactly the raw message
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[1].content, "كم سعر التوصيل؟");
  assert.doesNotMatch(body.messages[0].content, /knowledge base|business profile|transcript/i);
});

test("returns each of the three valid decisions verbatim when the model does", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  t.after(restore);
  for (const d of VALID_DECISIONS) {
    mockFetch(() => okBody(d));
    assert.deepEqual(await classifyClosingReply("x"), { ok: true, decision: d });
  }
});

test("case / whitespace from the model is normalised", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetch(() => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"  CONFIRM \\n"}' } }] }) }));
  t.after(restore);
  assert.equal((await classifyClosingReply("اه خلص")).decision, "confirm");
});

// --- safe default: substantive on every failure path -------------

test("empty / whitespace / non-string input -> substantive, no network call", async (t) => {
  let called = false;
  mockFetch(() => { called = true; return okBody("confirm"); });
  process.env.OPENAI_API_KEY = "test-key";
  t.after(restore);
  for (const v of ["", "   ", null, undefined, 42]) {
    assert.equal((await classifyClosingReply(v)).decision, "substantive");
  }
  assert.equal(called, false);
});

test("missing OPENAI_API_KEY -> substantive, no network call", async (t) => {
  let called = false;
  mockFetch(() => { called = true; return okBody("confirm"); });
  delete process.env.OPENAI_API_KEY;
  t.after(restore);
  const r = await classifyClosingReply("نعم");
  assert.equal(r.decision, "substantive");
  assert.equal(r.reason, "missing_api_key");
  assert.equal(called, false);
});

test("network error -> substantive (never thrown)", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetch(() => { throw new Error("ECONNRESET"); });
  t.after(restore);
  assert.equal((await classifyClosingReply("نعم")).decision, "substantive");
});

test("abort / timeout -> substantive", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetch(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
  t.after(restore);
  const r = await classifyClosingReply("نعم");
  assert.equal(r.decision, "substantive");
  assert.equal(r.reason, "timeout");
});

test("non-2xx -> substantive with status", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  mockFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
  t.after(restore);
  const r = await classifyClosingReply("نعم");
  assert.equal(r.decision, "substantive");
  assert.equal(r.status, 429);
});

test("unparseable body / non-JSON content / unknown label -> substantive", async (t) => {
  process.env.OPENAI_API_KEY = "test-key";
  t.after(restore);

  mockFetch(() => ({ ok: true, json: async () => { throw new Error("bad"); } }));
  assert.equal((await classifyClosingReply("x")).decision, "substantive");

  mockFetch(() => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }));
  assert.equal((await classifyClosingReply("x")).decision, "substantive");

  mockFetch(() => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"maybe"}' } }] }) }));
  assert.equal((await classifyClosingReply("x")).decision, "substantive");

  mockFetch(() => ({ ok: true, json: async () => ({ choices: [] }) }));
  assert.equal((await classifyClosingReply("x")).decision, "substantive");
});

test("the API key never appears in a returned result", async (t) => {
  process.env.OPENAI_API_KEY = "sk-super-secret";
  mockFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  t.after(restore);
  const r = await classifyClosingReply("نعم");
  assert.equal(JSON.stringify(r).includes("sk-super-secret"), false);
});

// --- no word list, ever -----------------------------------------

test("the module contains NO affirmative/negative/sign-off vocabulary list", () => {
  const src = fs.readFileSync(new URL("../closingReplyClassifier.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /AFFIRMATIVE_WORDS|NEGATIVE_WORDS|SIGNOFF_WORDS/);
  assert.doesNotMatch(src, /new Set\(\[/);
  assert.doesNotMatch(src, /\.(includes|startsWith)\(\s*["'`]/);
  // the meaning classes are described in prose, not matched as tokens
  assert.doesNotMatch(src, /\[\s*["']نعم["']/);
});

test("only three decisions exist", () => {
  assert.deepEqual([...VALID_DECISIONS].sort(), ["confirm", "continue", "substantive"]);
});
