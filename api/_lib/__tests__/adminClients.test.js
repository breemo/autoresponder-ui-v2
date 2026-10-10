import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import systemSettingsHandler from "../../system-settings.js";
import { ADMIN_CLIENTS_ERROR, subscriptionPeriod } from "../adminClients.js";

// Security C2.1: Admin Clients create/delete moved server-side
// (POST /api/system-settings?resource=clients). Behavior must match the
// previous browser flows in src/pages/admin/AdminClients.jsx exactly.
// Network-free: an in-memory Supabase stand-in records every operation.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const code = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ADMIN = { id: "u-admin", email: "admin@example.com", name: "Admin", role: "admin", must_change_password: false, password: "AdminSecret#1" };
const ENV = { SUPABASE_SERVICE_ROLE_KEY: "test-service-role" };
const NOW = new Date("2026-10-10T09:00:00.000Z");

// fail: { "table:op": ... } or { "table:op:col1,col2": ... } (filter columns)
//   value: { code } (returned as error) | "throw"; op = select | insert | delete
function makeDb({ users = [], clients = [], subscriptions = [], client_users = [], fail = {} } = {}) {
  const tables = { users: [ADMIN, ...users], clients: [...clients], subscriptions: [...subscriptions], client_users: [...client_users] };
  const ops = [];
  let seq = 0;
  const db = {
    tables,
    ops,
    from(table) {
      const filters = [];
      let op = "select";
      let payload = null;
      let returning = false;
      const rows = () => (tables[table] = tables[table] || []);
      const matches = (r) => filters.every(([c, v]) => r[c] === v);
      const failure = () => fail[`${table}:${op}:${filters.map(([c]) => c).join(",")}`] ?? fail[`${table}:${op}`];
      const run = () => {
        ops.push({ table, op, filters: Object.fromEntries(filters), payload });
        const f = failure();
        if (f === "throw") throw new Error("network down");
        if (f) return { data: null, error: f };
        if (op === "insert") {
          const inserted = payload.map((r) => ({ id: `${table}-${++seq}`, is_active: true, created_at: NOW.toISOString(), ...r }));
          rows().push(...inserted);
          return { data: inserted, error: null };
        }
        if (op === "delete") {
          const keep = rows().filter((r) => !matches(r));
          const removed = rows().length - keep.length;
          tables[table] = keep;
          return { data: null, error: null, count: removed };
        }
        return { data: rows().filter(matches), error: null };
      };
      const q = {
        select() {
          if (op === "insert") returning = true;
          return q;
        },
        eq(c, v) { filters.push([c, v]); return q; },
        insert(r) { op = "insert"; payload = Array.isArray(r) ? r : [r]; return q; },
        delete() { op = "delete"; return q; },
        async maybeSingle() {
          const r = run();
          if (r.error) return r;
          if (r.data.length > 1) return { data: null, error: { code: "PGRST116" } };
          return { data: r.data[0] || null, error: null };
        },
        async single() {
          const r = run();
          if (r.error) return r;
          return { data: r.data[0] || null, error: null };
        },
        then(resolve, reject) {
          try {
            const r = run();
            return Promise.resolve(returning ? r : { ...r, data: null }).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e).then(resolve, reject);
          }
        },
      };
      return q;
    },
  };
  return db;
}

const mockRes = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

async function call(db, body, { env = ENV, actor = "u-admin", method = "POST", resource = "clients" } = {}) {
  const res = mockRes();
  await systemSettingsHandler({ method, query: { resource }, body: { actor_user_id: actor, ...body } }, res, { supabase: db, env, now: () => NOW });
  return res;
}

// The exact date math the browser used before C2.1 (AdminClients.jsx).
function browserPeriodEnd(type) {
  const endDate = new Date(NOW.getTime());
  if (type === "trial") endDate.setDate(endDate.getDate() + 3);
  else endDate.setMonth(endDate.getMonth() + 1);
  return endDate.toISOString();
}

const createBody = (extra = {}) => ({ action: "create", business_name: "  Acme Store ", email: " Owner@Acme.COM ", password: "Initial#Pass1", plan_id: "", subscription_type: "trial", ...extra });
const writes = (db) => db.ops.filter((o) => o.op !== "select").map((o) => `${o.op}:${o.table}`);

