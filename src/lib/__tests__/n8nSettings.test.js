import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SETTINGS_KEYS,
  WORKFLOW_PAIRS,
  computeSettingsChanges,
  environmentLabel,
  extractN8nWorkflowId,
  isWorkflowPairOutOfSync,
} from "../n8nSettings.js";

// n8n Runtime Control Panel — Workflow URL -> Workflow ID extraction and the
// form diff. Real n8n workflow IDs from the live exports:
//   DEV - AI-Agent-Core-V3            MhWmT2jdYQeqMBEj
//   DEV - AutoResponder_Final_V3      OoThEiTNLQMQl95R
//   AutoResponder_Final_V3 (PROD)     AVbA5vhEr8dLkQpP
// n8n references them as "/workflow/<id>" (Execute Sub-workflow cachedResultUrl).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST = "https://n8n-production-fcd4.up.railway.app";

test("the 7-key storage contract is unchanged", () => {
  assert.deepEqual([...SETTINGS_KEYS].sort(), [
    "ai_agent_core_workflow_id",
    "ai_agent_core_workflow_url",
    "evolution_api_gateway_workflow_url",
    "human_reply_webhook_url",
    "inbound_media_core_workflow_id",
    "inbound_media_core_workflow_url",
    "main_inbound_webhook_url",
  ]);
  assert.deepEqual(WORKFLOW_PAIRS, [
    { urlKey: "ai_agent_core_workflow_url", idKey: "ai_agent_core_workflow_id" },
    { urlKey: "inbound_media_core_workflow_url", idKey: "inbound_media_core_workflow_id" },
  ]);
});

test("n8n's own reference format (live DEV export: Execute Sub-workflow cachedResultUrl \"/workflow/MhWmT2jdYQeqMBEj\")", () => {
  const observed = "/workflow/MhWmT2jdYQeqMBEj"; // copied from the live DEV AutoResponder_Final_V3 export
  const r = extractN8nWorkflowId(`${HOST}${observed}`);
  assert.equal(r.ok, true);
  assert.equal(r.id, "MhWmT2jdYQeqMBEj");
});

test("extracts the ID from real n8n editor URLs and canonicalizes the URL", () => {
  for (const id of ["MhWmT2jdYQeqMBEj", "OoThEiTNLQMQl95R", "AVbA5vhEr8dLkQpP"]) {
    for (const suffix of ["", "/", "/executions", "/12345", "?projectId=abc", "#x", "/executions?x=1"]) {
      const r = extractN8nWorkflowId(`${HOST}/workflow/${id}${suffix}`);
      assert.equal(r.ok, true, suffix);
      assert.equal(r.id, id);
      assert.equal(r.url, `${HOST}/workflow/${id}`);
    }
  }
  // n8n served under a path prefix
  assert.equal(extractN8nWorkflowId("https://example.org/n8n/workflow/x2T6z94nazQWk2NY").url, "https://example.org/n8n/workflow/x2T6z94nazQWk2NY");
  assert.equal(extractN8nWorkflowId(`  ${HOST}/workflow/MhWmT2jdYQeqMBEj  `).id, "MhWmT2jdYQeqMBEj");
});

test("invalid workflow URLs are rejected with a reason (save must be blocked)", () => {
  const cases = {
    "": "empty",
    "   ": "empty",
    "not a url": "invalid_url",
    "http://n8n.example.com/workflow/MhWmT2jdYQeqMBEj": "https_required",
    "https://n8n.example.com/workflows": "no_workflow_path",
    "https://n8n.example.com/webhook/abc": "no_workflow_path",
    "https://n8n.example.com/workflow/": "no_workflow_path",
    "https://n8n.example.com/workflow/abc": "invalid_workflow_id",
    "https://n8n.example.com/workflow/Mh-Wm_T2jdYQeqMBEj": "invalid_workflow_id",
    "https://u:p@n8n.example.com/workflow/MhWmT2jdYQeqMBEj": "invalid_url",
  };
  for (const [input, error] of Object.entries(cases)) {
    const r = extractN8nWorkflowId(input);
    assert.equal(r.ok, false, input);
    assert.equal(r.error, error, input);
  }
  assert.equal(extractN8nWorkflowId(null).ok, false);
});

const SAVED = {
  main_inbound_webhook_url: `${HOST}/webhook/ca335c86-de34-4bbb-ac74-57d89095f9bc/dev/inbound`,
  human_reply_webhook_url: `${HOST}/webhook/human-reply-Media`,
  evolution_api_gateway_workflow_url: `${HOST}/webhook/evolution-api-gateway`,
  ai_agent_core_workflow_url: `${HOST}/workflow/MhWmT2jdYQeqMBEj`,
  ai_agent_core_workflow_id: "MhWmT2jdYQeqMBEj",
  inbound_media_core_workflow_url: "",
  inbound_media_core_workflow_id: "EAWx4flzCX0b7RJ6",
};

