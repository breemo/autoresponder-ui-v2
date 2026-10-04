import test from "node:test";
import assert from "node:assert/strict";
import {
  STRINGS,
  t,
  dirFor,
  resolveLang,
  resolveParentOrigin,
  createTokenStore,
  tokenStorageKey,
  createWidgetClient,
  createOutbox,
  errorStateFor,
  isFatalState,
  isAuthRecoverable,
  isAccepted,
  mergeMessages,
  nextPollDelay,
  normalizeVisitorText,
  roleLabelKey,
  statusBanner,
  newClientMessageId,
  POLL,
} from "../../../public/widget/widget-core.js";

const KEY = "wcpk_" + "A".repeat(32);
const PARENT = "https://shop.example.com";

// ---------------------------------------------------------------- origin
test("parent origin: ancestorOrigins first, referrer fallback, otherwise fail closed", () => {
  assert.equal(resolveParentOrigin({ ancestorOrigins: ["https://shop.example.com"], referrer: "https://evil.com/x" }), PARENT);
  assert.equal(resolveParentOrigin({ ancestorOrigins: [], referrer: "https://shop.example.com/products/1?q=2" }), PARENT);
  assert.equal(resolveParentOrigin({ referrer: "http://localhost:5173/demo" }), "http://localhost:5173");
  for (const bad of [{}, { ancestorOrigins: [], referrer: "" }, { referrer: "null" }, { ancestorOrigins: ["null"] }, { referrer: "javascript:alert(1)" }, { referrer: "not a url" }, { referrer: "file:///etc/passwd" }]) {
    assert.equal(resolveParentOrigin(bad), null, JSON.stringify(bad));
  }
  // a DOMStringList-like object works too
  assert.equal(resolveParentOrigin({ ancestorOrigins: { length: 1, 0: PARENT } }), PARENT);
});

test("createWidgetClient refuses to run without a parent origin (fail closed)", () => {
  assert.throws(() => createWidgetClient({ fetchImpl: async () => ({}), publicKey: KEY, parentOrigin: null, tokenStore: createTokenStore(null, KEY) }));
});

// ---------------------------------------------------------------- token store
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test("token store: key wc:<publicKey>, resume/replace, blocked-storage fallback to memory", () => {
  assert.equal(tokenStorageKey(KEY), `wc:${KEY}`);
  const s = memoryStorage();
  const store = createTokenStore(s, KEY);
  assert.equal(store.get(), null);
  store.set("tok-1");
  assert.equal(s._m.get(`wc:${KEY}`), "tok-1");
  store.set("tok-2");
  assert.equal(store.get(), "tok-2");

  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const blocked = createTokenStore(throwing, KEY);
  assert.equal(blocked.get(), null);
  blocked.set("tok-mem");
  assert.equal(blocked.get(), "tok-mem");
  const none = createTokenStore(null, KEY);
  none.set("x");
  assert.equal(none.get(), "x");
});

// ---------------------------------------------------------------- API client
function fakeApi(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization || null, body });
    const { status, json } = await handler(body, init.headers.Authorization || null, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetchImpl, calls };
}

test("client: bootstrap/session use the resolved parent origin; session sends stored token and always replaces it", async () => {
  const store = createTokenStore(memoryStorage(), KEY);
  store.set("old-token");
  const api = fakeApi((body) =>
    body.action === "session" ? { status: 200, json: { ok: true, token: "new-token", resumed: true } } : { status: 200, json: { ok: true, site: { title: "Shop" } } }
  );
  const c = createWidgetClient({ fetchImpl: api.fetchImpl, publicKey: KEY, parentOrigin: PARENT, tokenStore: store });
  await c.bootstrap();
  await c.session();
  assert.equal(api.calls[0].url, "/api/widget");
  assert.deepEqual(api.calls[0].body, { action: "bootstrap", key: KEY, parent_origin: PARENT });
  assert.equal(api.calls[0].auth, null);
  assert.deepEqual(api.calls[1].body, { action: "session", key: KEY, parent_origin: PARENT });
  assert.equal(api.calls[1].auth, "Bearer old-token");
  assert.equal(store.get(), "new-token");
});

