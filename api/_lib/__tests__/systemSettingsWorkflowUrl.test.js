import test from "node:test";
import assert from "node:assert/strict";

import systemSettingsHandler from "../../system-settings.js";

// /api/system-settings: core workflow IDs are derived from their Workflow
// URLs server-side too, so URL and ID can never be stored inconsistently.
// Storage keys, admin-only auth and the empty-never-clears rule unchanged.

const HOST = "https://n8n-production-fcd4.up.railway.app";

function makeDb(rows) {
  const tables = { users: [{ id: "u-admin", role: "admin", must_change_password: false }, { id: "u-client", role: "client" }], system_settings: rows };
  return {
    tables,
    from(table) {
      const filters = [];
      let op = "select";
      let payload = null;
      const all = () => (tables[table] = tables[table] || []);
      const match = (r) => filters.every(({ k, col, val }) => (k === "eq" ? r[col] === val : val.includes(r[col])));
      const run = () => {
        if (op === "insert") { all().push(...payload); return payload; }
        const hit = all().filter(match);
        if (op === "update") hit.forEach((r) => Object.assign(r, payload));
        return hit;
      };
      const q = {
        select() { return q; },
        eq(col, val) { filters.push({ k: "eq", col, val }); return q; },
        in(col, val) { filters.push({ k: "in", col, val }); return q; },
        insert(r) { op = "insert"; payload = Array.isArray(r) ? r : [r]; return q; },
        update(p) { op = "update"; payload = p; return q; },
        async maybeSingle() { return { data: run()[0] || null, error: null }; },
        then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}
const res = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const val = (db, key) => db.tables.system_settings.find((r) => r.key === key)?.value;
const post = async (db, body) => {
  const r = res();
  await systemSettingsHandler({ method: "POST", query: {}, body: { actor_user_id: "u-admin", ...body } }, r, { supabase: db });
  return r;
};

test("saving a Workflow URL stores the canonical URL AND the extracted ID", async () => {
  const db = makeDb([{ key: "ai_agent_core_workflow_id", value: "OldId1234567890A" }]);
  const r = await post(db, { ai_agent_core_workflow_url: `${HOST}/workflow/MhWmT2jdYQeqMBEj/executions?x=1` });
  assert.equal(r.statusCode, 200);
  assert.equal(val(db, "ai_agent_core_workflow_url"), `${HOST}/workflow/MhWmT2jdYQeqMBEj`);
  assert.equal(val(db, "ai_agent_core_workflow_id"), "MhWmT2jdYQeqMBEj");
  assert.equal(r.body.settings.ai_agent_core_workflow_id, "MhWmT2jdYQeqMBEj");
});

test("URL + matching ID is accepted; mismatching ID is rejected and nothing persisted", async () => {
  let db = makeDb([]);
  let r = await post(db, { inbound_media_core_workflow_url: `${HOST}/workflow/EAWx4flzCX0b7RJ6`, inbound_media_core_workflow_id: "EAWx4flzCX0b7RJ6" });
  assert.equal(r.statusCode, 200);
  db = makeDb([{ key: "human_reply_webhook_url", value: "https://old" }]);
  r = await post(db, { human_reply_webhook_url: "https://new", inbound_media_core_workflow_url: `${HOST}/workflow/EAWx4flzCX0b7RJ6`, inbound_media_core_workflow_id: "DifferentId12345" });
  assert.equal(r.statusCode, 400);
  assert.equal(val(db, "human_reply_webhook_url"), "https://old");
  assert.equal(val(db, "inbound_media_core_workflow_id"), undefined);
});

test("an ID cannot be set on its own (it is derived from the URL)", async () => {
  const db = makeDb([{ key: "ai_agent_core_workflow_id", value: "MhWmT2jdYQeqMBEj" }]);
  const r = await post(db, { ai_agent_core_workflow_id: "Manual1234567890" });
  assert.equal(r.statusCode, 400);
  assert.equal(val(db, "ai_agent_core_workflow_id"), "MhWmT2jdYQeqMBEj");
});

test("a URL without an extractable ID is rejected before anything is persisted", async () => {
  const db = makeDb([{ key: "ai_agent_core_workflow_id", value: "MhWmT2jdYQeqMBEj" }]);
  for (const bad of [`${HOST}/webhook/abc`, "http://n8n.example.com/workflow/MhWmT2jdYQeqMBEj", `${HOST}/workflow/x`]) {
    const r = await post(db, { ai_agent_core_workflow_url: bad, human_reply_webhook_url: "https://changed" });
    assert.equal(r.statusCode, 400, bad);
  }
  assert.equal(val(db, "ai_agent_core_workflow_id"), "MhWmT2jdYQeqMBEj");
  assert.equal(val(db, "human_reply_webhook_url"), undefined);
});

test("webhook keys and empty values behave as before; non-admin refused", async () => {
  const db = makeDb([{ key: "human_reply_webhook_url", value: "https://h" }]);
  let r = await post(db, { human_reply_webhook_url: "", evolution_api_gateway_workflow_url: "https://evo" });
  assert.equal(r.statusCode, 200);
  assert.equal(val(db, "human_reply_webhook_url"), "https://h");
  assert.equal(val(db, "evolution_api_gateway_workflow_url"), "https://evo");
  r = res();
  await systemSettingsHandler({ method: "POST", query: {}, body: { actor_user_id: "u-client", ai_agent_core_workflow_url: `${HOST}/workflow/MhWmT2jdYQeqMBEj` } }, r, { supabase: db });
  assert.equal(r.statusCode, 401);
});

test("GET returns all 7 keys plus the Vercel environment label (display only)", async () => {
  const prev = process.env.VERCEL_ENV;
  try {
    for (const [envValue, label] of [["preview", "DEV"], ["production", "PROD"], [undefined, null]]) {
      if (envValue === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = envValue;
      const r = res();
      await systemSettingsHandler({ method: "GET", query: { actor_user_id: "u-admin" } }, r, { supabase: makeDb([]) });
      assert.equal(r.statusCode, 200);
      assert.equal(Object.keys(r.body.settings).length, 7);
      assert.equal(r.body.environment, label);
      assert.equal("app_api_base_url" in r.body.settings, false);
    }
  } finally {
    if (prev === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prev;
  }
});
