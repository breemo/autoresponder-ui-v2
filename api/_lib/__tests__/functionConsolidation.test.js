import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import clientRouterHandler from "../../client-router.js";
import clientIntegrationsHandler, { resolveIntegrationsResource } from "../../client-integrations.js";

// Vercel Hobby Function-count consolidation (Website Chat Phase 1):
//   api/change-password.js  -> api/client-router.js?resource=password  (api/_lib/changePassword.js)
//   api/client-facebook.js  -> api/client-integrations.js?resource=facebook (api/_lib/clientFacebook.js)
// Network-free: every assertion below resolves before any Supabase query
// (validation / method checks, or the "Server is not configured" guard
// with the Supabase env vars removed for the duration of the test).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function withoutSupabaseEnv(fn) {
  const keys = ["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
}

// ---- password -------------------------------------------------------

test("password: non-POST is rejected with 405 (unchanged)", async () => {
  const res = mockRes();
  await clientRouterHandler({ method: "GET", query: { resource: "password" } }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { success: false, message: "Method not allowed" });
});

test("password: missing fields -> 400 (unchanged validation, before any DB access)", async () => {
  const res = mockRes();
  await clientRouterHandler({ method: "POST", query: { resource: "password" }, body: { user_id: "u1", current_password: "x" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "جميع الحقول مطلوبة");
});

test("password: mismatched confirmation -> 400 (unchanged)", async () => {
  const res = mockRes();
  await clientRouterHandler(
    { method: "POST", query: { resource: "password" }, body: { user_id: "u1", current_password: "old", new_password: "abcdefgh", confirm_password: "abcdefgX" } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "كلمة المرور الجديدة وتأكيدها غير متطابقين");
});

test("password: too short -> 400 (unchanged 8-char minimum)", async () => {
  const res = mockRes();
  await clientRouterHandler(
    { method: "POST", query: { resource: "password" }, body: { user_id: "u1", current_password: "old", new_password: "short", confirm_password: "short" } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /8/);
});

test("client-router: unknown resource still 400 'Unknown resource'", async () => {
  const res = mockRes();
  await clientRouterHandler({ method: "POST", query: { resource: "nope" }, body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "Unknown resource");
});

// ---- facebook -------------------------------------------------------

test("resolveIntegrationsResource: only ?resource=facebook is routed; everything else keeps the existing handler", () => {
  assert.equal(resolveIntegrationsResource({ query: { resource: "facebook" } }), "facebook");
  assert.equal(resolveIntegrationsResource({ query: {} }), null);
  assert.equal(resolveIntegrationsResource({}), null);
  assert.equal(resolveIntegrationsResource({ query: { resource: "instagram" } }), null);
});

test("facebook: GET ?resource=facebook reaches the Facebook handler (which supports GET list), not the POST-only default", async () => {
  await withoutSupabaseEnv(async () => {
    const res = mockRes();
    await clientIntegrationsHandler({ method: "GET", query: { resource: "facebook", actor_user_id: "u1" } }, res);
    // Facebook handler creates its Supabase client before the method switch
    // -> 500 here (no env). The default client-integrations path would
    // have answered 405 for GET.
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, "Server is not configured");
  });
});

test("default client-integrations behavior is unchanged without ?resource (GET -> 405)", async () => {
  const res = mockRes();
  await clientIntegrationsHandler({ method: "GET", query: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { success: false, message: "Method not allowed" });
});

test("facebook handler keeps its own authorization (INTEGRATIONS permission, must_change_password gate, actor_user_id only)", () => {
  const src = fs.readFileSync(path.join(ROOT, "api/_lib/clientFacebook.js"), "utf8");
  assert.match(src, /resolveActingMembership\(supabase, actorUserId\)/);
  assert.match(src, /actor\.user\.must_change_password/);
  assert.match(src, /actorHasPermission\(actor\.membership, PERMISSIONS\.INTEGRATIONS\)/);
  assert.match(src, /supabase\.rpc\("create_client_facebook_account"/);
  assert.match(src, /function toSafeAccount\(row\)/);
  assert.match(src, /export async function handleClientFacebook\(req, res\)/);
});

// ---- no stale callers / function count ------------------------------

function listFiles(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

test("no source code or n8n workflow calls the removed endpoints", () => {
  const files = [
    ...listFiles(path.join(ROOT, "src"), [".js", ".jsx"]),
    ...listFiles(path.join(ROOT, "api"), [".js"]).filter((f) => !f.includes("__tests__")),
    ...listFiles(path.join(ROOT, "engineering/n8n"), [".json"]),
    ...listFiles(path.join(ROOT, "docs/n8n"), [".json"]),
  ];
  const callPattern = /(fetch\(|url"?\s*:|["'`])\/api\/(change-password|client-facebook)\b/;
  const hits = files.filter((f) => callPattern.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

test("the removed top-level functions are gone and the deploy stays within the 12-function Hobby cap", () => {
  const fns = fs.readdirSync(path.join(ROOT, "api")).filter((n) => n.endsWith(".js"));
  assert.ok(!fns.includes("change-password.js"));
  assert.ok(!fns.includes("client-facebook.js"));
  assert.ok(fns.includes("widget.js"), "Website Chat api/widget.js uses the freed slot");
  assert.ok(fns.length <= 12, `expected <= 12 top-level functions (Vercel Hobby cap), got ${fns.length}: ${fns.join(", ")}`);
});