test("client: ONE session recovery + ONE retry on 401 invalid/expired/stale; never loops", async () => {
  for (const code of ["invalid_token", "token_expired", "token_stale"]) {
    const store = createTokenStore(memoryStorage(), KEY);
    store.set("t0");
    let messagesCalls = 0;
    const api = fakeApi((body, auth) => {
      if (body.action === "session") return { status: 200, json: { ok: true, token: "t1" } };
      messagesCalls++;
      return auth === "Bearer t1" ? { status: 200, json: { ok: true, messages: [] } } : { status: 401, json: { ok: false, code } };
    });
    const c = createWidgetClient({ fetchImpl: api.fetchImpl, publicKey: KEY, parentOrigin: PARENT, tokenStore: store });
    const r = await c.messages();
    assert.equal(r.ok, true, code);
    assert.deepEqual(api.calls.map((x) => x.body.action), ["messages", "session", "messages"]);
    assert.equal(messagesCalls, 2);
  }
  // still 401 after recovery -> stop (3 calls total, no loop)
  const store = createTokenStore(memoryStorage(), KEY);
  const api = fakeApi((body) => (body.action === "session" ? { status: 200, json: { ok: true, token: "tX" } } : { status: 401, json: { ok: false, code: "invalid_token" } }));
  const c = createWidgetClient({ fetchImpl: api.fetchImpl, publicKey: KEY, parentOrigin: PARENT, tokenStore: store });
  const r = await c.send("hi", "cmid-1234");
  assert.equal(r.status, 401);
  assert.equal(api.calls.length, 3);
  // non-recoverable 401/403 -> no recovery attempt
  const api2 = fakeApi(() => ({ status: 403, json: { ok: false, code: "domain_not_allowed" } }));
  const c2 = createWidgetClient({ fetchImpl: api2.fetchImpl, publicKey: KEY, parentOrigin: PARENT, tokenStore: createTokenStore(null, KEY) });
  await c2.messages();
  assert.equal(api2.calls.length, 1);
});

test("client: messages uses the after cursor; send carries text + client_message_id; network failure -> status 0", async () => {
  const api = fakeApi((body) => ({ status: 202, json: { ok: true, accepted: true } }));
  const c = createWidgetClient({ fetchImpl: api.fetchImpl, publicKey: KEY, parentOrigin: PARENT, tokenStore: createTokenStore(null, KEY) });
  await c.messages({ created_at: "2026-10-04T10:00:00Z", id: "m1" });
  assert.deepEqual(api.calls[0].body, { action: "messages", after: { created_at: "2026-10-04T10:00:00Z", id: "m1" } });
  const r = await c.send("hello", "cmid-0001");
  assert.deepEqual(api.calls[1].body, { action: "send", text: "hello", client_message_id: "cmid-0001" });
  assert.equal(isAccepted(r), true);
  assert.equal(isAccepted({ ok: true, body: { ok: true } }), false);
  const broken = createWidgetClient({ fetchImpl: async () => { throw new TypeError("offline"); }, publicKey: KEY, parentOrigin: PARENT, tokenStore: createTokenStore(null, KEY) });
  const nr = await broken.messages();
  assert.deepEqual({ ok: nr.ok, status: nr.status, code: nr.code }, { ok: false, status: 0, code: "network" });
  assert.equal(errorStateFor(nr), "network");
});

