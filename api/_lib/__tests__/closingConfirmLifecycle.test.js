import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Cross-message closing_confirm lifecycle — the structured state set by
// /api/ai-tools (close tool) must survive to the customer's NEXT message,
// and the customer's reply to the confirm question is now routed by the
// semantic classifier sub-flow (cc_route -> cc_classify -> cc_decision),
// not by an affirmative/negative word list.
//
// Persistence root cause (still guarded here): sync_conversation_v2 used
// to PATCH conversations.current_step = (state.current_step || null) at
// end-of-run, dropping the "closing_confirm" handleCloseConversation had
// written server-side. On the next inbound the resolver returned
// current_step = null, so the gate exited via `step !== "closing_confirm"`
// and the AI turn re-ran forever.

const FINAL = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_Final.json", import.meta.url), "utf8"));
const WA = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_WhatsApp_V2.json", import.meta.url), "utf8"));
const VNEXT = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AI-Agent-Core-VNext.json", import.meta.url), "utf8"));

const node = (wf, name) => wf.nodes.find((n) => n.name === name);

// eval a `={{ (() => {...})() }}` expression body with mocked n8n scope.
// `ccDecision` here is what cc_decision emits (the FINAL decision).
function evalSyncBody(wf, { state = {}, ccDecision = null, prepStep = null, now = "2026-09-09T00:00:00Z" }) {
  const raw = node(wf, "sync_conversation_v2").parameters.jsonBody;
  const expr = raw.replace(/^=\{\{\n?/, "").replace(/\n?\}\}$/, "");
  const $node = { state_payload: { json: state }, prepare_conversation: { json: { current_step: prepStep } } };
  const $items = (nm) => (nm === "cc_decision" ? [{ json: { decision: ccDecision } }] : []);
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

// cc_decision resolves the final decision from the gate + (optionally) the
// classifier HTTP result. `classify` undefined => the classifier branch
// did not run (button / guard path).
function runCcDecision(wf, { gate, classify }) {
  const code = node(wf, "cc_decision").parameters.jsCode;
  const $items = (nm) => {
    if (nm === "closing_confirm_gate") return [{ json: gate }];
    if (nm === "cc_classify") return classify === undefined ? [] : [{ json: classify }];
    return [];
  };
  return new Function("$items", code)($items)[0].json;
}

// --- Parity --------------------------------------------------------

test("closing_confirm sub-flow is byte-identical in Final and WhatsApp", () => {
  for (const n of ["closing_confirm_gate", "cc_route", "cc_classify", "cc_decision", "closing_confirm_switch"]) {
    assert.deepEqual(node(FINAL, n).parameters, node(WA, n).parameters, `${n} parameters identical`);
  }
  assert.equal(node(FINAL, "sync_conversation_v2").parameters.jsonBody, node(WA, "sync_conversation_v2").parameters.jsonBody);
});

// --- The gate no longer classifies language ----------------------

test("closing_confirm_gate carries NO affirmative/negative/sign-off vocabulary", () => {
  const code = node(FINAL, "closing_confirm_gate").parameters.jsCode;
  assert.doesNotMatch(code, /AFFIRM|NEGATE|FILLER/);
  assert.doesNotMatch(code, /new Set\(/);
  assert.doesNotMatch(code, /نعم|ايوه|يسلمو|yeah|yep/);
  assert.match(code, /Closing-confirm router/);
});

for (const [label, wf] of [["Final", FINAL], ["WhatsApp", WA]]) {
  test(`${label}: gate — not at closing_confirm -> "normal", untouched`, () => {
    assert.equal(runGate(wf, { text: "نعم", prepStep: null }).decision, "normal");
  });

  test(`${label}: gate — quick-reply buttons stay deterministic (never sent to the model)`, () => {
    assert.equal(runGate(wf, { quickPayload: "CLOSE_CONVERSATION", prepStep: "closing_confirm" }).decision, "confirm");
    const cont = runGate(wf, { quickPayload: "CONTINUE_CONVERSATION", prepStep: "closing_confirm" });
    assert.equal(cont.decision, "continue");
    assert.equal(cont.current_step, null);
  });

  test(`${label}: gate — an empty message is "substantive" (never close on nothing)`, () => {
    assert.equal(runGate(wf, { text: "   ", prepStep: "closing_confirm" }).decision, "substantive");
  });

  test(`${label}: gate — ANY free-text reply is handed to the classifier as { decision: "classify", text }`, () => {
    for (const t of ["نعم", "يعطيكم العافية", "لا لسا", "بالمناسبة وين موقعكم؟", "yes", "how much is delivery?"]) {
      const g = runGate(wf, { text: t, prepStep: "closing_confirm" });
      assert.equal(g.decision, "classify");
      assert.equal(g.text, t);
    }
  });

  // --- cc_decision: resolves the final decision + safe default ----

  test(`${label}: cc_decision — button/guard branch passes the gate decision through`, () => {
    assert.equal(runCcDecision(wf, { gate: { decision: "confirm", _cc: "button" } }).decision, "confirm");
    assert.equal(runCcDecision(wf, { gate: { decision: "normal" } }).decision, "normal");
    assert.equal(runCcDecision(wf, { gate: { decision: "substantive", _cc: "empty" } }).decision, "substantive");
  });

  test(`${label}: cc_decision — classifier result is applied for a free-text reply`, () => {
    assert.equal(runCcDecision(wf, { gate: { decision: "classify", text: "x" }, classify: { ok: true, decision: "confirm" } }).decision, "confirm");
    assert.equal(runCcDecision(wf, { gate: { decision: "classify", text: "x" }, classify: { ok: true, decision: "substantive" } }).decision, "substantive");
    const cont = runCcDecision(wf, { gate: { decision: "classify", text: "x" }, classify: { ok: true, decision: "continue" } });
    assert.equal(cont.decision, "continue");
    assert.equal(cont.current_step, null);
    assert.equal(cont.conversation_status, "active");
  });

  test(`${label}: cc_decision — SAFE DEFAULT substantive on any classifier failure (never close on uncertainty)`, () => {
    for (const bad of [{}, { ok: true }, { decision: "classify", text: "x" }, { decision: "YES" }, { decision: null }, { error: "boom" }]) {
      assert.equal(runCcDecision(wf, { gate: { decision: "classify", text: "x" }, classify: bad }).decision, "substantive");
    }
  });

  // --- sync_conversation_v2: current_step persistence ------------

  test(`${label}: TURN 1 close request persists conversations.current_step = "closing_confirm"`, () => {
    const p1 = evalSyncBody(wf, { state: { action: "close_needs_confirmation", current_step: null, conversation_status: "active" }, ccDecision: "normal", prepStep: null });
    assert.equal(p1.current_step, "closing_confirm");
    assert.equal(p1.conversation_status, undefined);
    const p2 = evalSyncBody(wf, { state: { action: "close_needs_confirmation", current_step: "closing_confirm", conversation_status: "active" }, ccDecision: "normal", prepStep: null });
    assert.equal(p2.current_step, "closing_confirm");
  });

  test(`${label}: TURN 2 classified CONFIRM persists the confirmed close`, () => {
    const p = evalSyncBody(wf, { state: { action: "close_confirmed", current_step: "closing_confirmed", conversation_status: "waiting_human" }, ccDecision: "confirm", prepStep: "closing_confirm" });
    assert.equal(p.current_step, "closing_confirmed");
    assert.equal(p.conversation_status, "waiting_human");
  });

  test(`${label}: TURN 2 classified CONTINUE clears closing_confirm, conversation stays active`, () => {
    const p = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active", action: null }, ccDecision: "continue", prepStep: "closing_confirm" });
    assert.equal(p.current_step, null);
    assert.equal(p.conversation_status, undefined);
  });

  test(`${label}: TURN 2 classified SUBSTANTIVE clears the step, no close`, () => {
    const p = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active" }, ccDecision: "substantive", prepStep: "closing_confirm" });
    assert.equal(p.current_step, null);
    assert.equal(p.conversation_status, undefined);
  });

  test(`${label}: safety net — a pending closing_confirm the sub-flow did not resolve is NOT dropped`, () => {
    const p = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active" }, ccDecision: null, prepStep: "closing_confirm" });
    assert.equal(p.current_step, "closing_confirm");
    // "classify" is not a resolved decision either — still held
    const p2 = evalSyncBody(wf, { state: { current_step: null, conversation_status: "active" }, ccDecision: "classify", prepStep: "closing_confirm" });
    assert.equal(p2.current_step, "closing_confirm");
  });

  test(`${label}: a normal turn with nothing pending keeps legacy behaviour (current_step = null)`, () => {
    assert.equal(evalSyncBody(wf, { state: { current_step: null, conversation_status: "active" }, ccDecision: "normal", prepStep: null }).current_step, null);
  });

  test(`${label}: a lead / handover surfaced this turn is still persisted`, () => {
    assert.equal(evalSyncBody(wf, { state: { current_step: "contact_captured", conversation_status: "active", action: "lead_saved" }, ccDecision: "normal", prepStep: null }).current_step, "contact_captured");
    assert.equal(evalSyncBody(wf, { state: { current_step: null, conversation_status: "waiting_human", action: "human_handover" }, ccDecision: "normal", prepStep: null }).conversation_status, "waiting_human");
  });

  test(`${label}: still applies the conversation_status non-downgrade rule`, () => {
    assert.equal(evalSyncBody(wf, { state: { conversation_status: "closed" } }).conversation_status, "closed");
    assert.equal(evalSyncBody(wf, { state: { conversation_status: "waiting_human" } }).conversation_status, "waiting_human");
    assert.equal(evalSyncBody(wf, { state: { conversation_status: "active" } }).conversation_status, undefined);
  });

  // --- downstream readers point at cc_decision, not the gate ------

  test(`${label}: merge_for_state / Prepare AI Core Input read the decision from cc_decision`, () => {
    for (const nm of ["merge_for_state", "Prepare AI Core Input"]) {
      const code = node(wf, nm).parameters.jsCode;
      assert.doesNotMatch(code, /\$items\("closing_confirm_gate"/);
      assert.match(code, /\$items\("cc_decision"/);
    }
    assert.doesNotMatch(node(wf, "sync_conversation_v2").parameters.jsonBody, /\$items\("closing_confirm_gate"/);
    assert.match(node(wf, "sync_conversation_v2").parameters.jsonBody, /\$items\("cc_decision"/);
  });

  test(`${label}: WITHOUT current_step restored the gate cannot route — free text stays "normal"`, () => {
    assert.equal(runGate(wf, { text: "نعم", prepStep: null }).decision, "normal");
    assert.equal(runGate(wf, { quickPayload: "CLOSE_CONVERSATION", prepStep: null }).decision, "normal");
  });
}

// --- classifier sub-flow wiring ----------------------------------

test("cc_classify targets /api/classify-closing-reply with the AI Tools secret and degrades on error", () => {
  for (const wf of [FINAL, WA]) {
    const c = node(wf, "cc_classify");
    assert.match(c.parameters.url, /\/api\/classify-closing-reply$/);
    assert.equal(c.credentials.httpHeaderAuth.id, "TBATq3Dn0WwGFqLu");
    assert.equal(c.onError, "continueRegularOutput");
    assert.match(c.parameters.jsonBody, /JSON\.stringify\(\$json\.text/);
    // cc_route only sends free text ("classify") down the classifier branch
    const r = node(wf, "cc_route");
    assert.equal(r.parameters.conditions.conditions[0].rightValue, "classify");
  }
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

test("VNext Normalize Result: a close request surfaces current_step from the EXECUTED TOOL, even with an unparseable observation", () => {
  const out = runVNextNormalize({
    output: "هل أنت متأكد أنك انتهيت؟",
    intermediateSteps: [{ action: { tool: "request_conversation_close" }, observation: "not-json-at-all" }],
  });
  assert.equal(out.action, "close_needs_confirmation");
  assert.equal(out.intent, "closing");
  assert.equal(out.current_step, "closing_confirm");
  assert.equal(out.quick_reply_action, "closing_confirm");
});

test("VNext Normalize Result: a non-close turn is unaffected (no phantom closing_confirm)", () => {
  const out = runVNextNormalize({ output: "We're open 9–5.", intermediateSteps: [{ action: { tool: "get_business_facts" }, observation: "{}" }] });
  assert.equal(out.action, null);
  assert.equal(out.current_step, null);
  assert.equal(out.quick_reply_action, null);
});