function assertNoSecrets(res) {
  const raw = JSON.stringify(res.body);
  for (const s of ["Initial#Pass1", "AdminSecret#1", "test-service-role", "password"]) assert.equal(raw.includes(s), false, `${s} leaked: ${raw}`);
}

// ---- create ----------------------------------------------------------

test("create without plan: client + owner user + owner membership, in the original order", async () => {
  const db = makeDb();
  const res = await call(db, createBody());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.client_id);
  assert.deepEqual(writes(db), ["insert:clients", "insert:users", "insert:client_users"]);
  assert.deepEqual(db.ops.slice(1, 3).map((o) => `${o.table}:${JSON.stringify(o.filters)}`), [
    'users:{"email":"owner@acme.com"}',
    'clients:{"email":"owner@acme.com"}',
  ]);
  const client = db.tables.clients[0];
  assert.equal(client.business_name, "Acme Store");
  assert.equal(client.email, "owner@acme.com");
  assert.equal(client.plan_id, null);
  assert.equal(db.tables.subscriptions.length, 0);
  assertNoSecrets(res);
});

test("owner user keeps the admin-entered initial password and must_change_password: true", async () => {
  const db = makeDb();
  await call(db, createBody());
  const owner = db.tables.users.find((u) => u.email === "owner@acme.com");
  assert.deepEqual(
    { email: owner.email, name: owner.name, role: owner.role, password: owner.password, must_change_password: owner.must_change_password },
    { email: "owner@acme.com", name: "Acme Store", role: "client", password: "Initial#Pass1", must_change_password: true }
  );
  const link = db.tables.client_users[0];
  assert.deepEqual({ client_id: link.client_id, user_id: link.user_id, role: link.role }, { client_id: db.tables.clients[0].id, user_id: owner.id, role: "owner" });
});

test("owner role cannot be influenced by the request (always 'client' / 'owner')", async () => {
  const db = makeDb();
  await call(db, createBody({ role: "admin", client_role: "it" }));
  const owner = db.tables.users.find((u) => u.email === "owner@acme.com");
  assert.equal(owner.role, "client");
  assert.equal(db.tables.client_users[0].role, "owner");
});

test("create with plan (trial): subscription active, +3 days, inserted between client and user", async () => {
  const db = makeDb();
  const res = await call(db, createBody({ plan_id: "plan-1", subscription_type: "trial" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(writes(db), ["insert:clients", "insert:subscriptions", "insert:users", "insert:client_users"]);
  const sub = db.tables.subscriptions[0];
  assert.equal(sub.client_id, db.tables.clients[0].id);
  assert.equal(sub.plan_id, "plan-1");
  assert.equal(sub.subscription_type, "trial");
  assert.equal(sub.status, "active");
  assert.equal(sub.start_date, NOW.toISOString());
  assert.equal(sub.end_date, browserPeriodEnd("trial"));
  assert.equal(db.tables.clients[0].plan_id, "plan-1");
});

test("create with plan (paid): +1 month", async () => {
  const db = makeDb();
  await call(db, createBody({ plan_id: "plan-2", subscription_type: "paid" }));
  assert.equal(db.tables.subscriptions[0].end_date, browserPeriodEnd("paid"));
  assert.equal(subscriptionPeriod("paid", NOW).end_date, browserPeriodEnd("paid"));
});

test("duplicate email in users -> 409 email_in_use_users, nothing written", async () => {
  const db = makeDb({ users: [{ id: "u-x", email: "owner@acme.com", role: "client" }] });
  const res = await call(db, createBody());
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { success: false, code: ADMIN_CLIENTS_ERROR.EMAIL_IN_USE_USERS });
  assert.deepEqual(writes(db), []);
});

test("duplicate email in clients -> 409 email_in_use_clients, nothing written", async () => {
  const db = makeDb({ clients: [{ id: "c-x", email: "owner@acme.com" }] });
  const res = await call(db, createBody());
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { success: false, code: ADMIN_CLIENTS_ERROR.EMAIL_IN_USE_CLIENTS });
  assert.deepEqual(writes(db), []);
});

test("missing / invalid fields -> 400 before any DB access", async () => {
  for (const extra of [{ business_name: "" }, { email: "" }, { password: "" }, { password: 123 }, { email: ["a"] }, { subscription_type: "lifetime", plan_id: "p" }, { plan_id: 5 }]) {
    const db = makeDb();
    const res = await call(db, createBody(extra));
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
    assert.equal(res.body.code, ADMIN_CLIENTS_ERROR.INVALID_REQUEST);
    assert.equal(db.ops.filter((o) => o.table !== "users" || o.filters.id !== "u-admin").length, 0);
  }
});

// ---- create failures & rollback --------------------------------------

test("lookup error -> 500 create_failed, nothing written, no rollback needed", async () => {
  const db = makeDb({ fail: { "clients:select": { code: "XX000" } } });
  const res = await call(db, createBody());
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, code: ADMIN_CLIENTS_ERROR.CREATE_FAILED });
  assert.deepEqual(writes(db), []);
});

