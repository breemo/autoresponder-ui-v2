import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleWebsiteChatSettings } from "../websiteChatAccounts.js";
import { createWebsiteChatRepo } from "../websiteChatRepo.js";

// Website Chat business rule:
//  1. availability is controlled by the client's plan (plan_features row for
//     the website_chat feature); creation is refused server-side otherwise —
//     no plan / no row is NEVER "unlimited";
//  2. sites per client = plan_features.max_connections, enforced atomically by
//     the existing RPC create_website_chat_integration (currently 1).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FEATURE_ID = "feat-wc";

function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

// Repo double: plan membership + the RPC's limit semantics.
function repoDouble({ inPlan = true, planLimit = 1 } = {}) {
  const rows = [];
  let rpcCalls = 0;
  return {
    rows,
    get rpcCalls() { return rpcCalls; },
    async getWebsiteChatFeatureId() { return FEATURE_ID; },
    async isFeatureInClientPlan() { return inPlan; },
    async listSiteIntegrations(clientId) { return rows.filter((r) => r.client_id === clientId); },
    async createIntegration({ clientId, featureId, config, isActive }) {
      rpcCalls += 1;
      const count = rows.filter((r) => r.client_id === clientId && r.feature_id === featureId).length;
      if (planLimit != null && count >= planLimit) return { outcome: "limit_reached", plan_limit: planLimit };
      const row = { id: `int-${rows.length + 1}`, client_id: clientId, feature_id: featureId, is_active: isActive, config, created_at: "2026-10-06T00:00:00Z" };
      rows.push(row);
      return { outcome: "created", plan_limit: planLimit, integration: row };
    },
  };
}

const owner = { user: { id: "u1", must_change_password: false }, membership: { client_id: "client-A", role: "owner", is_active: true } };
async function create(repo, name = "Shop", domain = "shop.com") {
  const r = res();
  await handleWebsiteChatSettings(
    { method: "POST", body: { actor_user_id: "u1", action: "create", display_name: name, allowed_domains: [domain] }, query: {} },
    r,
    { repo, resolveActor: async () => owner }
  );
  return r;
}

test("plan includes Website Chat (limit 1): first site created, second rejected server-side", async () => {
  const repo = repoDouble({ inPlan: true, planLimit: 1 });
  const first = await create(repo);
  assert.equal(first.statusCode, 200);
  assert.ok(first.body.site.public_key);
  const second = await create(repo, "Blog", "blog.io");
  assert.equal(second.statusCode, 409);
  assert.match(second.body.message, /\(1\)/);
  assert.equal(repo.rows.length, 1);
});

test("plan does NOT include Website Chat: direct API create -> 403 not_in_plan, RPC never called", async () => {
  const repo = repoDouble({ inPlan: false, planLimit: null });
  const r = await create(repo);
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.code, "not_in_plan");
  assert.equal(repo.rpcCalls, 0);
  assert.equal(repo.rows.length, 0);
});

// ---- repo: plan membership query -------------------------------------------

function fakeSupabase(tables) {
  return {
    from(table) {
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push([col, val]); return q; },
        async maybeSingle() {
          const row = (tables[table] || []).find((r) => filters.every(([c, v]) => r[c] === v));
          return { data: row || null, error: null };
        },
      };
      return q;
    },
  };
}

test("isFeatureInClientPlan: true only with a plan_features row for the client's plan", async () => {
  const tables = {
    clients: [{ id: "c-in", plan_id: "p-pro" }, { id: "c-out", plan_id: "p-free" }, { id: "c-none", plan_id: null }],
    plan_features: [{ plan_id: "p-pro", feature_id: FEATURE_ID }, { plan_id: "p-free", feature_id: "feat-telegram" }],
  };
  const repo = createWebsiteChatRepo(fakeSupabase(tables));
  assert.equal(await repo.isFeatureInClientPlan("c-in", FEATURE_ID), true);
  assert.equal(await repo.isFeatureInClientPlan("c-out", FEATURE_ID), false); // plan without website_chat
  assert.equal(await repo.isFeatureInClientPlan("c-none", FEATURE_ID), false); // no plan -> not available
  assert.equal(await repo.isFeatureInClientPlan("missing", FEATURE_ID), false);
});

// ---- architecture preserved + UI ---------------------------------------------

test("existing RPC limit/locking/counting design is unchanged; the gate runs before it", () => {
  const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260930_website_chat_foundation.sql"), "utf8");
  assert.ok(sql.includes("perform pg_advisory_xact_lock(hashtextextended('website_chat_create|' || p_client_id::text, 0));"));
  assert.ok(sql.includes("if v_limit is not null and v_count >= v_limit then"));
  const accounts = fs.readFileSync(path.join(ROOT, "api/_lib/websiteChatAccounts.js"), "utf8");
  const gate = accounts.indexOf("isFeatureInClientPlan(clientId, featureId)");
  const rpc = accounts.indexOf("deps.repo.createIntegration(");
  assert.ok(gate > -1 && rpc > gate, "plan gate precedes the create RPC");
});

test("UI shows n / max and disables Add website at the limit (1 / 1 after the first site)", () => {
  const ui = fs.readFileSync(path.join(ROOT, "src/pages/client/WebsiteChatSection.jsx"), "utf8");
  assert.ok(ui.includes("const limitReached = hasLimit && sites.length >= maxConnections;"));
  assert.ok(ui.includes("hasLimit ? `${sites.length} / ${maxConnections}`"));
  assert.ok(ui.includes("disabled={!!addDisabledReason}"));
  const ci = fs.readFileSync(path.join(ROOT, "src/pages/client/ClientIntegrations.jsx"), "utf8");
  assert.ok(ci.includes("maxConnections={selectedFeature.max_connections}"));
});
