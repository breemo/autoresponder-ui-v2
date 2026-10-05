import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import clientIntegrationsHandler, { listClientIntegrations, resolveIntegrationsResource } from "../../client-integrations.js";
import { handleClientFeatureSettings } from "../clientFeatureSettings.js";
import { listDashboardIntegrations } from "../dashboardSummary.js";
import { safeIntegrationConfig } from "../integrationSafeView.js";

// D4 Step C — browser dependency removal for public.client_feature_integrations.
// Network-free: an in-memory Supabase fake is injected everywhere.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const F = { telegram: "f-tg", instagram: "f-ig", website: "f-wc", facebook: "f-fb", other: "f-x" };

function seed() {
  return {
    users: [
      { id: "u-admin", role: "admin", must_change_password: false },
      { id: "u-owner", role: "client", must_change_password: false },
      { id: "u-agent", role: "client", must_change_password: false },
      { id: "u-owner2", role: "client", must_change_password: false },
    ],
    client_users: [
      { id: "m1", user_id: "u-owner", client_id: "c1", role: "owner", is_active: true, permissions_overrides: null },
      { id: "m2", user_id: "u-agent", client_id: "c1", role: "agent", is_active: true, permissions_overrides: null },
      { id: "m3", user_id: "u-owner2", client_id: "c2", role: "owner", is_active: true, permissions_overrides: null },
    ],
    clients: [
      { id: "c1", plan_id: "p-edit" },
      { id: "c2", plan_id: "p-locked" },
    ],
    plans: [
      { id: "p-edit", allow_self_edit: true },
      { id: "p-locked", allow_self_edit: false },
    ],
    plan_features: [
      { plan_id: "p-edit", feature_id: F.telegram },
      { plan_id: "p-edit", feature_id: F.instagram },
      { plan_id: "p-edit", feature_id: F.website },
      { plan_id: "p-edit", feature_id: F.facebook },
      { plan_id: "p-locked", feature_id: F.telegram },
    ],
    features: [
      { id: F.telegram, slug: "telegram", name: "Telegram" },
      { id: F.instagram, slug: "instagram", name: "Instagram" },
      { id: F.website, slug: "website_chat", name: "Website Chat" },
      { id: F.facebook, slug: "facebook", name: "Facebook" },
      { id: F.other, slug: "other", name: "Other" },
    ],
    client_feature_integrations: [
      { id: "i-tg", client_id: "c1", feature_id: F.telegram, is_active: true, created_at: "2026-01-01", config: { "Bot Token": "TG-SECRET", channelKey: "tg-ck", reply_mode: "ai" }, features: { slug: "telegram", name: "Telegram" } },
      { id: "i-ig", client_id: "c1", feature_id: F.instagram, is_active: true, created_at: "2026-01-02", config: { page_access_token: "IG-SECRET", "Page Access Token": "IG-SECRET-2", instagram_account_id: "1789", channelKey: "ig-ck" }, features: { slug: "instagram", name: "Instagram" } },
      { id: "i-wc", client_id: "c1", feature_id: F.website, is_active: true, created_at: "2026-01-03", config: { publicKey: "wcpk_x", channelKey: "WC-SERVER-ONLY", displayName: "Site" }, features: { slug: "website_chat", name: "Website Chat" } },
      { id: "i-c2", client_id: "c2", feature_id: F.telegram, is_active: false, created_at: "2026-01-04", config: { "Bot Token": "OTHER-TENANT" }, features: { slug: "telegram", name: "Telegram" } },
    ],
  };
}