test("client insert fails -> nothing to roll back", async () => {
  const db = makeDb({ fail: { "clients:insert": { code: "23505" } } });
  const res = await call(db, createBody({ plan_id: "plan-1" }));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(writes(db), ["insert:clients"]);
});

test("subscription insert fails -> client rolled back", async () => {
  const db = makeDb({ fail: { "subscriptions:insert": { code: "23503" } } });
  const res = await call(db, createBody({ plan_id: "plan-1" }));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(writes(db), ["insert:clients", "insert:subscriptions", "delete:clients"]);
  assert.equal(db.tables.clients.length, 0);
});

test("user insert fails -> subscription then client rolled back (original order)", async () => {
  const db = makeDb({ fail: { "users:insert": { code: "23505" } } });
  const res = await call(db, createBody({ plan_id: "plan-1" }));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(writes(db), ["insert:clients", "insert:subscriptions", "insert:users", "delete:subscriptions", "delete:clients"]);
  assert.equal(db.tables.subscriptions.length, 0);
  assert.equal(db.tables.clients.length, 0);
});

test("membership insert fails -> user, subscription, client rolled back in that order", async () => {
  const db = makeDb({ fail: { "client_users:insert": { code: "23505" } } });
  const res = await call(db, createBody({ plan_id: "plan-1" }));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(writes(db), ["insert:clients", "insert:subscriptions", "insert:users", "insert:client_users", "delete:users", "delete:subscriptions", "delete:clients"]);
  assert.equal(db.tables.users.some((u) => u.email === "owner@acme.com"), false);
  assert.equal(db.tables.clients.length, 0);
  assertNoSecrets(res);
});

test("a thrown exception mid-flow still rolls back and returns create_failed", async () => {
  const db = makeDb({ fail: { "client_users:insert": "throw" } });
  const res = await call(db, createBody());
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, ADMIN_CLIENTS_ERROR.CREATE_FAILED);
  assert.deepEqual(writes(db).slice(-2), ["delete:users", "delete:clients"]);
});

test("rollback failures are ignored (best-effort, as before)", async () => {
  const db = makeDb({ fail: { "client_users:insert": { code: "23505" }, "users:delete": "throw", "clients:delete": { code: "XX000" } } });
  const res = await call(db, createBody());
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, ADMIN_CLIENTS_ERROR.CREATE_FAILED);
});

// ---- delete (existing semantics, unchanged) ---------------------------

function deleteFixture(extra = {}) {
  return makeDb({
    clients: [{ id: "c-1", email: "owner@acme.com" }, { id: "c-2", email: "other@x.com" }],
    users: [
      { id: "u-owner", email: "owner@acme.com", role: "client" },
      { id: "u-agent", email: "agent@acme.com", role: "client" },
      { id: "u-other", email: "other@x.com", role: "client" },
    ],
    client_users: [
      { id: "m-1", client_id: "c-1", user_id: "u-owner" },
      { id: "m-2", client_id: "c-1", user_id: "u-agent" },
      { id: "m-3", client_id: "c-2", user_id: "u-other" },
    ],
    ...extra,
  });
}