test("unchanged form -> no changes (Save stays disabled)", () => {
  assert.deepEqual(computeSettingsChanges(SAVED, {}), { changes: {}, errors: {} });
  // opening Edit without changing anything is still no change
  const drafts = { human_reply_webhook_url: SAVED.human_reply_webhook_url, ai_agent_core_workflow_url: `${SAVED.ai_agent_core_workflow_url}  ` };
  assert.deepEqual(computeSettingsChanges(SAVED, drafts), { changes: {}, errors: {} });
});

test("changing a Workflow URL always updates its Workflow ID in the same save", () => {
  const { changes, errors } = computeSettingsChanges(SAVED, { ai_agent_core_workflow_url: `${HOST}/workflow/AVbA5vhEr8dLkQpP/executions` });
  assert.deepEqual(errors, {});
  assert.deepEqual(changes, { ai_agent_core_workflow_url: `${HOST}/workflow/AVbA5vhEr8dLkQpP`, ai_agent_core_workflow_id: "AVbA5vhEr8dLkQpP" });
  // first-time URL for a pair that only had a legacy ID
  const media = computeSettingsChanges(SAVED, { inbound_media_core_workflow_url: `${HOST}/workflow/EAWx4flzCX0b7RJ6` });
  assert.deepEqual(media.changes, { inbound_media_core_workflow_url: `${HOST}/workflow/EAWx4flzCX0b7RJ6`, inbound_media_core_workflow_id: "EAWx4flzCX0b7RJ6" });
});

test("IDs are never taken from drafts (read-only, derived only)", () => {
  const { changes } = computeSettingsChanges(SAVED, { ai_agent_core_workflow_id: "SomethingElse1234" });
  assert.deepEqual(changes, {});
});

test("invalid / empty inputs produce errors and no changes", () => {
  let r = computeSettingsChanges(SAVED, { ai_agent_core_workflow_url: `${HOST}/webhook/x` });
  assert.deepEqual(r.changes, {});
  assert.equal(r.errors.ai_agent_core_workflow_url, "no_workflow_path");
  r = computeSettingsChanges(SAVED, { human_reply_webhook_url: "  " });
  assert.equal(r.errors.human_reply_webhook_url, "empty");
  r = computeSettingsChanges(SAVED, { main_inbound_webhook_url: `${HOST}/webhook/x/inbound?debug=1` });
  assert.equal(r.errors.main_inbound_webhook_url, "invalid_inbound_base");
  r = computeSettingsChanges(SAVED, { evolution_api_gateway_workflow_url: "nope" });
  assert.equal(r.errors.evolution_api_gateway_workflow_url, "invalid_url");
});

test("webhook URL changes: main inbound normalized; others passed through", () => {
  const r = computeSettingsChanges(SAVED, {
    main_inbound_webhook_url: `${HOST}/webhook/751ecf29-1acd-43b7-8c80-bd8f9929f656/inbound/`,
    evolution_api_gateway_workflow_url: `${HOST}/webhook/evo-2`,
  });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.changes, {
    main_inbound_webhook_url: `${HOST}/webhook/751ecf29-1acd-43b7-8c80-bd8f9929f656/inbound`,
    evolution_api_gateway_workflow_url: `${HOST}/webhook/evo-2`,
  });
});

test("out-of-sync stored URL/ID is detected", () => {
  assert.equal(isWorkflowPairOutOfSync(SAVED, WORKFLOW_PAIRS[0]), false);
  assert.equal(isWorkflowPairOutOfSync({ ...SAVED, ai_agent_core_workflow_id: "Other1234567890" }, WORKFLOW_PAIRS[0]), true);
  assert.equal(isWorkflowPairOutOfSync(SAVED, WORKFLOW_PAIRS[1]), false); // no URL yet
});

test("environment label comes from Vercel's environment only", () => {
  assert.equal(environmentLabel("production"), "PROD");
  assert.equal(environmentLabel("preview"), "DEV");
  assert.equal(environmentLabel("development"), "LOCAL");
  assert.equal(environmentLabel(undefined), null);
});

test("page: ID is read-only/auto-detected; only changed keys are posted; Save disabled until a change", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/pages/admin/AdminSystemSettings.jsx"), "utf8");
  assert.ok(src.includes("const EMPTY = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, \"\"]));"));
  assert.ok(src.includes("readOnly"));
  assert.ok(src.includes("Auto-detected"));
  assert.ok(src.includes("body: JSON.stringify({ actor_user_id: user?.id, ...changes }),"));
  assert.ok(src.includes("disabled={busy || !changeCount || hasErrors}"));
  // no input is ever bound to an *_workflow_id draft
  assert.equal(/drafts\[row\.idKey\]|\[row\.idKey\]: e\.target\.value/.test(src), false);
  // technical values render LTR
  assert.ok(src.includes('<bdi dir="ltr" className="block min-w-0 truncate font-mono'));
  assert.equal(src.includes("app_api_base_url"), false);
});
