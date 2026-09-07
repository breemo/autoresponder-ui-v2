import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// AI Reply Quality V2 — engineering/n8n/working/AI-Agent-Core.json is the
// authoritative source for the workflow. These tests assert the V2
// changes without a running n8n: JSON validity + node/edge integrity, the
// trimmed operating rules, history moving into the human turn, the
// deterministic model-failure fallback, the temperature change, and the
// tool-description wording. The two n8n Code nodes touched are also
// evaluated directly against mocked n8n globals.

const CORE = JSON.parse(
  fs.readFileSync(new URL("../../../engineering/n8n/working/AI-Agent-Core.json", import.meta.url), "utf8")
);
const FINAL = JSON.parse(
  fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_Final.json", import.meta.url), "utf8")
);
const WA = JSON.parse(
  fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_WhatsApp_V2.json", import.meta.url), "utf8")
);

const node = (wf, name) => wf.nodes.find((n) => n.name === name);

// --- Structure ----------------------------------------------------------

test("AI-Agent-Core JSON is valid and node/edge integrity is preserved (22 nodes, 21 connection groups)", () => {
  assert.equal(CORE.nodes.length, 22);
  assert.equal(Object.keys(CORE.connections).length, 21);
  // every connection target still resolves to a real node
  for (const [from, conn] of Object.entries(CORE.connections)) {
    assert.ok(node(CORE, from), `source node exists: ${from}`);
    for (const outputs of Object.values(conn)) {
      for (const branch of outputs) {
        for (const link of branch) {
          assert.ok(node(CORE, link.node), `target node exists: ${link.node}`);
        }
      }
    }
  }
});

test("every Code node still parses as valid JS", () => {
  for (const n of CORE.nodes) {
    if (n.parameters && typeof n.parameters.jsCode === "string") {
      assert.doesNotThrow(() => new Function(n.parameters.jsCode), `${n.name} parses`);
    }
  }
});

// --- Model config -----------------------------------------------------

test("OpenAI model unchanged, temperature lowered 0.35 -> 0.25, maxTokens 600, maxIterations 5", () => {
  const model = node(CORE, "OpenAI Chat Model");
  assert.equal(model.parameters.model.value, "gpt-4o-mini");
  assert.equal(model.parameters.options.temperature, 0.25);
  assert.equal(model.parameters.options.maxTokens, 600);
  const agent = node(CORE, "AI Agent");
  assert.equal(agent.parameters.options.maxIterations, 5);
  assert.equal(agent.parameters.options.returnIntermediateSteps, true);
});

// --- Operating rules are trimmed to workflow-only ---------------------

