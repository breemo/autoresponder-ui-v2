import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Semantic closing-confirm classification — end-to-end through the n8n
// sub-flow (closing_confirm_gate -> cc_route -> cc_classify -> cc_decision
// -> closing_confirm_switch -> persistence).
//
// The MEANING judgement belongs to the model (/api/ai-tools action
// classify_closing_reply -> closingReplyClassifier). What this file guards:
//   1. NOT ONE of the spec's example replies is matched by vocabulary in
//      the workflow — every free-text reply is deferred to the classifier
//      with its text passed through byte-for-byte, in any dialect/language.
//   2. Each of the three semantic verdicts drives the correct deterministic
//      lifecycle transition (confirm -> close, continue/substantive ->
//      clear the step, stay active, no close, no re-ask).
//   3. The classifier failure verdict is the conservative one.

const FINAL = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_Final.json", import.meta.url), "utf8"));
const WA = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_WhatsApp_V2.json", import.meta.url), "utf8"));
const node = (wf, name) => wf.nodes.find((n) => n.name === name);

function runGate(wf, text, { prepStep = "closing_confirm", quickPayload = null } = {}) {
  const code = node(wf, "closing_confirm_gate").parameters.jsCode;
  const $items = (nm) => {
    if (nm === "prepare_conversation") return [{ json: { current_step: prepStep, quick_reply_payload: quickPayload } }];
    if (nm === "Code in JavaScript1") return [{ json: { text, quick_reply_payload: quickPayload } }];
    return [];
  };
  return new Function("$items", code)($items)[0].json;
}

function runCcDecision(wf, gate, classify) {
  const code = node(wf, "cc_decision").parameters.jsCode;
  const $items = (nm) => {
    if (nm === "closing_confirm_gate") return [{ json: gate }];
    if (nm === "cc_classify") return classify === undefined ? [] : [{ json: classify }];
    return [];
  };
  return new Function("$items", code)($items)[0].json;
}

// which named output of closing_confirm_switch fires for a decision
function switchRoute(wf, decision) {
  const rules = node(wf, "closing_confirm_switch").parameters.rules.values;
  for (const r of rules) {
    const c = r.conditions.conditions[0];
    if (c.operator.type === "boolean") return r.outputKey; // catch-all
    if (c.operator.operation === "equals" && c.rightValue === decision) return r.outputKey;
  }
  return null;
}

function evalSync(wf, { state, ccDecision, prepStep = "closing_confirm" }) {
  const raw = node(wf, "sync_conversation_v2").parameters.jsonBody;
  const expr = raw.replace(/^=\{\{\n?/, "").replace(/\n?\}\}$/, "");
  const $node = { state_payload: { json: state }, prepare_conversation: { json: { current_step: prepStep } } };
  const $items = (nm) => (nm === "cc_decision" ? [{ json: { decision: ccDecision } }] : []);
  const $now = "2026-09-09T00:00:00Z";
  // eslint-disable-next-line no-eval
  return eval("(" + expr + ")");
}

// downstream `state_payload` shape per switch branch (see closing_confirm_close_reply,
// cc_decision continue-reply, and merge_for_state's stale-close cancel).
const STATE_BY_BRANCH = {
  confirm: { action: "close_confirmed", current_step: "closing_confirmed", conversation_status: "waiting_human" },
  continue: { action: null, current_step: null, conversation_status: "active" },
  normal: { action: null, current_step: null, conversation_status: "active" }, // substantive -> normal AI path
};

// --- 1. genericness: the spec corpus is never vocabulary-matched -----

const CONFIRM_LIKE = ["نعم", "اه", "ايون", "أكيد", "تمام", "يسلمو", "تسلم", "ما قصرتوا", "يعطيكم العافية", "مشكورين", "yes", "yep", "sure", "all good", "that's all", "اه، خلص", "يعطيكم العافية، خلص هيك"];
const CONTINUE_LIKE = ["لا", "لسا", "استنى", "كمل", "لا عندي سؤال", "not yet", "keep going", "I still have a question", "لا، لسا بدي اسأل"];
const SUBSTANTIVE_LIKE = ["بالمناسبة وين موقعكم؟", "طيب كم سعر التوصيل؟", "عندي سؤال ثاني", "شو ساعات العمل؟", "what's your address?", "how much is delivery?", "يسلمو، بس عندي سؤال ثاني", "تمام، بس كم السعر؟", "ما قصرتوا، بس وين الفرع؟"];
const OTHER_LANGS = ["evet, teşekkürler", "merci, c'est tout", "нет, ещё вопрос", "gracias, eso es todo", "はい、大丈夫です"];

