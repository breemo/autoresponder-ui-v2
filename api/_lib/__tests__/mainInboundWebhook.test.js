import test from "node:test";
import assert from "node:assert/strict";

import { normalizeInboundWebhookBase, getMainInboundWebhookBase, MAIN_INBOUND_WEBHOOK_KEY } from "../inboundWebhookBase.js";
import systemSettingsHandler from "../../system-settings.js";
import clientIntegrationsHandler from "../../client-integrations.js";
import { handleClientFeatureSettings } from "../clientFeatureSettings.js";

// Main Inbound Flow — Webhook URL (system_settings.main_inbound_webhook_url):
// validated on save (admin-only), served to the Integrations UI through the
// existing authorized endpoints, fail-closed when missing/invalid.

const DEV = "https://n8n-production-fcd4.up.railway.app/webhook/ca335c86-de34-4bbb-ac74-57d89095f9bc/dev/inbound";
const PROD = "https://n8n-production-fcd4.up.railway.app/webhook/751ecf29-1acd-43b7-8c80-bd8f9929f656/inbound";

// ---- normalization ------------------------------------------------------

test("normalizeInboundWebhookBase accepts the DEV/PROD shapes and strips trailing slashes", () => {
  assert.equal(normalizeInboundWebhookBase(DEV), DEV);
  assert.equal(normalizeInboundWebhookBase(PROD), PROD);
  assert.equal(normalizeInboundWebhookBase(`  ${DEV}/  `), DEV);
  assert.equal(normalizeInboundWebhookBase(`${PROD}//`), PROD);
  // hosting stays portable: any https host
  assert.equal(normalizeInboundWebhookBase("https://hooks.example.org/webhook/abc/inbound"), "https://hooks.example.org/webhook/abc/inbound");
});

test("normalizeInboundWebhookBase rejects anything else (fail closed -> null)", () => {
  for (const bad of [
    "",
    "   ",
    null,
    undefined,
    42,
    "not a url",
    PROD.replace("https:", "http:"),
    `${PROD}?x=1`,
    `${PROD}#frag`,
    `${PROD}/?`,
    "https://n8n.example.com/inbound", // no /webhook/
    "https://n8n.example.com/webhook/abc/inbound/telegram", // must END with /inbound
    "https://n8n.example.com/webhook/abc", // no /inbound
    "https://user:pass@n8n.example.com/webhook/abc/inbound",
    "https://n8n.example.com/webhook/a b/inbound",
  ]) {
    assert.equal(normalizeInboundWebhookBase(bad), null, String(bad));
  }
});

// ---- tiny Supabase fake ---------------------------------------------------