// ---------------------------------------------------------------- outbox
test("outbox: client_message_id is stable across retries; rapid duplicate detection via hasSending", () => {
  let n = 0;
  const box = createOutbox({ idFactory: () => `cmid-${++n}`.padEnd(12, "0") });
  const a = box.add("hello");
  assert.equal(box.hasSending(), true);
  box.mark(a.localId, "failed");
  assert.equal(box.hasSending(), false);
  const again = box.retry(a.localId);
  assert.equal(again.clientMessageId, a.clientMessageId);
  const b = box.add("second");
  assert.notEqual(b.clientMessageId, a.clientMessageId);
  const id = newClientMessageId();
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/); // satisfies the backend client_message_id rule
  assert.match(newClientMessageId({}), /^[A-Za-z0-9_-]{8,64}$/); // fallback without crypto.randomUUID
});

test("outbox reconciliation: optimistic bubble removed once the stored visitor message arrives (oldest first, failed kept)", () => {
  const box = createOutbox({ now: () => new Date("2026-10-04T10:00:00Z") });
  const a = box.add("hi");
  const b = box.add("hi");
  const c = box.add("other");
  box.mark(a.localId, "sent");
  box.mark(b.localId, "sent");
  box.mark(c.localId, "failed");
  box.reconcile([{ id: "s1", role: "visitor", text: "hi", created_at: "2026-10-04T10:00:01.123456+00:00" }]);
  assert.deepEqual(box.list().map((i) => i.localId), [b.localId, c.localId]);
  box.reconcile([{ id: "s1", role: "visitor", text: "hi", created_at: "2026-10-04T10:00:01Z" }, { id: "s2", role: "visitor", text: "hi", created_at: "2026-10-04T10:00:02Z" }, { id: "s3", role: "bot", text: "other", created_at: "2026-10-04T10:00:03Z" }]);
  assert.deepEqual(box.list().map((i) => i.localId), [c.localId]); // failed stays for retry
});

test("text normalization matches the backend rule (trim, control chars, 1-2000)", () => {
  assert.equal(normalizeVisitorText("  hi\u0000 there\n "), "hi there");
  assert.equal(normalizeVisitorText("   "), null);
  assert.equal(normalizeVisitorText("a".repeat(2000)).length, 2000);
  assert.equal(normalizeVisitorText("a".repeat(2001)), null);
  assert.equal(normalizeVisitorText(5), null);
});

// ---------------------------------------------------------------- messages
test("messages: dedupe by id and chronological order (mixed timestamp formats)", () => {
  const merged = mergeMessages(
    [{ id: "b", created_at: "2026-10-04T10:00:02Z", text: "2" }, { id: "a", created_at: "2026-10-04T10:00:01Z", text: "1" }],
    [{ id: "b", created_at: "2026-10-04T10:00:02.000000+00:00", text: "2" }, { id: "c", created_at: "2026-10-04T10:00:03Z", text: "3" }, { id: "0", created_at: "2026-10-04T10:00:01Z", text: "tie" }]
  );
  assert.deepEqual(merged.map((m) => m.id), ["0", "a", "b", "c"]);
});

// ---------------------------------------------------------------- polling
test("polling schedule: 3s open+active, 10s open+idle, 30s closed with conversation, paused hidden / closed without conversation", () => {
  const now = 1_000_000;
  assert.equal(nextPollDelay({ open: true, lastActivityAt: now - 5000, now, baseMs: 3000 }), 3000);
  assert.equal(nextPollDelay({ open: true, lastActivityAt: now - POLL.ACTIVE_WINDOW_MS - 1, now, baseMs: 3000 }), 10000);
  assert.equal(nextPollDelay({ open: false, hasConversation: true, now, baseMs: 3000 }), 30000);
  assert.equal(nextPollDelay({ open: false, hasConversation: false, now }), null);
  assert.equal(nextPollDelay({ hidden: true, open: true, now }), null);
  assert.equal(nextPollDelay({ open: true, lastActivityAt: now, now, baseMs: 0 }), POLL.DEFAULT_BASE_MS); // invalid server value
  assert.equal(nextPollDelay({ open: true, lastActivityAt: now, now, baseMs: 5000 }), 5000); // server interval respected
});

