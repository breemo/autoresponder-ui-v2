import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Cross-message closing_confirm lifecycle — the structured state set by
// /api/ai-tools (close tool) must survive to the customer's NEXT message.
//
// Root cause: the parent `sync_conversation_v2` node used to PATCH
// conversations.current_step = (state.current_step || null) at end-of-run,
// overwriting the "closing_confirm" that handleCloseConversation had
// written server-side. On the next inbound the resolver returned
// current_step = null, so closing_confirm_gate exited via
// `step !== "closing_confirm"` → decision "normal" → the AI turn re-ran
// and re-issued the confirm prompt forever.

const FINAL = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_Final.json", import.meta.url), "utf8"));
const WA = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_WhatsApp_V2.json", import.meta.url), "utf8"));
const VNEXT = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AI-Agent-Core-VNext.json", import.meta.url), "utf8"));

const node = (wf, name) => wf.nodes.find((n) => n.name === name);

// eval a `={{ (() => {...})() }}` expression body with mocked n8n scope
function evalSyncBody(wf, { state = {}, ccDecision = null, prepStep = null, now = "2026-09-09T00:00:00Z" }) {
  const raw = node(wf, "sync_conversation_v2").parameters.jsonBody;
  const expr = raw.replace(/^=\{\{\n?/, "").replace(/\n?\}\}$/, "");
  const $node = { state_payload: { json: state }, prepare_conversation: { json: { current_step: prepStep } } };
  const $items = (nm) => (nm === "closing_confirm_gate" ? [{ json: { decision: ccDecision } }] : []);
  const $now = now;
  // eslint-disable-next-line no-eval
  return eval("(" + expr + ")");
}

function runGate(wf, { text = "", quickPayload = null, prepStep = null }) {
  const code = node(wf, "closing_confirm_gate").parameters.jsCode;
  const $items = (nm) => {
    if (nm === "prepare_conversation") return [{ json: { current_step: prepStep, quick_reply_payload: quickPayload } }];
    if (nm === "Code in JavaScript1") return [{ json: { text, quick_reply_payload: quickPayload } }];
    return [];
  };
  return new Function("$items", code)($items)[0].json;
}

// --- Parity ---------------------------------------------------------

test("sync_conversation_v2 is byte-identical in Final and WhatsApp (both parents must behave identically)", () => {
  assert.equal(node(FINAL, "sync_conversation_v2").parameters.jsonBody, node(WA, "sync_conversation_v2").parameters.jsonBody);
  assert.equal(node(FINAL, "closing_confirm_gate").parameters.jsCode, node(WA, "closing_confirm_gate").parameters.jsCode);
});

// --- sync_conversation_v2: current_step persistence ----------------