test("Prepare Agent Context: business/grounding/language duplication removed from operating rules", () => {
  const code = node(CORE, "Prepare Agent Context").parameters.jsCode;
  // history is no longer flattened into the system prompt
  assert.doesNotMatch(code, /## Conversation so far/);
  // language / persona / grounding wording now lives only in promptBuilder.js
  assert.doesNotMatch(code, /Palestinian-Levantine colloquial/);
  assert.doesNotMatch(code, /Speak AS the business \(we, our\)/);
  assert.doesNotMatch(code, /add NO detail \(quantity, weight, size/);
  // workflow-only rules remain
  assert.match(code, /## How you operate \(workflow rules\)/);
  assert.match(code, /#intent: <one of greeting\|knowledge\|price/);
  assert.match(code, /request_human_handover: only tell the customer their request reached the team AFTER/);
});

// --- History -> reference-only block; current message is the request ----

function runPrepare({ messages = [], trigger = {} }) {
  const code = node(CORE, "Prepare Agent Context").parameters.jsCode;
  const $items = (name) => {
    if (name === "When Executed by Another Workflow") return [{ json: trigger }];
    return [];
  };
  const $json = { messages };
  const fn = new Function("$items", "$json", code);
  return fn($items, $json)[0].json;
}

test("Prepare Agent Context: prior CUSTOMER turns go into a reference-only block; current message is the sole request; assistant turns excluded", () => {
  const out = runPrepare({
    messages: [
      { role: "system", content: "## AUTHORITATIVE BUSINESS PROFILE\n..." },
      { role: "user", content: "شو عندكم برغر؟" },
      { role: "assistant", content: "عنا برغر لحمة وبرغر دجاج." },
      { role: "user", content: "طيب والثاني كم سعره؟" },
    ],
    trigger: { conversation_id: "c1", current_message: "طيب والثاني كم سعره؟", current_step: null },
  });
  // current message is what the agent answers
  assert.equal(out.current_message, "طيب والثاني كم سعره؟");
  // prior customer turn is reference-only, in the system message, labelled, once
  assert.match(out.system_message, /## Earlier messages from this customer \(reference only\)/);
  assert.match(out.system_message, /They are NOT open questions/);
  assert.match(out.system_message, /- شو عندكم برغر؟/);
  // 15: current message is NOT duplicated into the reference block
  assert.equal((out.system_message.match(/طيب والثاني كم سعره؟/g) || []).length, 0);
  // assistant text never appears
  assert.doesNotMatch(out.system_message, /عنا برغر لحمة وبرغر دجاج/);
  assert.doesNotMatch(out.system_message, /## Conversation so far/);
});

test("Prepare Agent Context: no prior turns -> no reference block; current_message set", () => {
  const out = runPrepare({
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "مرحبا" }],
    trigger: { current_message: "مرحبا" },
  });
  assert.equal(out.current_message, "مرحبا");
  assert.doesNotMatch(out.system_message, /reference only/);
});

test("Prepare Agent Context: degraded context still produces a valid item and the degraded block", () => {
  const out = runPrepare({ messages: [], trigger: { current_message: "hi" } });
  assert.equal(out.context_ok, false);
  assert.match(out.system_message, /## Business context unavailable this turn/);
  assert.equal(out.current_message, "hi");
});

test("Prepare Agent Context: fallback_reply is language-aware and invents no business facts / no handoff claim", () => {
  const ar = runPrepare({ messages: [], trigger: { current_message: "كم السعر؟" } });
  const en = runPrepare({ messages: [], trigger: { current_message: "what is the price?" } });
  assert.match(ar.fallback_reply, /[؀-ۿ]/);
  assert.doesNotMatch(en.fallback_reply, /[؀-ۿ]/);
  for (const r of [ar.fallback_reply, en.fallback_reply]) {
    assert.doesNotMatch(r, /transfer|teammate|forwarded|price|سعر|حولنا|موظف/i);
  }
});

// --- Model-failure fallback in Resolve Intent ------------------------

function runResolveIntent({ agent, trigger = {}, prepare = {} }) {
  const code = node(CORE, "Resolve Intent").parameters.jsCode;
  const $items = (name) => {
    if (name === "When Executed by Another Workflow") return [{ json: trigger }];
    if (name === "Prepare Agent Context") return [{ json: prepare }];
    return [];
  };
  const fn = new Function("$items", "$json", code);
  return fn($items, agent)[0].json;
}

test("Resolve Intent: a genuine agent failure (no output, no steps) returns the deterministic fallback, no handoff, no lifecycle change", () => {
  const out = runResolveIntent({
    agent: {}, // AI Agent onError passthrough — nothing produced
    trigger: { conversation_id: "c1", client_id: "cl1", current_message: "بدي أحكي مع موظف" },
    prepare: { fallback_reply: "آسفين صار خلل تقني" },
  });
  assert.equal(out.ai_failed, true);
  assert.equal(out.reply, "آسفين صار خلل تقني");
  assert.equal(out.intent, "unknown");
  assert.equal(out.action, null);
  assert.equal(out.conversation_status, null);
  assert.equal(out.already_recorded, true); // Record Intent is skipped
});

test("Resolve Intent: a normal successful reply is unaffected by the fallback guard", () => {
  const out = runResolveIntent({
    agent: { output: "أهلين، عنا برغر لحمة وبرغر دجاج.\n#intent: knowledge", intermediateSteps: [] },
    trigger: { conversation_id: "c1", current_message: "شو عندكم؟" },
    prepare: { fallback_reply: "x" },
  });
  assert.notEqual(out.ai_failed, true);
  assert.equal(out.intent, "knowledge");
  assert.match(out.reply, /برغر لحمة/);
  assert.doesNotMatch(out.reply, /#intent/);
});

test("Resolve Intent: an agent turn that only ran a tool (steps, empty text) is NOT treated as a failure", () => {
  const out = runResolveIntent({
    agent: { output: "", intermediateSteps: [{ action: { tool: "get_business_facts" } }] },
    trigger: { conversation_id: "c1", current_message: "وين موقعكم؟" },
    prepare: { fallback_reply: "x" },
  });
  assert.notEqual(out.ai_failed, true);
});

// --- AI Agent node wiring -------------------------------------------

test("AI Agent answers the current customer message and has a graceful error path", () => {
  const agent = node(CORE, "AI Agent");
  assert.equal(agent.parameters.text, "={{ $json.current_message }}");
  assert.equal(agent.onError, "continueRegularOutput");
});

// --- Tool descriptions --------------------------------------------

test("tool descriptions: search / handover / order wording is tightened, semantics preserved", () => {
  assert.match(node(CORE, "search_business_knowledge").parameters.toolDescription, /ONLY when the RELEVANT KNOWLEDGE BASE EXCERPTS already in your context do not cover/i);
  const ho = node(CORE, "request_human_handover").parameters.toolDescription;
  assert.match(ho, /On a SUCCESS result you may tell the customer/i);
  assert.match(ho, /do NOT tell the customer they were transferred/i);
  assert.match(node(CORE, "start_order").parameters.toolDescription, /nothing is placed, confirmed, or stored by the system/i);
  assert.match(node(CORE, "continue_order").parameters.toolDescription, /a teammate still confirms the final order/i);
});

// --- Parent workflow references still valid ------------------------

for (const [label, wf] of [["Final", FINAL], ["WhatsApp_V2", WA]]) {
  test(`parent ${label}: Execute Sub-workflow still targets ai_agent_core_workflow_id with the same 6 inputs`, () => {
    const exec = node(wf, "Execute Sub-workflow");
    assert.ok(exec, "Execute Sub-workflow node exists");
    assert.match(exec.parameters.workflowId.value, /ai_agent_core_workflow_id/);
    assert.deepEqual(
      Object.keys(exec.parameters.workflowInputs.value).sort(),
      ["channel", "client_id", "conversation_id", "current_message", "current_step", "message_id"]
    );
  });
}