// Minimal chained Supabase fake: select / eq / neq / in / order / limit /
// maybeSingle / single / insert / update, thenable. Select projection is
// ignored on purpose — callers must not depend on it for redaction.
function makeDb(tables = seed()) {
  let seq = 0;
  const db = {
    tables,
    from(table) {
      const filters = [];
      let op = "select";
      let payload = null;
      let limitN = null;
      const rowsOf = () => (tables[table] = tables[table] || []);
      const matches = (row) =>
        filters.every(({ kind, col, val }) => {
          const v = col.startsWith("config->>") ? row.config?.[col.slice(9)] : row[col];
          if (kind === "eq") return v === val;
          if (kind === "neq") return v !== val;
          if (kind === "in") return val.includes(v);
          return true;
        });
      const run = () => {
        if (op === "insert") {
          const inserted = payload.map((r) => ({ id: `new-${++seq}`, is_active: true, created_at: "2026-02-01", ...r }));
          rowsOf().push(...inserted);
          return inserted;
        }
        const hit = rowsOf().filter(matches);
        if (op === "update") {
          hit.forEach((r) => Object.assign(r, payload));
        }
        return limitN == null ? hit : hit.slice(0, limitN);
      };
      const q = {
        select() { return q; },
        eq(col, val) { filters.push({ kind: "eq", col, val }); return q; },
        neq(col, val) { filters.push({ kind: "neq", col, val }); return q; },
        in(col, val) { filters.push({ kind: "in", col, val }); return q; },
        order() { return q; },
        limit(n) { limitN = n; return q; },
        insert(rows) { op = "insert"; payload = Array.isArray(rows) ? rows : [rows]; return q; },
        update(patch) { op = "update"; payload = patch; return q; },
        async maybeSingle() { const r = run(); return { data: r[0] || null, error: null }; },
        async single() { const r = run(); return r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: "not single" } }; },
        then(resolve, reject) { return Promise.resolve({ data: run(), error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
  return db;
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const SECRETS = ["TG-SECRET-NOT-USED", "IG-SECRET", "IG-SECRET-2", "WC-SERVER-ONLY", "OTHER-TENANT"];
const assertNoSecrets = (value, secrets = SECRETS) => {
  const text = JSON.stringify(value);
  for (const s of secrets) assert.equal(text.includes(s), false, `leaked ${s}`);
};

// ---- safe projection --------------------------------------------------

test("safeIntegrationConfig: Instagram token keys stripped, flag set", () => {
  const out = safeIntegrationConfig("instagram", { page_access_token: "x", "Page Access Token": "y", instagram_account_id: "1" });
  assert.deepEqual(out.config, { instagram_account_id: "1" });
  assert.equal(out.config_flags.has_page_access_token, true);
});

test("safeIntegrationConfig: Website Chat channelKey stripped", () => {
  const out = safeIntegrationConfig("website_chat", { publicKey: "wcpk_x", channelKey: "secret" });
  assert.deepEqual(out.config, { publicKey: "wcpk_x" });
});

// ---- list (client Integrations page) ----------------------------------

test("listClientIntegrations: tenant-scoped, slug attached, Instagram/Website Chat secrets never returned", async () => {
  const rows = await listClientIntegrations(makeDb(), "c1");
  assert.deepEqual(rows.map((r) => r.id).sort(), ["i-ig", "i-tg", "i-wc"]);
  assertNoSecrets(rows);
  const ig = rows.find((r) => r.id === "i-ig");
  assert.equal(ig.slug, "instagram");
  assert.equal(ig.config_flags.has_page_access_token, true);
  assert.equal(ig.config.instagram_account_id, "1789");
  // Legacy editor channel: unchanged config for the tenant's own actor.
  assert.equal(rows.find((r) => r.id === "i-tg").config.channelKey, "tg-ck");
});

test("list action: owner gets own rows; secrets redacted; no feature_id required", async () => {
  const res = mockRes();
  await clientIntegrationsHandler({ method: "POST", query: {}, body: { action: "list", actor_user_id: "u-owner" } }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.integrations.length, 3);
  assertNoSecrets(res.body);
});

test("list action: actor without INTEGRATIONS permission -> 403", async () => {
  const res = mockRes();
  await clientIntegrationsHandler({ method: "POST", query: {}, body: { action: "list", actor_user_id: "u-agent" } }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 403);
});

test("list action: unknown actor -> 401; admin (no membership) -> 401", async () => {
  for (const actor of ["nobody", "u-admin", undefined]) {
    const res = mockRes();
    await clientIntegrationsHandler({ method: "POST", query: {}, body: { action: "list", actor_user_id: actor } }, res, { supabase: makeDb() });
    assert.equal(res.statusCode, 401);
  }
});

test("list action: request body client_id is ignored (tenant from membership)", async () => {
  const res = mockRes();
  await clientIntegrationsHandler(
    { method: "POST", query: {}, body: { action: "list", actor_user_id: "u-owner", client_id: "c2" } },
    res,
    { supabase: makeDb() }
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.integrations.every((r) => r.client_id === "c1"));
});

test("save_instagram_config: never echoes the stored token", async () => {
  const db = makeDb();
  const res = mockRes();
  await clientIntegrationsHandler(
    { method: "POST", query: {}, body: { action: "save_instagram_config", actor_user_id: "u-owner", feature_id: F.instagram, instagram_account_id: "1789", reply_mode: "" } },
    res,
    { supabase: db }
  );
  assert.equal(res.statusCode, 200);
  assertNoSecrets(res.body);
  assert.equal(res.body.config_flags.has_page_access_token, true);
});

test("save_instagram_config: refused for a non-Instagram feature", async () => {
  const res = mockRes();
  await clientIntegrationsHandler(
    { method: "POST", query: {}, body: { action: "save_instagram_config", actor_user_id: "u-owner", feature_id: F.telegram } },
    res,
    { supabase: makeDb() }
  );
  assert.equal(res.statusCode, 400);
});

// ---- feature_settings (AdminClientSettings drawer) --------------------

test("resource routing: ?resource=feature_settings", () => {
  assert.equal(resolveIntegrationsResource({ query: { resource: "feature_settings" } }), "feature_settings");
});

test("feature_settings GET: admin reads any client (explicit client_id), redacted", async () => {
  const res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-admin", client_id: "c1" } }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.can_edit, true);
  assert.equal(res.body.integrations.length, 3);
  assertNoSecrets(res.body);
});

test("feature_settings GET: admin without client_id -> 400; unknown client -> 404", async () => {
  let res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-admin" } }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 400);
  res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-admin", client_id: "nope" } }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 404);
});

test("feature_settings GET: client reads only its own client (requested client_id ignored)", async () => {
  const res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-owner2", client_id: "c1" } }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.integrations.map((r) => r.client_id), ["c2"]);
  assert.equal(res.body.can_edit, false);
});

test("feature_settings: client without AI_SETTINGS -> 403; anonymous -> 401", async () => {
  let res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-agent" } }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 403);
  res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: {} }, res, { supabase: makeDb() });
  assert.equal(res.statusCode, 401);
});

test("feature_settings save: admin updates the existing row", async () => {
  const db = makeDb();
  const res = mockRes();
  await handleClientFeatureSettings(
    { method: "POST", query: {}, body: { action: "save", actor_user_id: "u-admin", client_id: "c1", feature_id: F.telegram, config: { "Bot Token": "NEW", reply_mode: "ai" } } },
    res,
    { supabase: db }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.integration.id, "i-tg");
  assert.deepEqual(db.tables.client_feature_integrations.find((r) => r.id === "i-tg").config, { "Bot Token": "NEW", reply_mode: "ai" });
});

test("feature_settings save: creates the row when missing (plan feature)", async () => {
  const db = makeDb();
  const res = mockRes();
  await handleClientFeatureSettings(
    { method: "POST", query: {}, body: { action: "save", actor_user_id: "u-owner", feature_id: F.facebook, config: { pageId: "1" } } },
    res,
    { supabase: db }
  );
  assert.equal(res.statusCode, 200);
  const created = db.tables.client_feature_integrations.filter((r) => r.client_id === "c1" && r.feature_id === F.facebook);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].config, { pageId: "1" });
});

test("feature_settings save: client on a plan without allow_self_edit -> 403", async () => {
  const db = makeDb();
  const res = mockRes();
  await handleClientFeatureSettings(
    { method: "POST", query: {}, body: { action: "save", actor_user_id: "u-owner2", feature_id: F.telegram, config: { "Bot Token": "x" } } },
    res,
    { supabase: db }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(db.tables.client_feature_integrations.find((r) => r.id === "i-c2").config["Bot Token"], "OTHER-TENANT");
});

test("feature_settings save: feature outside the client's plan -> 403", async () => {
  const res = mockRes();
  await handleClientFeatureSettings(
    { method: "POST", query: {}, body: { action: "save", actor_user_id: "u-owner", feature_id: F.other, config: {} } },
    res,
    { supabase: makeDb() }
  );
  assert.equal(res.statusCode, 403);
});

test("feature_settings save: Website Chat and Instagram refused (server-owned keys)", async () => {
  for (const featureId of [F.website, F.instagram]) {
    const db = makeDb();
    const res = mockRes();
    await handleClientFeatureSettings(
      { method: "POST", query: {}, body: { action: "save", actor_user_id: "u-admin", client_id: "c1", feature_id: featureId, config: {} } },
      res,
      { supabase: db }
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "managed_elsewhere");
  }
});

test("feature_settings save: non-object config -> 400", async () => {
  const res = mockRes();
  await handleClientFeatureSettings(
    { method: "POST", query: {}, body: { action: "save", actor_user_id: "u-admin", client_id: "c1", feature_id: F.telegram, config: "x" } },
    res,
    { supabase: makeDb() }
  );
  assert.equal(res.statusCode, 400);
});

// ---- dashboard ----------------------------------------------------------

test("listDashboardIntegrations: tenant-scoped, name/slug/active only, never config", async () => {
  const rows = await listDashboardIntegrations(makeDb(), "c1");
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.is_active).length, 3);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["features", "id", "is_active"]);
  assert.equal(JSON.stringify(rows).includes("config"), false);
  assert.equal(JSON.stringify(rows).includes("SECRET"), false);
});

// ---- browser source guard -----------------------------------------------

test("src/ and public/ contain zero code references to client_feature_integrations", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?|html)$/.test(name)) {
        const code = fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        if (code.includes("client_feature_integrations")) offenders.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  walk(path.join(ROOT, "public"));
  assert.deepEqual(offenders, []);
});