function makeDb(tables) {
  return {
    tables,
    from(table) {
      const filters = [];
      let op = "select";
      let payload = null;
      const rows = () => (tables[table] = tables[table] || []);
      const match = (r) =>
        filters.every(({ k, col, val }) => (k === "eq" ? r[col] === val : k === "in" ? val.includes(r[col]) : true));
      const run = () => {
        if (op === "insert") {
          rows().push(...payload);
          return payload;
        }
        const hit = rows().filter(match);
        if (op === "update") hit.forEach((r) => Object.assign(r, payload));
        return hit;
      };
      const q = {
        select() { return q; },
        eq(col, val) { filters.push({ k: "eq", col, val }); return q; },
        in(col, val) { filters.push({ k: "in", col, val }); return q; },
        order() { return q; },
        limit() { return q; },
        insert(r) { op = "insert"; payload = Array.isArray(r) ? r : [r]; return q; },
        update(p) { op = "update"; payload = p; return q; },
        async maybeSingle() { return { data: run()[0] || null, error: null }; },
        async single() { const r = run(); return { data: r[0] || null, error: r.length === 1 ? null : { message: "x" } }; },
        then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

function seed({ base } = {}) {
  return {
    users: [
      { id: "u-admin", role: "admin", must_change_password: false },
      { id: "u-owner", role: "client", must_change_password: false },
      { id: "u-agent", role: "client", must_change_password: false },
    ],
    client_users: [
      { id: "m1", user_id: "u-owner", client_id: "c1", role: "owner", is_active: true, permissions_overrides: null },
      { id: "m2", user_id: "u-agent", client_id: "c1", role: "agent", is_active: true, permissions_overrides: null },
    ],
    clients: [{ id: "c1", plan_id: "p1" }],
    plans: [{ id: "p1", allow_self_edit: true }],
    features: [{ id: "f-tg", slug: "telegram" }],
    plan_features: [{ plan_id: "p1", feature_id: "f-tg" }],
    client_feature_integrations: [
      { id: "i-tg", client_id: "c1", feature_id: "f-tg", is_active: true, created_at: "2026-01-01", config: { channelKey: "k1", "Bot Token": "T" } },
    ],
    system_settings: [
      { key: "human_reply_webhook_url", value: "https://n8n.example.com/webhook/human-reply" },
      { key: "ai_agent_core_workflow_id", value: "WF123" },
      ...(base === undefined ? [] : [{ key: MAIN_INBOUND_WEBHOOK_KEY, value: base }]),
    ],
  };
}

function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

// ---- reader ---------------------------------------------------------------

test("getMainInboundWebhookBase reads this environment's row; null when missing/invalid", async () => {
  assert.equal(await getMainInboundWebhookBase(makeDb(seed({ base: `${DEV}/` }))), DEV);
  assert.equal(await getMainInboundWebhookBase(makeDb(seed())), null);
  assert.equal(await getMainInboundWebhookBase(makeDb(seed({ base: "http://bad/webhook/x/inbound" }))), null);
  const throwing = { from() { throw new Error("db down"); } };
  assert.equal(await getMainInboundWebhookBase(throwing), null);
});

// ---- admin settings endpoint ---------------------------------------------

test("system-settings: main_inbound_webhook_url is allowlisted (GET returns it, '' when missing)", async () => {
  let res = mockRes();
  await systemSettingsHandler({ method: "GET", query: { actor_user_id: "u-admin" } }, res, { supabase: makeDb(seed({ base: DEV })) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.main_inbound_webhook_url, DEV);
  res = mockRes();
  await systemSettingsHandler({ method: "GET", query: { actor_user_id: "u-admin" } }, res, { supabase: makeDb(seed()) });
  assert.equal(res.body.settings.main_inbound_webhook_url, "");
});

test("system-settings: a valid value is normalized and persisted (insert on first save)", async () => {
  const db = makeDb(seed());
  const res = mockRes();
  await systemSettingsHandler({ method: "POST", query: {}, body: { actor_user_id: "u-admin", main_inbound_webhook_url: ` ${DEV}/ ` } }, res, { supabase: db });
  assert.equal(res.statusCode, 200);
  assert.equal(db.tables.system_settings.find((r) => r.key === MAIN_INBOUND_WEBHOOK_KEY).value, DEV);
  assert.equal(res.body.settings.main_inbound_webhook_url, DEV);
});

test("system-settings: an invalid value -> 400 and NOTHING is persisted (also not other keys in the same request)", async () => {
  const db = makeDb(seed({ base: PROD }));
  const res = mockRes();
  await systemSettingsHandler(
    { method: "POST", query: {}, body: { actor_user_id: "u-admin", human_reply_webhook_url: "https://n8n.example.com/webhook/new", main_inbound_webhook_url: `${PROD}?debug=1` } },
    res,
    { supabase: db }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(db.tables.system_settings.find((r) => r.key === MAIN_INBOUND_WEBHOOK_KEY).value, PROD);
  assert.equal(db.tables.system_settings.find((r) => r.key === "human_reply_webhook_url").value, "https://n8n.example.com/webhook/human-reply");
});

test("system-settings: an empty value never clears the stored one; non-admin is refused", async () => {
  const db = makeDb(seed({ base: PROD }));
  let res = mockRes();
  await systemSettingsHandler({ method: "POST", query: {}, body: { actor_user_id: "u-admin", human_reply_webhook_url: "https://n8n.example.com/webhook/h", main_inbound_webhook_url: "  " } }, res, { supabase: db });
  assert.equal(res.statusCode, 200);
  assert.equal(db.tables.system_settings.find((r) => r.key === MAIN_INBOUND_WEBHOOK_KEY).value, PROD);
  for (const actor of ["u-owner", "nobody", undefined]) {
    res = mockRes();
    await systemSettingsHandler({ method: "POST", query: {}, body: { actor_user_id: actor, main_inbound_webhook_url: DEV } }, res, { supabase: db });
    assert.equal(res.statusCode, 401, String(actor));
  }
  assert.equal(db.tables.system_settings.find((r) => r.key === MAIN_INBOUND_WEBHOOK_KEY).value, PROD);
});

// ---- served to the Integrations UI ---------------------------------------

test("client-integrations list returns inbound_webhook_base (and no other system_settings value)", async () => {
  const res = mockRes();
  await clientIntegrationsHandler({ method: "POST", query: {}, body: { action: "list", actor_user_id: "u-owner" } }, res, { supabase: makeDb(seed({ base: DEV })) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.inbound_webhook_base, DEV);
  const text = JSON.stringify(res.body);
  assert.equal(text.includes("human-reply"), false);
  assert.equal(text.includes("WF123"), false);
});

test("client-integrations list: inbound_webhook_base is null when missing/invalid; INTEGRATIONS still required", async () => {
  let res = mockRes();
  await clientIntegrationsHandler({ method: "POST", query: {}, body: { action: "list", actor_user_id: "u-owner" } }, res, { supabase: makeDb(seed()) });
  assert.equal(res.body.inbound_webhook_base, null);
  res = mockRes();
  await clientIntegrationsHandler({ method: "POST", query: {}, body: { action: "list", actor_user_id: "u-owner" } }, res, { supabase: makeDb(seed({ base: "https://x.example.com/webhook/a/outbound" })) });
  assert.equal(res.body.inbound_webhook_base, null);
  res = mockRes();
  await clientIntegrationsHandler({ method: "POST", query: {}, body: { action: "list", actor_user_id: "u-agent" } }, res, { supabase: makeDb(seed({ base: DEV })) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.inbound_webhook_base, undefined);
});

test("feature_settings GET returns inbound_webhook_base for admins; client actors are refused", async () => {
  let res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-admin", client_id: "c1" } }, res, { supabase: makeDb(seed({ base: PROD })) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.inbound_webhook_base, PROD);
  res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-admin", client_id: "c1" } }, res, { supabase: makeDb(seed()) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.inbound_webhook_base, null);
  res = mockRes();
  await handleClientFeatureSettings({ method: "GET", query: { actor_user_id: "u-owner" } }, res, { supabase: makeDb(seed({ base: PROD })) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.inbound_webhook_base, undefined);
});