for (const [label, wf] of [["Final", FINAL], ["WhatsApp", WA]]) {
  for (const text of [...CONFIRM_LIKE, ...CONTINUE_LIKE, ...SUBSTANTIVE_LIKE, ...OTHER_LANGS]) {
    test(`${label}: gate defers ${JSON.stringify(text)} to the classifier, text passed through verbatim`, () => {
      const g = runGate(wf, text);
      assert.equal(g.decision, "classify");
      assert.equal(g.text, text);
      // nothing pre-decided
      assert.equal(g.reply, undefined);
    });
  }

  test(`${label}: the classifier HTTP body carries only the action + the raw customer text`, () => {
    const body = node(wf, "cc_classify").parameters.jsonBody;
    assert.match(body, /"action":\s*"classify_closing_reply"/);
    assert.match(body, /"text":\s*\{\{ JSON\.stringify\(\$json\.text \|\| ""\) \}\}/);
    // no KB, profile, transcript, conversation_id — just those two keys
    assert.doesNotMatch(body, /conversation_id|knowledge|history/i);
  });

  // --- 2. each verdict -> the right deterministic transition --------

  test(`${label}: CONFIRM verdict -> deterministic confirmed close`, () => {
    const g = runGate(wf, "يعطيكم العافية");
    const d = runCcDecision(wf, g, { ok: true, decision: "confirm" });
    assert.equal(d.decision, "confirm");
    assert.equal(switchRoute(wf, d.decision), "confirm"); // -> closing_confirm_close
    const p = evalSync(wf, { state: STATE_BY_BRANCH.confirm, ccDecision: "confirm" });
    assert.equal(p.current_step, "closing_confirmed");
    assert.equal(p.conversation_status, "waiting_human");
  });

  test(`${label}: CONTINUE verdict -> step cleared, stays active, no close`, () => {
    const g = runGate(wf, "لا، لسا بدي اسأل");
    const d = runCcDecision(wf, g, { ok: true, decision: "continue" });
    assert.equal(d.decision, "continue");
    assert.equal(d.current_step, null);
    assert.equal(d.conversation_status, "active");
    assert.equal(switchRoute(wf, d.decision), "continue"); // -> merge_for_state, no AI
    const p = evalSync(wf, { state: STATE_BY_BRANCH.continue, ccDecision: "continue" });
    assert.equal(p.current_step, null);
    assert.equal(p.conversation_status, undefined); // active is not persisted as a downgrade
  });

  test(`${label}: SUBSTANTIVE verdict -> step cleared, normal AI path, no close, no re-ask`, () => {
    const g = runGate(wf, "يسلمو، بس عندي سؤال ثاني");
    const d = runCcDecision(wf, g, { ok: true, decision: "substantive" });
    assert.equal(d.decision, "substantive");
    assert.equal(switchRoute(wf, d.decision), "normal"); // catch-all -> Welcome Gate -> AI
    const p = evalSync(wf, { state: STATE_BY_BRANCH.normal, ccDecision: "substantive" });
    assert.equal(p.current_step, null); // stale closing_confirm is dropped
    assert.equal(p.conversation_status, undefined);
    // the AI turn is told the step is cleared, so it will not re-ask
    const prepAi = node(wf, "Prepare AI Core Input").parameters.jsCode;
    assert.match(prepAi, /ccDecision === "substantive" && stepForTurn === "closing_confirm"/);
  });

  // --- 3. classifier failure is conservative -----------------------

  test(`${label}: classifier failure -> substantive -> conversation NOT closed`, () => {
    const g = runGate(wf, "اه، خلص");
    for (const bad of [{ error: "timeout" }, {}, { decision: "classify", text: "x" }, { decision: "unknown" }]) {
      const d = runCcDecision(wf, g, bad);
      assert.equal(d.decision, "substantive");
      assert.notEqual(switchRoute(wf, d.decision), "confirm");
    }
  });
}