for (const [label, wf] of [["Final", FINAL], ["WhatsApp", WA]]) {
  test(`${label}: TURN 1 close request persists conversations.current_step = "closing_confirm" (even if the step field did not propagate through normalization)`, () => {
    // VNext / legacy Core reliably set action = "close_needs_confirmation"
    // from the executed tool name; current_step from the observation may be
    // lost. The parent must still persist closing_confirm.
    const p1 = evalSyncBody(wf, { state: { action: "close_needs_confirmation", current_step: null, conversation_status: "active" }, ccDecision: "normal", prepStep: null });
    assert.equal(p1.current_step, "closing_confirm");
    assert.equal(p1.conversation_status, undefined); // a close REQUEST keeps the conversation active

    const p2 = evalSyncBody(wf, { state: { action: "close_needs_confirmation", current_step: "closing_confirm", conversation_status: "active" }, ccDecision: "normal", prepStep: null });
    assert.equal(p2.current_step, "closing_confirm");
  });

  test(`${label}: TURN 2 نعم/اه (gate → confirm) persists the confirmed close`, () => {
    const p = evalSyncBody(wf, { state: { action: "close_confirmed", current_step: "closing_confirmed", conversation_status: "waiting_human" }, ccDecision: "confirm", prepStep: "closing_confirm" });
    assert.equal(p.current_step, "closing_confirmed");
    assert.equal(p.conversation_status, "waiting_human");
  });

  test(`${label}: TURN 2 لا/كمل (gate → continue) clears closing_confirm, conversation stays active`, () => {
    const p = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active", action: null }, ccDecision: "continue", prepStep: "closing_confirm" });
    assert.equal(p.current_step, null);
    assert.equal(p.conversation_status, undefined);
  });

  test(`${label}: TURN 2 substantive message during a pending closing_confirm clears the step`, () => {
    const p = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active" }, ccDecision: "substantive", prepStep: "closing_confirm" });
    assert.equal(p.current_step, null);
  });

  test(`${label}: a normal turn with nothing pending keeps the legacy behaviour (writes current_step = null)`, () => {
    const p = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active" }, ccDecision: "normal", prepStep: null });
    assert.equal(p.current_step, null);
  });

  test(`${label}: a lead / handover surfaced this turn is still persisted`, () => {
    assert.equal(evalSyncBody(wf, { state: { current_step: "contact_captured", conversation_status: "active", action: "lead_saved" }, ccDecision: "normal", prepStep: null }).current_step, "contact_captured");
    const h = evalSyncBody(wf, { state: { current_step: null, conversation_status: "waiting_human", action: "human_handover" }, ccDecision: "normal", prepStep: null });
    assert.equal(h.conversation_status, "waiting_human");
  });

  test(`${label}: safety net — a pending closing_confirm the gate did not resolve is NOT dropped`, () => {
    const p = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active" }, ccDecision: null, prepStep: "closing_confirm" });
    assert.equal(p.current_step, "closing_confirm");
  });

  test(`${label}: still applies the conversation_status non-downgrade rule`, () => {
    assert.equal(evalSyncBody(wf, { state: { conversation_status: "closed" } }).conversation_status, "closed");
    assert.equal(evalSyncBody(wf, { state: { conversation_status: "waiting_human" } }).conversation_status, "waiting_human");
    assert.equal(evalSyncBody(wf, { state: { conversation_status: "active" } }).conversation_status, undefined);
  });

  // --- TURN 2 routing once current_step IS restored -----------------

  test(`${label}: with current_step="closing_confirm" restored, "نعم" → confirm, "لا" → continue, a real question → substantive`, () => {
    assert.equal(runGate(wf, { text: "نعم", prepStep: "closing_confirm" }).decision, "confirm");
    assert.equal(runGate(wf, { text: "اه", prepStep: "closing_confirm" }).decision, "confirm");
    assert.equal(runGate(wf, { text: "لا كمل", prepStep: "closing_confirm" }).decision, "continue");
    assert.equal(runGate(wf, { text: "بالمناسبة وين موقعكم؟", prepStep: "closing_confirm" }).decision, "substantive");
    // button payloads
    assert.equal(runGate(wf, { quickPayload: "CLOSE_CONVERSATION", prepStep: "closing_confirm" }).decision, "confirm");
    assert.equal(runGate(wf, { quickPayload: "CONTINUE_CONVERSATION", prepStep: "closing_confirm" }).decision, "continue");
  });

  test(`${label}: WITHOUT current_step restored the gate cannot route (this was the bug) — "نعم" falls through to "normal"`, () => {
    assert.equal(runGate(wf, { text: "نعم", prepStep: null }).decision, "normal");
    assert.equal(runGate(wf, { quickPayload: "CLOSE_CONVERSATION", prepStep: null }).decision, "normal");
  });
}

test("closing_confirm_gate is untouched by this fix — no new keyword/affirmative lists added", () => {
  // the gate's vocabulary is exactly what it was; the fix is persistence only
  const code = node(FINAL, "closing_confirm_gate").parameters.jsCode;
  assert.match(code, /const AFFIRM = new Set/);
  assert.match(code, /const NEGATE = new Set/);
  // the fix did not touch this node
  assert.match(code, /Deterministic closing-confirm gate/);
});

// --- VNext Normalize Result: reliable close-step surfacing --------

function runVNextNormalize(agent) {
  const code = node(VNEXT, "Normalize Result").parameters.jsCode;
  const $items = (n) => {
    if (n === "Prepare Context") return [{ json: { handoff_notice: "H", fallback_reply: "F" } }];
    if (n === "Force Human Handover") return [];
    return [];
  };
  return new Function("$items", "$json", code)($items, agent)[0].json;
}

test("VNext Normalize Result: a close request surfaces current_step + quick_reply_action from the EXECUTED TOOL, even with an unparseable observation", () => {
  const out = runVNextNormalize({
    output: "هل أنت متأكد أنك انتهيت؟",
    intermediateSteps: [{ action: { tool: "request_conversation_close" }, observation: "not-json-at-all" }],
  });
  assert.equal(out.action, "close_needs_confirmation");
  assert.equal(out.intent, "closing");
  assert.equal(out.current_step, "closing_confirm");
  assert.equal(out.quick_reply_action, "closing_confirm");
});

test("VNext Normalize Result: a clean JSON observation still works (obs values win when present)", () => {
  const out = runVNextNormalize({
    output: "sure",
    intermediateSteps: [{ action: { tool: "request_conversation_close" }, observation: JSON.stringify({ ok: true, action: "close_needs_confirmation", quick_reply_action: "closing_confirm", current_step: "closing_confirm", conversation_status: "active" }) }],
  });
  assert.equal(out.current_step, "closing_confirm");
  assert.equal(out.quick_reply_action, "closing_confirm");
  assert.equal(out.conversation_status, "active");
});

test("VNext Normalize Result: a non-close turn is unaffected (no phantom closing_confirm)", () => {
  const out = runVNextNormalize({ output: "We're open 9–5.", intermediateSteps: [{ action: { tool: "get_business_facts" }, observation: "{}" }] });
  assert.equal(out.action, null);
  assert.equal(out.current_step, null);
  assert.equal(out.quick_reply_action, null);
});