test("polling backoff: exponential up to 60s; 429 backs off to >= 30s", () => {
  const now = 1_000_000;
  const d = (errorCount, extra = {}) => nextPollDelay({ open: true, lastActivityAt: now, now, baseMs: 3000, errorCount, ...extra });
  assert.equal(d(1), 6000);
  assert.equal(d(2), 12000);
  assert.equal(d(3), 24000);
  assert.equal(d(5), 60000);
  assert.equal(d(10), 60000);
  assert.ok(d(1, { rateLimited: true }) >= 30000);
  assert.ok(d(0, { rateLimited: true }) >= 30000);
});

// ---------------------------------------------------------------- status / roles / errors / i18n
test("status mapping: active -> no banner, waiting_human / closed banners; agent -> Team / الفريق", () => {
  assert.equal(statusBanner("active"), null);
  assert.equal(statusBanner(null), null);
  assert.equal(statusBanner("waiting_human"), "waiting_human");
  assert.equal(statusBanner("closed"), "closed");
  assert.equal(t("en", "waiting_human"), "A team member will reply shortly");
  assert.equal(t("ar", "waiting_human"), "سيرد عليك أحد أعضاء الفريق قريباً");
  assert.equal(roleLabelKey("agent"), "team");
  assert.equal(roleLabelKey("bot"), null);
  assert.equal(roleLabelKey("visitor"), null);
  assert.equal(t("en", "team"), "Team");
  assert.equal(t("ar", "team"), "الفريق");
});

test("error mapping never exposes raw backend text", () => {
  const cases = [
    [{ status: 404, code: "invalid_key" }, "unavailable"],
    [{ status: 403, code: "site_inactive" }, "unavailable"],
    [{ status: 403, code: "domain_not_allowed" }, "unavailable"],
    [{ status: 402, code: "service_unavailable" }, "unavailable"],
    [{ status: 503, code: "not_configured" }, "unavailable"],
    [{ status: 429, code: "rate_limited" }, "rate_limited"],
    [{ status: 502, code: "upstream_unavailable" }, "backend_unavailable"],
    [{ status: 500, code: "server_error" }, "backend_unavailable"],
    [{ status: 401, code: "token_expired" }, "session_expired"],
    [{ status: 0, code: "network" }, "network"],
    [{ status: 400, code: "invalid_text" }, "invalid_text"],
    [null, "network"],
  ];
  for (const [r, expected] of cases) assert.equal(errorStateFor(r), expected, JSON.stringify(r));
  assert.equal(isFatalState("unavailable"), true);
  assert.equal(isFatalState("rate_limited"), false);
  assert.equal(isAuthRecoverable({ status: 401, code: "token_stale" }), true);
  assert.equal(isAuthRecoverable({ status: 401, code: "forbidden_origin" }), false);
  for (const lang of ["en", "ar"]) for (const k of ["unavailable", "rate_limited", "backend_unavailable", "network", "session_expired", "invalid_text"]) assert.ok(t(lang, k).length > 3);
});

test("language/direction: ar -> rtl, en -> ltr; resolution order; complete string tables", () => {
  assert.equal(resolveLang("ar"), "ar");
  assert.equal(resolveLang("ar-SA"), "ar");
  assert.equal(resolveLang(undefined, "en-GB"), "en");
  assert.equal(resolveLang("", null, "ar-EG"), "ar");
  assert.equal(resolveLang("fr"), "en"); // unsupported -> en
  assert.equal(dirFor("ar"), "rtl");
  assert.equal(dirFor("en"), "ltr");
  assert.deepEqual(Object.keys(STRINGS.ar).sort(), Object.keys(STRINGS.en).sort());
  for (const k of ["placeholder", "send", "sending", "retry", "unavailable", "session_expired", "waiting_human", "closed", "team"]) {
    assert.ok(STRINGS.en[k] && STRINGS.ar[k], k);
    assert.notEqual(STRINGS.en[k], STRINGS.ar[k], k);
  }
});
