import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOGIN_ERROR,
  handleAuthLogin,
  createLoginRateLimiter,
  passwordsMatch,
  toSafeUser,
  validateLoginRequest,
  clientIp,
} from "../authLogin.js";
import clientRouterHandler from "../../client-router.js";

// Security C2: server-side login (transitional; legacy plaintext compare).
// Network-free: every test injects a fake Supabase client.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const ADMIN = { id: "a-1", email: "admin@example.com", name: "Admin", role: "admin", password: "AdminPass#1", must_change_password: false };
const OWNER = { id: "u-1", email: "owner@example.com", name: "Owner", role: "client", password: "OwnerPass#1", must_change_password: true, password_hash: "x", reset_token: "y" };
const AGENT = { id: "u-2", email: "agent@example.com", name: "Agent", role: "client", password: "AgentPass#1", must_change_password: false };
const ORPHAN = { id: "u-3", email: "orphan@example.com", name: "Orphan", role: "client", password: "OrphanPass#1" };
const SECRETS = ["AdminPass#1", "OwnerPass#1", "AgentPass#1", "OrphanPass#1"];

const MEMBERSHIPS = {
  "u-1": { client_id: "c-1", role: "owner", is_active: true, permissions_overrides: null, language: "ar", clients: { id: "c-1", business_name: "Acme", email: "acme@example.com", default_language: "en" } },
  "u-2": { client_id: "c-1", role: "agent", is_active: false, permissions_overrides: { inbox: true }, language: null, clients: { id: "c-1", business_name: "Acme", email: "acme@example.com", default_language: "en" } },
};