test("delete: email-matched owner deleted, all client_users rows of the client removed, client deleted", async () => {
  const db = deleteFixture();
  const res = await call(db, { action: "delete", client_id: "c-1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(writes(db), ["delete:client_users", "delete:users", "delete:clients"]);
  assert.deepEqual(db.tables.clients.map((c) => c.id), ["c-2"]);
  assert.deepEqual(db.tables.client_users.map((m) => m.id), ["m-3"]);
  // Existing semantics: ONLY the email-matched user is deleted; the agent's
  // users row is kept (not expanded to other members).
  assert.deepEqual(db.tables.users.map((u) => u.id).sort(), ["u-admin", "u-agent", "u-other"]);
});

test("delete: no user with the client's email -> memberships and users untouched, client deleted", async () => {
  const db = deleteFixture({ users: [{ id: "u-agent", email: "agent@acme.com", role: "client" }] });
  const res = await call(db, { action: "delete", client_id: "c-1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(writes(db), ["delete:clients"]);
  assert.equal(db.tables.client_users.length, 3);
});

test("delete: users lookup error is ignored (as before) -> memberships kept, client still deleted", async () => {
  const db = deleteFixture({ fail: { "users:select:email": { code: "XX000" } } });
  const res = await call(db, { action: "delete", client_id: "c-1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(writes(db), ["delete:clients"]);
  assert.equal(db.tables.client_users.length, 3);
});

test("delete: client_users / users delete errors are ignored (as before)", async () => {
  const db = deleteFixture({ fail: { "client_users:delete": { code: "XX000" }, "users:delete": { code: "XX000" } } });
  const res = await call(db, { action: "delete", client_id: "c-1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(writes(db), ["delete:client_users", "delete:users", "delete:clients"]);
});

test("delete: clients delete error -> 500 delete_failed", async () => {
  const db = deleteFixture({ fail: { "clients:delete": { code: "23503" } } });
  const res = await call(db, { action: "delete", client_id: "c-1" });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, code: ADMIN_CLIENTS_ERROR.DELETE_FAILED });
});

test("delete: unknown client id -> no user lookup, clients delete matches nothing, success (as before)", async () => {
  const db = deleteFixture();
  const res = await call(db, { action: "delete", client_id: "c-missing" });
  assert.equal(res.statusCode, 200);
  assert.equal(db.ops.some((o) => o.table === "users" && o.filters.email), false);
  assert.equal(db.tables.users.length, 4);
});

test("delete: the target email comes from the clients row, never from the request", async () => {
  const db = deleteFixture();
  await call(db, { action: "delete", client_id: "c-2", email: "owner@acme.com" });
  assert.ok(db.tables.users.some((u) => u.id === "u-owner"));
  assert.equal(db.tables.users.some((u) => u.id === "u-other"), false);
});

test("delete: missing client_id -> 400, nothing deleted", async () => {
  const db = deleteFixture();
  const res = await call(db, { action: "delete" });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(writes(db), []);
});

// ---- authorization / fail closed --------------------------------------

test("non-admin, unknown or missing actor -> 401, nothing touched (existing admin gate)", async () => {
  for (const actor of ["u-owner", "nobody", null, ""]) {
    const db = deleteFixture();
    const res = await call(db, { action: "delete", client_id: "c-1" }, { actor });
    assert.equal(res.statusCode, 401, String(actor));
    assert.deepEqual(writes(db), []);
  }
});

test("admin with must_change_password is refused (existing resolveActingAdmin rule)", async () => {
  const db = makeDb();
  db.tables.users[0] = { ...ADMIN, must_change_password: true };
  const res = await call(db, createBody());
  assert.equal(res.statusCode, 401);
});

test("missing service-role key -> 503 server_unavailable, nothing written", async () => {
  for (const env of [{}, { SUPABASE_ANON_KEY: "anon" }]) {
    const db = makeDb();
    const res = await call(db, createBody(), { env });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { success: false, code: ADMIN_CLIENTS_ERROR.SERVER_UNAVAILABLE });
    assert.deepEqual(writes(db), []);
  }
});

test("unknown action -> 400", async () => {
  const res = await call(makeDb(), { action: "update" });
  assert.equal(res.statusCode, 400);
});

// ---- logging -----------------------------------------------------------

test("no password, email or raw error is logged on failures", async () => {
  const logged = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  console.error = console.log = console.warn = (...a) => logged.push(a.map(String).join(" "));
  try {
    await call(makeDb({ fail: { "client_users:insert": { code: "23505", message: "dup owner@acme.com" } } }), createBody({ plan_id: "p" }));
    await call(makeDb({ fail: { "users:insert": "throw" } }), createBody());
    await call(deleteFixture({ fail: { "clients:delete": { code: "23503", message: "fk owner@acme.com" } } }), { action: "delete", client_id: "c-1" });
    await call(makeDb(), createBody(), { env: {} });
  } finally {
    Object.assign(console, orig);
  }
  const all = logged.join("\n");
  for (const s of ["Initial#Pass1", "owner@acme.com", "Owner@Acme.COM", "network down", "test-service-role"]) assert.equal(all.includes(s), false, s);
});

// ---- existing admin endpoint compatibility -----------------------------

test("existing system-settings behavior unchanged: GET settings, POST settings, overview gate", async () => {
  const db = makeDb();
  db.tables.system_settings = [{ key: "human_reply_webhook_url", value: "https://n8n.example/webhook/x" }];
  db.from = ((orig) => (t) => {
    const q = orig(t);
    q.in = () => q;
    return q;
  })(db.from.bind(db));

  const get = mockRes();
  await systemSettingsHandler({ method: "GET", query: { actor_user_id: "u-admin" } }, get, { supabase: db });
  assert.equal(get.statusCode, 200);
  assert.equal(get.body.success, true);
  assert.ok("settings" in get.body);

  // POST without resource still goes to the settings writer (400: nothing valid)
  const post = mockRes();
  await systemSettingsHandler({ method: "POST", query: {}, body: { actor_user_id: "u-admin", action: "create" } }, post, { supabase: db });
  assert.equal(post.statusCode, 400);
  assert.equal(post.body.message, "No valid settings provided");
  assert.equal(db.tables.clients.length, 0);

  // GET ?resource=clients does not reach the clients handler
  const getClients = mockRes();
  await systemSettingsHandler({ method: "GET", query: { resource: "clients", actor_user_id: "u-admin" } }, getClients, { supabase: db });
  assert.equal(getClients.statusCode, 200);
  assert.ok("settings" in getClients.body);
});

test("clients branch sits after the admin 401 gate in system-settings.js", () => {
  const src = read("api/system-settings.js");
  const gate = src.indexOf("if (!admin)");
  const branch = src.indexOf('resource === "clients"');
  assert.ok(gate > -1 && branch > -1 && gate < branch);
});

// ---- browser no longer touches `users` from AdminClients ---------------

test("AdminClients.jsx performs no direct users / client_users / subscriptions operations", () => {
  const src = code(read("src/pages/admin/AdminClients.jsx"));
  assert.equal(/from\(\s*["']users["']\s*\)/.test(src), false);
  assert.equal(/from\(\s*["']client_users["']\s*\)/.test(src), false);
  assert.equal(/from\(\s*["']subscriptions["']\s*\)/.test(src), false);
  assert.equal(/\.insert\(|\.delete\(/.test(src), false);
  assert.match(src, /fetch\("\/api\/system-settings\?resource=clients"/);
  // UI messages preserved
  for (const msg of [
    "⚠️ هذا البريد الإلكتروني مستخدم مسبقًا في جدول المستخدمين",
    "⚠️ هذا البريد الإلكتروني مستخدم مسبقًا في جدول العملاء",
    "✅ تم إنشاء العميل والمستخدم والاشتراك بنجاح",
    "✅ تم إنشاء العميل والمستخدم بنجاح",
    "❌ فشل في إضافة العميل. يرجى المحاولة مرة أخرى.",
    "🗑️ تم حذف العميل",
    "❌ فشل في حذف العميل",
    "⚠️ يرجى إدخال الاسم التجاري والبريد الإلكتروني وكلمة المرور",
  ]) {
    assert.ok(src.includes(msg), msg);
  }
  // list loading and status toggle intentionally unchanged
  assert.match(src, /\.from\("clients"\)\s*\.update\(\{ is_active: !currentStatus \}\)/);
});

test("legacy pages are left untouched by C2.1", () => {
  for (const p of ["src/pages/Clients.jsx", "src/pages/ClientUsers.jsx", "src/pages/ManageUsers.jsx"]) assert.ok(fs.existsSync(path.join(ROOT, p)), p);
});

test("Vercel Function count stays within the 12-function Hobby cap (no new top-level api file)", () => {
  const fns = fs.readdirSync(path.join(ROOT, "api")).filter((n) => n.endsWith(".js"));
  assert.ok(fns.length <= 12, fns.join(", "));
  assert.equal(fns.includes("admin-clients.js"), false);
  assert.ok(fs.existsSync(path.join(ROOT, "api/_lib/adminClients.js")));
});
