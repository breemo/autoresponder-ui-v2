import test from "node:test";
import assert from "node:assert/strict";
import {
  projectRefFromSupabaseUrl,
  originFromUrl,
  resolveWebsiteChatWebhook,
  createN8nWebsiteChatDelivery,
  DELIVERY_TIMEOUT_MS,
} from "../websiteChatOrchestrator.js";

const REF = "rdfqdkzcudcqjattpmpt";
const ENV = {
  SUPABASE_URL: `https://${REF}.supabase.co`,
  VITE_WEBHOOK_BASE_URL: "https://n8n-production-fcd4.up.railway.app/webhook/751ecf29-1acd-43b7-8c80-bd8f9929f656/inbound",
  AI_TOOLS_SECRET: "super-secret-value",
};
const MSG = { channelKey: "wc_" + "a".repeat(32), visitorId: "11111111-2222-4333-8444-555555555555", text: "hello", clientMessageId: "cmid-000001" };
const FIXED_NOW = () => new Date("2026-10-01T08:00:00.000Z");

function fakeFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  fn.calls = calls;
  return fn;
}

test("projectRef: only a valid https *.supabase.co host (20-char ref); everything else fails closed", () => {
  assert.equal(projectRefFromSupabaseUrl(`https://${REF}.supabase.co`), REF);
  assert.equal(projectRefFromSupabaseUrl(`https://${REF}.supabase.co/`), REF);
  for (const bad of [
    "", null, undefined, "not a url",
    `http://${REF}.supabase.co`,           // not https
    `https://${REF}.supabase.co.evil.com`, // suffix attack
    `https://evil.com/${REF}.supabase.co`,
    "https://db.example.com",              // custom domain
    "https://short.supabase.co",
    `https://x.${REF}.supabase.co`,
  ]) assert.equal(projectRefFromSupabaseUrl(bad), null, String(bad));
});

test("n8n origin: from existing VITE_WEBHOOK_BASE_URL, fallback to existing human_reply_webhook_url origin", async () => {
  assert.equal(originFromUrl(ENV.VITE_WEBHOOK_BASE_URL), "https://n8n-production-fcd4.up.railway.app");
  assert.deepEqual(await resolveWebsiteChatWebhook({ env: ENV }), {
    url: `https://n8n-production-fcd4.up.railway.app/webhook/website-chat-${REF}`,
  });
  const fallback = await resolveWebsiteChatWebhook({
    env: { SUPABASE_URL: ENV.SUPABASE_URL },
    getHumanReplyWebhookUrl: async () => "https://n8n.example.org/webhook/human-reply-Media",
  });
  assert.deepEqual(fallback, { url: `https://n8n.example.org/webhook/website-chat-${REF}` });
  // VITE_SUPABASE_URL fallback for the ref (existing repo convention, supabaseServer.js)
  assert.ok((await resolveWebsiteChatWebhook({ env: { VITE_SUPABASE_URL: ENV.SUPABASE_URL, VITE_WEBHOOK_BASE_URL: ENV.VITE_WEBHOOK_BASE_URL } })).url);
});

test("missing configuration -> not_configured (no request sent)", async () => {
  const cases = [
    { ...ENV, AI_TOOLS_SECRET: "" },
    { ...ENV, SUPABASE_URL: "https://db.example.com" },
    { SUPABASE_URL: ENV.SUPABASE_URL, AI_TOOLS_SECRET: "x" }, // no origin anywhere
  ];
  for (const env of cases) {
    const f = fakeFetch();
    const deliver = createN8nWebsiteChatDelivery({ env, fetchImpl: f, getHumanReplyWebhookUrl: async () => null });
    assert.deepEqual(await deliver(MSG), { delivered: false, reason: "not_configured" });
    assert.equal(f.calls.length, 0);
  }
  const throwing = createN8nWebsiteChatDelivery({
    env: { SUPABASE_URL: ENV.SUPABASE_URL, AI_TOOLS_SECRET: "x" },
    fetchImpl: fakeFetch(),
    getHumanReplyWebhookUrl: async () => { throw new Error("db down"); },
  });
  assert.deepEqual(await throwing(MSG), { delivered: false, reason: "not_configured" });
});

test("request: exact URL, POST, x-ai-tools-secret header, body allowlist (server-derived values only)", async () => {
  const f = fakeFetch();
  const deliver = createN8nWebsiteChatDelivery({ env: ENV, fetchImpl: f, now: FIXED_NOW });
  const out = await deliver({ ...MSG, client_id: "evil", conversation_id: "evil", extra: "x" });
  assert.deepEqual(out, { delivered: true });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, `https://n8n-production-fcd4.up.railway.app/webhook/website-chat-${REF}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-ai-tools-secret"], "super-secret-value");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), {
    channel_key: MSG.channelKey,
    visitor_id: MSG.visitorId,
    text: "hello",
    client_message_id: "cmid-000001",
    sent_at: "2026-10-01T08:00:00.000Z",
  });
  assert.ok(init.signal, "abortable");
});

test("non-2xx / network error / timeout -> not delivered with reason; no secret in results", async () => {
  for (const [resp, reason] of [
    [{ ok: false, status: 403 }, "http_403"],
    [{ ok: false, status: 500 }, "http_500"],
    [new TypeError("fetch failed"), "network_error"],
  ]) {
    const out = await createN8nWebsiteChatDelivery({ env: ENV, fetchImpl: fakeFetch(resp) })(MSG);
    assert.deepEqual(out, { delivered: false, reason });
    assert.ok(!JSON.stringify(out).includes(ENV.AI_TOOLS_SECRET));
  }

  // timeout: fetch never resolves until aborted
  const hanging = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const out = await createN8nWebsiteChatDelivery({ env: ENV, fetchImpl: hanging, timeoutMs: 20 })(MSG);
  assert.deepEqual(out, { delivered: false, reason: "timeout" });
  assert.equal(DELIVERY_TIMEOUT_MS, 8000);
});

test("module never logs (secret cannot leak through console)", async () => {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const seen = [];
  console.log = console.error = console.warn = (...a) => seen.push(a.join(" "));
  try {
    await createN8nWebsiteChatDelivery({ env: ENV, fetchImpl: fakeFetch({ ok: false, status: 500 }) })(MSG);
    await createN8nWebsiteChatDelivery({ env: ENV, fetchImpl: fakeFetch(new Error("x")) })(MSG);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!seen.join("\n").includes(ENV.AI_TOOLS_SECRET));
});