// Minimal stand-in for the supabase-js builder calls authLogin.js makes.
function fakeSupabase({ users = [ADMIN, OWNER, AGENT, ORPHAN], memberships = MEMBERSHIPS, failUsers = false, failMembership = false, throwLanguage = false, throwUsers = false } = {}) {
  const calls = { updates: [], selects: [] };
  const supabase = {
    calls,
    from(table) {
      const q = { table, filters: {}, cols: null, patch: null };
      const builder = {
        select(cols) {
          q.cols = cols;
          calls.selects.push(`${table}:${cols}`);
          return builder;
        },
        update(patch) {
          q.patch = patch;
          return builder;
        },
        eq(col, val) {
          q.filters[col] = val;
          return builder;
        },
        limit() {
          if (throwUsers) throw new Error("socket hang up");
          if (failUsers) return Promise.resolve({ data: null, error: { code: "XX000", message: "db down" } });
          return Promise.resolve({ data: users.filter((u) => u.email === q.filters.email).map((u) => ({ ...u })), error: null });
        },
        maybeSingle() {
          const m = memberships[q.filters.user_id];
          if (q.cols.startsWith("language")) {
            if (throwLanguage) throw new Error("column client_users.language does not exist");
            return Promise.resolve({ data: m ? { language: m.language, clients: { default_language: m.clients.default_language } } : null, error: null });
          }
          if (failMembership) return Promise.resolve({ data: null, error: { message: "boom" } });
          if (!m) return Promise.resolve({ data: null, error: null });
          const { language, ...rest } = m;
          return Promise.resolve({ data: { ...rest, clients: { id: m.clients.id, business_name: m.clients.business_name, email: m.clients.email } }, error: null });
        },
        then(resolve, reject) {
          if (q.patch) calls.updates.push({ table, patch: q.patch, filters: { ...q.filters } });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return supabase;
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

const post = (body, ip = "203.0.113.7") => ({ method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` }, body });

async function login(body, deps = {}, req = post(body)) {
  const res = mockRes();
  await handleAuthLogin(req, res, { supabase: fakeSupabase(), rateLimiter: createLoginRateLimiter(), ...deps });
  return res;
}

function assertNoSecrets(res) {
  const raw = JSON.stringify(res.body);
  for (const s of SECRETS) assert.equal(raw.includes(s), false, `response leaked ${s}`);
  assert.equal(/"password"|password_hash|reset_token/.test(raw), false, raw);
}

// ---- valid logins ----------------------------------------------------

test("admin login: 200 with sanitized user, no membership lookup", async () => {
  const supabase = fakeSupabase();
  const res = await login({ email: ADMIN.email, password: ADMIN.password }, { supabase });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.user, { id: "a-1", email: "admin@example.com", name: "Admin", role: "admin", must_change_password: false });
  assert.equal(supabase.calls.selects.some((s) => s.startsWith("client_users")), false);
  assertNoSecrets(res);
});

test("client login: membership, business name, language and must_change_password are returned", async () => {
  const res = await login({ email: OWNER.email, password: OWNER.password });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.user, {
    id: "u-1",
    email: "owner@example.com",
    name: "Owner",
    role: "client",
    must_change_password: true,
    client_id: "c-1",
    business_name: "Acme",
    client_role: "owner",
    is_active: true,
    permissions_overrides: null,
    ui_language_user: "ar",
    ui_language_client: "en",
  });
  assertNoSecrets(res);
});

test("language lookup failure never blocks login (nulls, as before)", async () => {
  const res = await login({ email: OWNER.email, password: OWNER.password }, { supabase: fakeSupabase({ throwLanguage: true }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.ui_language_user, null);
  assert.equal(res.body.user.ui_language_client, null);
});

test("successful login stamps last_login_at server-side", async () => {
  const supabase = fakeSupabase();
  await login({ email: OWNER.email, password: OWNER.password }, { supabase });
  assert.equal(supabase.calls.updates.length, 1);
  assert.equal(supabase.calls.updates[0].table, "users");
  assert.deepEqual(Object.keys(supabase.calls.updates[0].patch), ["last_login_at"]);
  assert.deepEqual(supabase.calls.updates[0].filters, { id: "u-1" });
});

// ---- invalid logins --------------------------------------------------

test("wrong password and unknown email return the same 401 (no enumeration)", async () => {
  const wrong = await login({ email: OWNER.email, password: "nope" });
  const unknown = await login({ email: "ghost@example.com", password: "nope" });
  for (const res of [wrong, unknown]) {
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { success: false, code: LOGIN_ERROR.INVALID_CREDENTIALS });
  }
});

test("email match stays exact, as with the previous browser query", async () => {
  const res = await login({ email: "OWNER@example.com", password: OWNER.password });
  assert.equal(res.statusCode, 401);
});

test("no last_login_at write on failed login", async () => {
  const supabase = fakeSupabase();
  await login({ email: OWNER.email, password: "nope" }, { supabase });
  assert.equal(supabase.calls.updates.length, 0);
});

// ---- membership / active checks --------------------------------------

test("client without membership -> 403 no_membership", async () => {
  const res = await login({ email: ORPHAN.email, password: ORPHAN.password });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, code: LOGIN_ERROR.NO_MEMBERSHIP });
});

test("membership lookup error -> 403 no_membership (same as before)", async () => {
  const res = await login({ email: OWNER.email, password: OWNER.password }, { supabase: fakeSupabase({ failMembership: true }) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, LOGIN_ERROR.NO_MEMBERSHIP);
});

test("inactive membership -> 403 account_disabled, no user returned", async () => {
  const res = await login({ email: AGENT.email, password: AGENT.password });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { success: false, code: LOGIN_ERROR.ACCOUNT_DISABLED });
});

// ---- validation ------------------------------------------------------

test("non-POST -> 405", async () => {
  const res = mockRes();
  await handleAuthLogin({ method: "GET", headers: {} }, res, { supabase: fakeSupabase() });
  assert.equal(res.statusCode, 405);
});

test("malformed bodies -> 400 invalid_request before any DB access", async () => {
  const supabase = fakeSupabase();
  for (const body of [null, "not json", {}, { email: "a@b.c" }, { password: "x" }, { email: "", password: "x" }, { email: "a@b.c", password: "" }, { email: ["a"], password: "x" }, { email: "a@b.c", password: { $ne: null } }, { email: "a".repeat(321), password: "x" }, { email: "a@b.c", password: "x".repeat(1025) }]) {
    const res = mockRes();
    await handleAuthLogin(post(body), res, { supabase, rateLimiter: createLoginRateLimiter() });
    assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 60));
    assert.equal(res.body.code, LOGIN_ERROR.INVALID_REQUEST);
  }
  assert.equal(supabase.calls.selects.length, 0);
});

test("JSON string body is accepted", async () => {
  const res = await login(JSON.stringify({ email: ADMIN.email, password: ADMIN.password }));
  assert.equal(res.statusCode, 200);
});

test("validateLoginRequest keeps the email exactly as typed", () => {
  assert.deepEqual(validateLoginRequest({ email: " a@b.c", password: "p" }), { email: " a@b.c", password: "p" });
});

// ---- rate limiting ---------------------------------------------------

test("5 failed attempts for one email -> 429 with Retry-After, even with the right password", async () => {
  const rateLimiter = createLoginRateLimiter();
  for (let i = 0; i < 5; i++) {
    const res = await login({ email: OWNER.email, password: "nope" }, { rateLimiter }, post({ email: OWNER.email, password: "nope" }, `198.51.100.${i}`));
    assert.equal(res.statusCode, 401);
  }
  const res = await login({ email: OWNER.email, password: OWNER.password }, { rateLimiter });
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { success: false, code: LOGIN_ERROR.RATE_LIMITED });
  assert.ok(Number(res.headers["Retry-After"]) > 0);
});

test("email limit is case-insensitive and other emails are unaffected", async () => {
  const rateLimiter = createLoginRateLimiter({ maxFailuresPerEmail: 2 });
  await login({ email: "Owner@example.com", password: "x" }, { rateLimiter });
  await login({ email: "owner@EXAMPLE.com", password: "x" }, { rateLimiter });
  assert.equal((await login({ email: OWNER.email, password: OWNER.password }, { rateLimiter })).statusCode, 429);
  assert.equal((await login({ email: ADMIN.email, password: ADMIN.password }, { rateLimiter })).statusCode, 200);
});

test("per-IP attempt cap -> 429; a different IP is unaffected", async () => {
  const rateLimiter = createLoginRateLimiter({ maxAttemptsPerIp: 3 });
  for (let i = 0; i < 3; i++) await login({ email: `x${i}@example.com`, password: "x" }, { rateLimiter });
  assert.equal((await login({ email: ADMIN.email, password: ADMIN.password }, { rateLimiter })).statusCode, 429);
  const other = await login({ email: ADMIN.email, password: ADMIN.password }, { rateLimiter }, post({ email: ADMIN.email, password: ADMIN.password }, "192.0.2.9"));
  assert.equal(other.statusCode, 200);
});

test("successful login resets the email failure counter", async () => {
  const rateLimiter = createLoginRateLimiter({ maxFailuresPerEmail: 2 });
  await login({ email: OWNER.email, password: "x" }, { rateLimiter });
  assert.equal((await login({ email: OWNER.email, password: OWNER.password }, { rateLimiter })).statusCode, 200);
  await login({ email: OWNER.email, password: "x" }, { rateLimiter });
  assert.equal((await login({ email: OWNER.email, password: OWNER.password }, { rateLimiter })).statusCode, 200);
});

test("limits expire after the window", async () => {
  let t = 1_000_000;
  const rateLimiter = createLoginRateLimiter({ maxFailuresPerEmail: 1, windowMs: 1000, now: () => t });
  await login({ email: OWNER.email, password: "x" }, { rateLimiter });
  assert.equal((await login({ email: OWNER.email, password: OWNER.password }, { rateLimiter })).statusCode, 429);
  t += 1001;
  assert.equal((await login({ email: OWNER.email, password: OWNER.password }, { rateLimiter })).statusCode, 200);
});

test("limiter memory is bounded", () => {
  const limiter = createLoginRateLimiter({ maxKeys: 50 });
  for (let i = 0; i < 500; i++) limiter.recordAttempt(`10.0.${i}`);
  assert.equal(limiter.check("10.0.499", "e").limited, false);
});

test("clientIp uses the first x-forwarded-for hop", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }), "203.0.113.7");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
});

// ---- server errors / fail closed --------------------------------------

test("users lookup error -> 500 server_error, nothing leaked", async () => {
  const res = await login({ email: OWNER.email, password: OWNER.password }, { supabase: fakeSupabase({ failUsers: true }) });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, code: LOGIN_ERROR.SERVER_ERROR });
});

test("thrown exception -> 500 server_error", async () => {
  const res = await login({ email: OWNER.email, password: OWNER.password }, { supabase: fakeSupabase({ throwUsers: true }) });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, LOGIN_ERROR.SERVER_ERROR);
});

test("fails closed (503) without the service-role key — never falls back to the anon key", async () => {
  for (const env of [{}, { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" }, { SUPABASE_SERVICE_ROLE_KEY: "svc" }]) {
    const res = mockRes();
    await handleAuthLogin(post({ email: ADMIN.email, password: ADMIN.password }), res, { env, rateLimiter: createLoginRateLimiter() });
    assert.equal(res.statusCode, 503, JSON.stringify(Object.keys(env)));
    assert.deepEqual(res.body, { success: false, code: LOGIN_ERROR.SERVER_UNAVAILABLE });
  }
});

test("router dispatches ?resource=login (and fails closed with no env)", async () => {
  const keys = ["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const res = mockRes();
    await clientRouterHandler({ method: "POST", query: { resource: "login" }, headers: {}, body: { email: "a@b.c", password: "x" } }, res);
    assert.equal(res.statusCode, 503);
  } finally {
    for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});

// ---- no credential logging -------------------------------------------

test("no password, email or raw error is ever logged", async () => {
  const logged = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  console.error = console.log = console.warn = (...a) => logged.push(a.map(String).join(" "));
  try {
    await login({ email: OWNER.email, password: OWNER.password }, { supabase: fakeSupabase({ failUsers: true }) });
    await login({ email: OWNER.email, password: OWNER.password }, { supabase: fakeSupabase({ throwUsers: true }) });
    await login({ email: OWNER.email, password: "WrongPass#9" });
    await handleAuthLogin(post({ email: OWNER.email, password: OWNER.password }), mockRes(), { env: {}, rateLimiter: createLoginRateLimiter() });
  } finally {
    Object.assign(console, orig);
  }
  const all = logged.join("\n");
  for (const s of [...SECRETS, "WrongPass#9", OWNER.email, "socket hang up", "db down"]) assert.equal(all.includes(s), false, s);
});

// ---- helpers ---------------------------------------------------------

test("toSafeUser drops credential-like columns but keeps must_change_password", () => {
  const safe = toSafeUser({ id: 1, password: "p", PASSWORD: "p", password_hash: "h", api_key: "k", refresh_token: "t", client_secret: "s", must_change_password: true, name: "n" });
  assert.deepEqual(safe, { id: 1, must_change_password: true, name: "n" });
});

test("passwordsMatch is exact and rejects non-strings / empty stored values", () => {
  assert.equal(passwordsMatch("abc", "abc"), true);
  assert.equal(passwordsMatch("abc", "abd"), false);
  assert.equal(passwordsMatch("abc", "ABC"), false);
  assert.equal(passwordsMatch(null, "abc"), false);
  assert.equal(passwordsMatch("", ""), false);
  assert.equal(passwordsMatch("abc", undefined), false);
});

test("browser Login no longer touches the users table or the password column", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/pages/Login.jsx"), "utf8");
  assert.equal(/from\(["']users["']\)/.test(src), false);
  assert.equal(/\.eq\(["']password["']/.test(src), false);
  assert.equal(/supabaseClient/.test(src), false);
});
