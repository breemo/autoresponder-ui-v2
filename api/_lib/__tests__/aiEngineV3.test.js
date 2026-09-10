import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createMockSupabase } from "./mockSupabase.js";
import { validateAgentResultV3 } from "../agentResultV3.js";
import { applyAgentActionV3, TOOL_ACTIONS } from "../aiTools.js";

// ===================================================================
// Auto Responder — AI Engine V3 contract + regression suite
//
//   Customer message -> ONE General Agent -> structured decision + reply
//   -> deterministic system execution -> send
//
// This file exercises the whole conversational path WITHOUT a live model:
//   * Validate Structured Output  (n8n V3 core node) == validateAgentResultV3
//   * applyAgentActionV3          (the one deterministic executor)
//   * Build Reply V3              (n8n V3 parent node)
//   * V3 core + V3 parent structural integrity + Final/WhatsApp parity
// ===================================================================

const CORE = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AI-Agent-Core-V3.json", import.meta.url), "utf8"));
const FINAL = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_Final_V3.json", import.meta.url), "utf8"));
const WA = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_WhatsApp_V3.json", import.meta.url), "utf8"));
const node = (wf, name) => wf.nodes.find((n) => n.name === name);

// --- run the V3 core "Validate Structured Output" node ----------------
function runValidateNode(agentOutput, fallback = "تقنيّاً في مشكلة، جرّب بعد شوي.") {
  const code = node(CORE, "Validate Structured Output").parameters.jsCode;
  const $items = (n) => (n === "Prepare Agent Context" ? [{ json: { fallback_reply: fallback } }] : []);
  const $json = typeof agentOutput === "string" ? { output: agentOutput } : agentOutput;
  return new Function("$items", "$json", code)($items, $json)[0].json;
}

// --- run the V3 parent "Build Reply V3" node -------------------------
function runBuildReply(wf, { agentResult, applied = {}, baseText = "", platform = "telegram", integration = {}, prep = {} }) {
  const code = node(wf, "Build Reply V3").parameters.jsCode;
  const $items = (n) => {
    if (n === "Execute Sub-workflow") return [{ json: agentResult }];
    if (n === "Code in JavaScript1") return [{ json: { platform, channelKey: "k", text: baseText, sender_id: "s" } }];
    if (n === "client_feature") return [{ json: { client_id: "c1", config: {}, clients: {}, ...integration } }];
    if (n === "prepare_conversation") return [{ json: { conversation_id: "cv1", conversation_status: "active", current_step: null, client_id: "c1", ...prep } }];
    return [];
  };
  return new Function("$items", "$json", code)($items, applied)[0].json;
}

function tables(overrides = {}) {
  const t = {
    conversations: [
      { id: "conv-A", client_id: "client-A", contact_id: "contact-A", channel_identity_id: "ci-A", platform: "whatsapp", conversation_status: "active", current_step: null, last_message_at: null },
    ],
    contact_channel_identities: [
      { id: "ci-A", client_id: "client-A", contact_id: "contact-A", platform: "whatsapp", sender_id: "970590000001", channel_key: "wa-A" },
    ],
    clients: [{ id: "client-A", business_name: "Acme", locations_list_complete: false }],
    messages: [
      { id: "m1", client_id: "client-A", conversation_id: "conv-A", direction: "inbound", created_at: "2026-01-01T00:00:10Z", intent: null },
    ],
    conversation_state: [
      { client_id: "client-A", conversation_id: "conv-A", conversation_status: "active", current_step: null, updated_at: null },
    ],
    leads: [],
  };
  if (overrides.current_step !== undefined) {
    t.conversations[0].current_step = overrides.current_step;
    t.conversation_state[0].current_step = overrides.current_step;
  }
  return t;
}

// ===================================================================
// 1. The n8n validator node == the tested module (no drift)
// ===================================================================

const VALIDATE_CORPUS = [
  '{"action":"reply","reply":"أهلاً وسهلاً","intent":"greeting"}',
  '{"action":"handover","reply":"رح أحولك لموظف","action_params":{"reason":"شكوى"}}',
  '{"action":"save_contact","reply":"سجلت رقمك","action_params":{"name":"علي","phone":"0599123456"}}',
  '{"action":"save_contact","reply":"سجّلت بياناتك والفريق رح يتواصل معك","action_params":{"name":"إبراهيم","phone":"0599001852","handover_after_save":true}}',
  '{"action":"reply","reply":"تمام","action_params":{"handover_after_save":true}}',
  '{"action":"request_confirmation","reply":"متأكد إنك خلصت؟","options":["نعم","كمل"]}',
  '{"action":"close_conversation","reply":"شكراً لتواصلك معنا 🙏"}',
  'prefix text {"action":"reply","reply":"سعر الكشف ٥٠"} suffix',
  '{"action":"nonsense","reply":"x"}',
  '{"action":"handover"}',
  "totally not json",
  '{"action":"reply"}',
  "",
];

test("V3 core Validate node produces the same result as validateAgentResultV3 for every corpus case", () => {
  for (const raw of VALIDATE_CORPUS) {
    const fromNode = runValidateNode(raw, "FB");
    const fromModule = validateAgentResultV3(raw, { fallbackReply: "FB" }).result;
    assert.deepEqual(fromNode, fromModule, `mismatch for: ${JSON.stringify(raw)}`);
  }
});

// ===================================================================
// 2. applyAgentActionV3 — the ONE deterministic executor
// ===================================================================

test("action reply, nothing pending -> no DB write, state unchanged", async () => {
  const t = tables();
  const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: "reply" });
  assert.equal(r.ok, true);
  assert.equal(r.executed, false);
  assert.equal(r.conversation_status, "active");
  assert.equal(r.current_step, null);
  assert.equal(t.conversations[0].current_step, null);
});

test("action handover -> reuses request_handover -> waiting_human", async () => {
  const t = tables();
  const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: "handover", agentActionParams: { reason: "بدو موظف" } });
  assert.equal(r.action, "handover");
  assert.equal(r.executed, true);
  assert.equal(r.conversation_status, "waiting_human");
  assert.equal(t.conversations[0].conversation_status, "waiting_human");
});

test("action save_contact -> reuses upsert_lead; both parts on file -> contact_captured", async () => {
  const t = tables();
  const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: "save_contact", agentActionParams: { name: "علي", phone: "0599123456" } });
  assert.equal(r.action, "save_contact");
  assert.equal(r.current_step, "contact_captured");
  assert.equal(t.leads.length, 1);
  assert.equal(t.leads[0].name, "علي");
});

test("action save_contact with a bad phone -> name still saved, phone_invalid flagged, NO close/handover", async () => {
  const t = tables();
  const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: "save_contact", agentActionParams: { name: "سميرة", phone: "abc" } });
  assert.equal(r.ok, true);
  assert.equal(r.phone_invalid, true);
  assert.equal(r.conversation_status, "active");
  assert.equal(t.leads.length, 1);
  assert.equal(t.leads[0].name, "سميرة");
});

test("validateAgentResultV3: handover_after_save survives ONLY for save_contact", () => {
  const on = validateAgentResultV3('{"action":"save_contact","reply":"ok","action_params":{"name":"إبراهيم","phone":"0599001852","handover_after_save":true}}').result;
  assert.equal(on.action_params.handover_after_save, true);
  const off = validateAgentResultV3('{"action":"save_contact","reply":"ok","action_params":{"name":"إبراهيم","phone":"0599001852","handover_after_save":false}}').result;
  assert.equal("handover_after_save" in off.action_params, false);
  const wrongAction = validateAgentResultV3('{"action":"reply","reply":"ok","action_params":{"handover_after_save":true}}').result;
  assert.equal("handover_after_save" in wrongAction.action_params, false);
});

test("save_contact + handover_after_save:true -> lead saved, THEN existing human handover (waiting_human)", async () => {
  const t = tables();
  const r = await applyAgentActionV3(createMockSupabase(t), {
    conversationId: "conv-A",
    agentAction: "save_contact",
    agentActionParams: { name: "إبراهيم", phone: "0599001852", handover_after_save: true },
  });
  assert.equal(r.action, "save_contact");
  assert.equal(r.executed, true);
  assert.equal(r.handover_after_save, true);
  // lead persisted FIRST
  assert.equal(t.leads.length, 1);
  assert.equal(t.leads[0].phone, "0599001852");
  // then the existing handover lifecycle: same state the `handover` action produces
  assert.equal(r.conversation_status, "waiting_human");
  assert.equal(r.current_step, "contact_captured");
  assert.equal(t.conversations[0].conversation_status, "waiting_human");
  assert.equal(t.conversations[0].current_step, "contact_captured");
});

test("save_contact + handover_after_save:false -> lead saved, conversation stays with the AI", async () => {
  const t = tables();
  const r = await applyAgentActionV3(createMockSupabase(t), {
    conversationId: "conv-A",
    agentAction: "save_contact",
    agentActionParams: { name: "إبراهيم", phone: "0599001852", handover_after_save: false },
  });
  assert.equal(r.handover_after_save, false);
  assert.equal(t.leads.length, 1);
  assert.equal(r.conversation_status, "active");
  assert.equal(r.current_step, "contact_captured");
  assert.equal(t.conversations[0].conversation_status, "active");
});

test("save_contact + handover_after_save:true but lead persistence FAILS -> NO handover, stays active", async () => {
  const t = tables();
  const base = createMockSupabase(t);
  const supabase = {
    from(tbl) {
      const b = base.from(tbl);
      if (tbl === "leads") return { ...b, async insert() { return { data: null, error: { message: "db down" } }; } };
      return b;
    },
  };
  const r = await applyAgentActionV3(supabase, {
    conversationId: "conv-A",
    agentAction: "save_contact",
    agentActionParams: { name: "إبراهيم", phone: "0599001852", handover_after_save: true },
  });
  assert.equal(r.handover_after_save, false);
  assert.equal(t.leads.length, 0);
  assert.equal(r.conversation_status, "active");
  assert.equal(t.conversations[0].conversation_status, "active");
});

test("action request_confirmation -> current_step = closing_confirm, conversation stays active", async () => {
  const t = tables();
  const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: "request_confirmation" });
  assert.equal(r.action, "request_confirmation");
  assert.equal(r.conversation_status, "active");
  assert.equal(r.current_step, "closing_confirm");
  assert.equal(t.conversations[0].current_step, "closing_confirm");
  assert.notEqual(t.conversations[0].conversation_status, "closed");
});

test("action close_conversation -> waiting_human + closing_confirmed (never a hard 'closed' by AI)", async () => {
  const t = tables({ current_step: "closing_confirm" });
  const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: "close_conversation" });
  assert.equal(r.action, "close_conversation");
  assert.equal(r.conversation_status, "waiting_human");
  assert.equal(r.current_step, "closing_confirmed");
  assert.equal(t.conversations[0].conversation_status, "waiting_human");
  assert.notEqual(t.conversations[0].conversation_status, "closed");
});

test("action reply WHILE current_step=closing_confirm -> pending close is cleared deterministically", async () => {
  const t = tables({ current_step: "closing_confirm" });
  const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: "reply" });
  assert.equal(r.action, "reply");
  assert.equal(r.cleared_pending_close, true);
  assert.equal(r.current_step, null);
  assert.equal(t.conversations[0].current_step, null);
  assert.equal(t.conversations[0].conversation_status, "active");
});

test("an unknown / garbage action value is executed as reply — never as a lifecycle action", async () => {
  const t = tables({ current_step: "closing_confirm" });
  for (const bad of ["", "drop_table", "CLOSE", null, undefined, 5]) {
    t.conversations[0].current_step = "closing_confirm";
    const r = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: bad });
    assert.equal(r.action, "reply");
    assert.notEqual(t.conversations[0].conversation_status, "waiting_human");
  }
});

test("apply_agent_action_v3 is a registered /api/ai-tools action", () => {
  assert.ok(TOOL_ACTIONS.includes("apply_agent_action_v3"));
});

// ===================================================================
// 3. Build Reply V3 — one reply shape, channel-aware options
// ===================================================================

for (const [label, wf] of [["Final", FINAL], ["WhatsApp", WA]]) {
  test(`${label}: a plain reply passes the Agent text straight through, no buttons, no step`, () => {
    const out = runBuildReply(wf, { agentResult: { action: "reply", reply: "سعر الكشف ٥٠ شيكل", options: [], intent: "pricing" }, applied: { action: "reply", conversation_status: "active", current_step: null }, baseText: "كم سعر الكشف؟" });
    assert.equal(out.reply, "سعر الكشف ٥٠ شيكل");
    assert.equal(out.quick_replies, null);
    assert.equal(out.current_step, null);
    assert.equal(out.reply_source, "ai");
  });

  test(`${label}: request_confirmation options render as buttons ONLY on FB/IG; text always stands alone`, () => {
    const agentResult = { action: "request_confirmation", reply: "متأكد إنك خلصت؟", options: ["نعم", "كمل"], intent: "closing" };
    const applied = { action: "request_confirmation", conversation_status: "active", current_step: "closing_confirm" };

    const fb = runBuildReply(wf, { agentResult, applied, platform: "facebook" });
    assert.deepEqual(fb.quick_replies.map((q) => q.title), ["نعم", "كمل"]);
    assert.equal(fb.current_step, "closing_confirm");

    for (const p of ["telegram", "whatsapp", "instagram"]) {
      const o = runBuildReply(wf, { agentResult, applied, platform: p });
      if (p === "instagram") assert.ok(Array.isArray(o.quick_replies));
      else assert.equal(o.quick_replies, null, `${p} sends no buttons`);
      assert.equal(o.reply, "متأكد إنك خلصت؟"); // the question works with no buttons
    }
  });

  test(`${label}: lifecycle state comes from Apply Action V3 (authoritative), not the Agent`, () => {
    const out = runBuildReply(wf, { agentResult: { action: "close_conversation", reply: "شكراً لتواصلك معنا 🙏" }, applied: { action: "close_conversation", conversation_status: "waiting_human", current_step: "closing_confirmed" } });
    assert.equal(out.conversation_status, "waiting_human");
    assert.equal(out.current_step, "closing_confirmed");
  });

  test(`${label}: Build Reply V3 falls back to prep state when applied carries no lifecycle fields (defensive; no mutation)`, () => {
    // Apply Action V3 now stops the run on failure, so this is only a
    // defensive path — if `applied` ever lacks conversation_status/current_step
    // the reply still uses prep state and never invents a transition.
    const agentResult = { action: "handover", reply: "رح أحولك لموظف", action_params: { reason: "x" } };
    const out = runBuildReply(wf, { agentResult, applied: agentResult, prep: { conversation_status: "active", current_step: null } });
    assert.equal(out.reply, "رح أحولك لموظف");
    assert.equal(out.conversation_status, "active");
    assert.equal(out.current_step, null);
  });
}

// ===================================================================
// 4. The 13 required scenarios — end to end (validate -> apply)
// ===================================================================

async function turn(agentJson, { current_step = null } = {}) {
  const validated = validateAgentResultV3(agentJson).result;
  const t = tables({ current_step });
  const applied = await applyAgentActionV3(createMockSupabase(t), {
    conversationId: "conv-A",
    agentAction: validated.action,
    agentActionParams: validated.action_params,
  });
  const reply = runBuildReply(FINAL, { agentResult: validated, applied, platform: "telegram", prep: { current_step } });
  return { validated, applied, reply, db: t.conversations[0] };
}

test("Scenario 1 — normal general question (Arabic)", async () => {
  const { reply, db } = await turn('{"action":"reply","reply":"إحنا شركة خدمات، بنساعدك بأي استفسار.","intent":"general"}');
  assert.equal(reply.action, "reply");
  assert.equal(db.current_step, null);
  assert.equal(db.conversation_status, "active");
});

test("Scenario 2 — pricing question", async () => {
  const { reply } = await turn('{"action":"reply","reply":"سعر الكشف ٥٠ شيكل.","intent":"pricing"}');
  assert.equal(reply.action, "reply");
  assert.match(reply.reply, /٥٠/);
});

test("Scenario 3 — location + pricing in ONE message -> ONE reply, no branching", async () => {
  const { validated, reply } = await turn('{"action":"reply","reply":"موقعنا في نابلس شارع رفيديا، وسعر الكشف ٥٠ شيكل.","intent":"location,pricing"}');
  assert.equal(validated.action, "reply");
  assert.match(reply.reply, /نابلس/);
  assert.match(reply.reply, /٥٠/); // both answered in the single reply
});

test("Scenario 4 — follow-up relying on history (prompt carries the transcript)", () => {
  // history handling is in buildPromptMessagesV3 — covered in promptBuilderV3.test.js;
  // here: a follow-up answer is still a plain reply, nothing routes.
  const { result } = validateAgentResultV3('{"action":"reply","reply":"الكشف التاني سعره ٧٠.","intent":"pricing"}');
  assert.equal(result.action, "reply");
});

test("Scenario 5 — customer provides name + phone -> save_contact", async () => {
  const { applied, db } = await turn('{"action":"save_contact","reply":"تمام يا علي، سجلت رقمك ورح يتواصل معك الفريق.","action_params":{"name":"علي","phone":"0599123456"},"intent":"lead"}');
  assert.equal(applied.action, "save_contact");
  assert.equal(db.current_step, "contact_captured");
});

test("Scenario 5b — contact details + an EXPLICIT callback request -> save_contact (params survive validation), lead persisted, stays active", async () => {
  // The Agent's job here (per the contract): return save_contact, NOT a
  // conversational "I can't contact you". Validation must keep the action
  // + params; Apply Action must persist the lead.
  const raw = '{"action":"save_contact","reply":"تمام، سجلت اسمك ورقمك ورح يتواصل معك أحد من الفريق قريباً.","action_params":{"name":"سميرة أحمد","phone":"0598111222","junk":"drop me"},"intent":"lead"}';
  const { result } = validateAgentResultV3(raw);
  assert.equal(result.action, "save_contact");
  assert.deepEqual(result.action_params, { name: "سميرة أحمد", phone: "0598111222" }); // params kept, unknown key dropped

  const t = tables();
  const applied = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: result.action, agentActionParams: result.action_params });
  assert.equal(applied.action, "save_contact");
  assert.equal(t.leads.length, 1);
  assert.equal(t.leads[0].name, "سميرة أحمد");
  assert.equal(t.leads[0].phone, "0598111222");
  // POST-CONTACT LIFECYCLE: save the contact, mark contact_captured, DO NOT
  // hand over — conversation stays active and the AI keeps replying.
  assert.equal(applied.conversation_status, "active");
  assert.equal(t.conversations[0].conversation_status, "active");
  assert.equal(t.conversations[0].current_step, "contact_captured");
});

test("Scenario 6 — customer asks for a human -> handover", async () => {
  const { applied, db } = await turn('{"action":"handover","reply":"أكيد، رح أحولك لأحد الموظفين.","action_params":{"reason":"طلب موظف"},"intent":"human_request"}');
  assert.equal(applied.action, "handover");
  assert.equal(db.conversation_status, "waiting_human");
});

test("Scenario 7 — courtesy-only message -> reply, nothing changes", async () => {
  const { applied, db } = await turn('{"action":"reply","reply":"العفو 🌟","intent":"courtesy"}');
  assert.equal(applied.executed, false);
  assert.equal(db.current_step, null);
  assert.equal(db.conversation_status, "active");
});

test("Scenario 8 — clear conversation close -> request_confirmation", async () => {
  const { applied, reply, db } = await turn('{"action":"request_confirmation","reply":"تمام 🙏 حابب أتأكد إنك خلصت؟","options":["نعم","كمل"],"intent":"closing"}');
  assert.equal(applied.action, "request_confirmation");
  assert.equal(db.current_step, "closing_confirm");
  assert.equal(db.conversation_status, "active"); // NOT closed
  assert.deepEqual(reply.quick_replies, null); // telegram: text only, still works
});

test("Scenario 9 — closing confirmation (\"اه خلص\") -> close_conversation", async () => {
  const { applied, db } = await turn('{"action":"close_conversation","reply":"شكراً لتواصلك معنا 🙏 سعدنا بخدمتك.","intent":"closing"}', { current_step: "closing_confirm" });
  assert.equal(applied.action, "close_conversation");
  assert.equal(db.conversation_status, "waiting_human");
  assert.equal(db.current_step, "closing_confirmed");
});

test("Scenario 10 — appears to close but asks another question -> reply, pending close cleared", async () => {
  const { applied, reply, db } = await turn('{"action":"reply","reply":"طبعاً — ساعات العمل من ٩ لـ٥.","intent":"hours"}', { current_step: "closing_confirm" });
  assert.equal(applied.action, "reply");
  assert.equal(applied.cleared_pending_close, true);
  assert.equal(db.current_step, null);
  assert.equal(db.conversation_status, "active");
  assert.match(reply.reply, /ساعات العمل/);
});

test("Scenario 11 — unknown / unsupported question -> reply", async () => {
  const { applied } = await turn('{"action":"reply","reply":"ما عندي معلومة مؤكدة عن هالشي، بس بقدر أساعدك بأي استفسار تاني.","intent":"unknown"}');
  assert.equal(applied.action, "reply");
});

test("Scenario 12 — INVALID structured output -> safe reply, ZERO lifecycle mutation", async () => {
  for (const junk of ['{"action":"close_conversation"}', "the customer wants to close", "{ not json", '{"action":"handover","reply":""}']) {
    const t = tables({ current_step: "closing_confirm" });
    const validated = validateAgentResultV3(junk, { fallbackReply: "صار عنا خلل تقني، جرّب بعد شوي." }).result;
    assert.equal(validated.action, "reply");
    const applied = await applyAgentActionV3(createMockSupabase(t), { conversationId: "conv-A", agentAction: validated.action, agentActionParams: validated.action_params });
    // a "reply" while closing_confirm clears the step — but it NEVER closes / hands over
    assert.notEqual(t.conversations[0].conversation_status, "waiting_human");
    assert.notEqual(t.conversations[0].conversation_status, "closed");
  }
});

test("Scenario 13 — multi-account / channel context stays correct", () => {
  // V3 parents keep the deterministic identity + entitlement + multi-account chain untouched
  for (const wf of [FINAL, WA]) {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const keep of ["client_feature", "get_active_subscription", "validate_subscription", "If plan_supports_ai", "resolve_conversation_v2", "prepare_conversation", "check_integration_active", "check_human_stop", "platform"]) {
      assert.ok(names.has(keep) || wf.nodes.some((n) => /Number|Server|Evolution/.test(n.name)), `${wf.name} keeps ${keep}`);
    }
    // Apply Action V3 anchors conversation_id from prepare_conversation, never the Agent
    assert.match(node(wf, "Apply Action V3").parameters.jsonBody, /prepare_conversation.*conversation_id/s);
    assert.doesNotMatch(node(wf, "Apply Action V3").parameters.jsonBody, /\$fromAI|agent.*client_id/i);
  }
});

// ===================================================================
// 5. V3 workflow structure
// ===================================================================

test("AI-Agent-Core-V3: exactly the small target flow, ONE model call, ONE read-only tool", () => {
  assert.equal(CORE.active, false);
  const names = CORE.nodes.map((n) => n.name).sort();
  assert.deepEqual(names, ["AI Agent", "Load AI Context", "OpenAI Chat Model", "Prepare Agent Context", "Validate Structured Output", "When Executed by Another Workflow", "search_business_knowledge"].sort());
  // one model, one tool, both feeding the single Agent
  assert.equal(CORE.connections["OpenAI Chat Model"].ai_languageModel[0][0].node, "AI Agent");
  assert.equal(CORE.connections["search_business_knowledge"].ai_tool[0][0].node, "AI Agent");
  // linear main chain, terminal = Validate
  const withOut = new Set(Object.keys(CORE.connections));
  assert.deepEqual(CORE.nodes.filter((n) => !withOut.has(n.name)).map((n) => n.name), ["Validate Structured Output"]);
  // the agent does NOT return intermediate steps (nothing parses them)
  assert.equal(node(CORE, "AI Agent").parameters.options.returnIntermediateSteps, false);
  // context endpoint is the shared one, in v3 mode
  assert.match(node(CORE, "Load AI Context").parameters.jsonBody, /"format": "v3"/);
  assert.match(node(CORE, "Load AI Context").parameters.url, /\/api\/ai-context$/);
});

test("AI-Agent-Core-V3: no per-intent classifier, no keyword lists, no second model call", () => {
  const blob = JSON.stringify(CORE);
  assert.doesNotMatch(blob, /classify_closing_reply|cc_classify|KW_[A-Z]|AFFIRMATIVE_WORDS|ACK_THANKS|HUMAN_PHRASES|isLikelyFollowUp/);
  // exactly one lmChat node
  assert.equal(CORE.nodes.filter((n) => n.type.includes("lmChat")).length, 1);
  assert.equal(CORE.nodes.filter((n) => n.type.includes("langchain.agent")).length, 1);
});

test("V3 parents: the closing sub-flow and legacy conversational routing are gone", () => {
  for (const wf of [FINAL, WA]) {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const gone of ["closing_confirm_gate", "cc_route", "cc_classify", "cc_decision", "closing_confirm_switch", "closing_confirm_close", "closing_confirm_close_reply", "normalize_core_result", "Prepare AI Core Input"]) {
      assert.equal(names.has(gone), false, `${wf.name} still has ${gone}`);
    }
    assert.ok(names.has("Prepare Agent Input V3") && names.has("Apply Action V3") && names.has("Build Reply V3"));
  }
});

test("V3 parents: the AI path is exactly 5 nodes; human hard-stop still precedes it", () => {
  for (const wf of [FINAL, WA]) {
    const c = wf.connections;
    assert.deepEqual(c["check_human_stop"].main[1], [{ node: "Welcome Gate", type: "main", index: 0 }]);
    assert.deepEqual(c["If plan_supports_ai"].main[0], [{ node: "Prepare Agent Input V3", type: "main", index: 0 }]);
    assert.deepEqual(c["Prepare Agent Input V3"].main[0], [{ node: "Execute Sub-workflow", type: "main", index: 0 }]);
    assert.deepEqual(c["Execute Sub-workflow"].main[0], [{ node: "Apply Action V3", type: "main", index: 0 }]);
    assert.deepEqual(c["Apply Action V3"].main[0], [{ node: "Build Reply V3", type: "main", index: 0 }]);
    assert.deepEqual(c["Build Reply V3"].main[0], [{ node: "state_payload", type: "main", index: 0 }]);
    // Execute Sub-workflow: input mapping byte-identical to the old parent;
    // workflowId is "From list" + empty so AI-Agent-Core-V3 is picked from
    // the dropdown after import (no dangling ID, nothing to hand-resolve).
    const exec = node(wf, "Execute Sub-workflow");
    assert.deepEqual(exec.parameters.workflowId, { __rl: true, mode: "list", value: "", cachedResultName: "AI-Agent-Core-V3" });
    assert.deepEqual(Object.keys(exec.parameters.workflowInputs.value).sort(), ["channel", "client_id", "conversation_id", "current_message", "current_step", "message_id"]);
  }
});

test("V3 parents: every Code node parses; graph refs resolve; Final ⇄ WhatsApp parity on the V3 surface", () => {
  for (const wf of [FINAL, WA]) {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, conn] of Object.entries(wf.connections)) {
      assert.ok(names.has(from));
      for (const outs of Object.values(conn)) for (const b of outs) for (const l of b) assert.ok(names.has(l.node), `${wf.name}: ${from} -> missing ${l.node}`);
    }
    for (const n of wf.nodes) if (n.parameters && typeof n.parameters.jsCode === "string") assert.doesNotThrow(() => new Function(n.parameters.jsCode), `${wf.name}/${n.name}`);
  }
  for (const name of ["Apply Action V3", "Build Reply V3", "sync_conversation_v2", "merge_for_state"]) {
    assert.deepEqual(node(FINAL, name).parameters, node(WA, name).parameters, `${name} identical`);
  }
  // the only intended parent difference: the channel label the Agent is told
  assert.match(node(FINAL, "Prepare Agent Input V3").parameters.jsCode, /base\.platform \|\| "facebook"/);
  assert.match(node(WA, "Prepare Agent Input V3").parameters.jsCode, /channel: "whatsapp"/);
});

test("V3 parents: sync_conversation_v2 has no cc_* coupling and only re-asserts authoritative state", () => {
  for (const wf of [FINAL, WA]) {
    const body = node(wf, "sync_conversation_v2").parameters.jsonBody;
    assert.doesNotMatch(body, /cc_decision|closing_confirm_gate|close_needs_confirmation|pendingConfirm/);
    assert.match(body, /non-downgrade/i);
  }
});

// ===================================================================
// 6. Integration parity — V3 parents are drop-in vs the OLD parents
// ===================================================================

const OLD_FINAL = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_Final.json", import.meta.url), "utf8"));
const OLD_WA = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_WhatsApp_V2.json", import.meta.url), "utf8"));
const OLD_CORE_LEGACY = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AI-Agent-Core.json", import.meta.url), "utf8"));

const V3_TOUCHED = new Set(["Prepare Agent Input V3", "Apply Action V3", "Build Reply V3"]);
const V3_BODY_ONLY = new Set(["sync_conversation_v2", "merge_for_state"]);
const V3_REMOVED = new Set(["closing_confirm_gate", "cc_route", "cc_classify", "cc_decision", "closing_confirm_switch", "closing_confirm_close", "closing_confirm_close_reply", "normalize_core_result", "Prepare AI Core Input"]);

for (const [label, OLD, V3] of [["Final", OLD_FINAL, FINAL], ["WhatsApp", OLD_WA, WA]]) {
  test(`${label}: webhooks are byte-identical (path / method / responseMode / webhookId / options)`, () => {
    const wh = (wf) => wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook").map((n) => ({ name: n.name, m: n.parameters.httpMethod, p: n.parameters.path, r: n.parameters.responseMode, o: n.parameters.options, id: n.webhookId }));
    assert.deepEqual(wh(V3), wh(OLD));
  });

  test(`${label}: credential references are byte-identical (none added / removed)`, () => {
    const creds = (wf) => [...new Set(wf.nodes.flatMap((n) => (n.credentials ? Object.entries(n.credentials).map(([t, c]) => `${t}:${c.id}:${c.name}`) : [])))].sort();
    assert.deepEqual(creds(V3), creds(OLD));
  });

  test(`${label}: every channel send node is byte-identical`, () => {
    const sends = (wf) => wf.nodes.filter((n) => /^(send |Send |WA Welcome|Get WhatsApp|Inbound Media - Get)/.test(n.name) && n.type === "n8n-nodes-base.httpRequest").map((n) => JSON.stringify(n));
    assert.deepEqual(sends(V3).sort(), sends(OLD).sort());
  });

  test(`${label}: registry nodes untouched; Execute Sub-workflow input mapping byte-identical, workflow now selectable`, () => {
    for (const nm of ["Get Workflow Registry", "Parse Workflow Registry"]) {
      assert.deepEqual(node(V3, nm).parameters, node(OLD, nm).parameters); // registry query untouched
    }
    const oe = node(OLD, "Execute Sub-workflow").parameters;
    const ve = node(V3, "Execute Sub-workflow").parameters;
    assert.deepEqual(ve.workflowInputs.value, oe.workflowInputs.value); // 6-field mapping unchanged
    assert.deepEqual(ve.workflowInputs.schema, oe.workflowInputs.schema);
    assert.deepEqual(ve.options, oe.options);
    // workflowId: "From list" + empty -> pick AI-Agent-Core-V3 in the UI after import
    assert.deepEqual(ve.workflowId, { __rl: true, mode: "list", value: "", cachedResultName: "AI-Agent-Core-V3" });
  });

  test(`${label}: EVERY node except the 3 V3 nodes / 2 body-swaps / 9 removed is byte-identical to the old parent`, () => {
    let diffs = [];
    for (const on of OLD.nodes) {
      if (V3_REMOVED.has(on.name)) continue;
      const vn = node(V3, on.name);
      assert.ok(vn, `${on.name} missing in V3`);
      if (V3_TOUCHED.has(on.name)) continue;
      let a = JSON.stringify(on), b = JSON.stringify(vn);
      if (V3_BODY_ONLY.has(on.name)) {
        const strip = (n) => { const c = JSON.parse(JSON.stringify(n)); delete c.parameters.jsCode; delete c.parameters.jsonBody; return c; };
        a = JSON.stringify(strip(on)); b = JSON.stringify(strip(vn));
      }
      if (on.name === "Execute Sub-workflow") {
        // workflowId intentionally changed to a selectable "From list";
        // everything else (inputs mapping, schema, options, position, id) must match.
        const strip = (n) => { const c = JSON.parse(JSON.stringify(n)); c.parameters.workflowId = 0; return c; };
        a = JSON.stringify(strip(on)); b = JSON.stringify(strip(vn));
      }
      if (a !== b) diffs.push(on.name);
    }
    assert.deepEqual(diffs, [], `unexpected node changes: ${diffs.join(", ")}`);
  });

  test(`${label}: settings / meta preserved`, () => {
    assert.deepEqual(V3.settings, OLD.settings);
    assert.deepEqual(V3.meta, OLD.meta);
    assert.equal(V3.active, false);
  });
}

test("V3 core: /api/ai-context call matches the legacy core's (auth, credential, header, error mode) — only adds format:v3", () => {
  const legacy = OLD_CORE_LEGACY.nodes.find((n) => n.name === "Get AI Context");
  const v3 = node(CORE, "Load AI Context");
  assert.equal(v3.parameters.url, legacy.parameters.url);
  assert.equal(v3.parameters.method, legacy.parameters.method);
  assert.deepEqual(v3.credentials, legacy.credentials);
  assert.deepEqual(v3.parameters.headerParameters, legacy.parameters.headerParameters);
  assert.equal(v3.onError, legacy.onError);
  assert.equal(v3.typeVersion, legacy.typeVersion);
  assert.match(v3.parameters.jsonBody, /"format": "v3"/);
  // the trigger is the same executeWorkflowTrigger config as production cores
  assert.deepEqual(node(CORE, "When Executed by Another Workflow").parameters, OLD_CORE_LEGACY.nodes.find((n) => n.name === "When Executed by Another Workflow").parameters);
  assert.deepEqual(CORE.settings, OLD_CORE_LEGACY.settings);
});

// ===================================================================
// 7. Apply Action V3 — exact request contract
//    (regression for the live "invalid syntax" failure: the node's
//     jsonBody had escaped-backslash-quote property access and an
//     object-literal fallback inside {{ }}, and onError:continue let a
//     failed action fall through and send a false success confirmation.)
// ===================================================================

for (const [label, wf] of [["Final", FINAL], ["WhatsApp", WA]]) {
  const OLD_CLOSE = node(OLD_FINAL, "closing_confirm_close"); // known-working /api/ai-tools POST

  test(`Apply Action V3 (${label}): transport matches the known-working /api/ai-tools node`, () => {
    const n = node(wf, "Apply Action V3");
    const p = n.parameters;
    assert.equal(p.method, "POST");
    assert.equal(p.url, "={{ $env.APP_API_BASE_URL }}/api/ai-tools");
    assert.equal(p.authentication, "genericCredentialType");
    assert.equal(p.genericAuthType, "httpHeaderAuth");
    assert.equal(p.specifyBody, "json");
    assert.equal(p.sendBody, true);
    assert.deepEqual(p.headerParameters, OLD_CLOSE.parameters.headerParameters);
    assert.deepEqual(n.credentials, OLD_CLOSE.credentials);
    assert.equal(n.typeVersion, OLD_CLOSE.typeVersion);
  });

  test(`Apply Action V3 (${label}): jsonBody is valid n8n expression syntax`, () => {
    const body = node(wf, "Apply Action V3").parameters.jsonBody;
    // the two constructs n8n rejected with "invalid syntax":
    assert.doesNotMatch(body, /\\\\"/, "escaped-backslash-quote in a {{ }} expression");
    assert.doesNotMatch(body, /\|\|\s*\{\}/, "object-literal fallback inside a {{ }} expression");
    // property access is plain quotes, same style as the sibling node
    assert.match(body, /\$node\["prepare_conversation"\]\.json\["conversation_id"\]/);
    assert.match(OLD_CLOSE.parameters.jsonBody, /\$node\["prepare_conversation"\]\.json\["conversation_id"\]/);
    // mapping: action + params come from the validated Agent result ($json),
    // conversation_id is anchored to prepare_conversation (never the Agent)
    assert.match(body, /"action": "apply_agent_action_v3"/);
    assert.match(body, /"agent_action": \{\{ JSON\.stringify\(\$json\.action \|\| "reply"\) \}\}/);
    assert.match(body, /"agent_action_params": \{\{ JSON\.stringify\(\$json\.action_params \|\| null\) \}\}/);
  });

  test(`Apply Action V3 (${label}): body parses as JSON once the expressions resolve (live payload)`, () => {
    const resolved = node(wf, "Apply Action V3").parameters.jsonBody
      .replace(/^=/, "")
      .replace(/"\{\{ \$node\["prepare_conversation"\]\.json\["conversation_id"\] \}\}"/, '"conv-A"')
      .replace(/\{\{ JSON\.stringify\(\$json\.action \|\| "reply"\) \}\}/, '"save_contact"')
      .replace(/\{\{ JSON\.stringify\(\$json\.action_params \|\| null\) \}\}/, '{"name":"إبراهيم","phone":"0599001852"}');
    assert.deepEqual(JSON.parse(resolved), {
      action: "apply_agent_action_v3",
      conversation_id: "conv-A",
      agent_action: "save_contact",
      agent_action_params: { name: "إبراهيم", phone: "0599001852" },
    });
    // and the empty-params case stays valid JSON
    const empty = node(wf, "Apply Action V3").parameters.jsonBody
      .replace(/^=/, "")
      .replace(/"\{\{ \$node\["prepare_conversation"\]\.json\["conversation_id"\] \}\}"/, '"conv-A"')
      .replace(/\{\{ JSON\.stringify\(\$json\.action \|\| "reply"\) \}\}/, '"reply"')
      .replace(/\{\{ JSON\.stringify\(\$json\.action_params \|\| null\) \}\}/, "null");
    assert.deepEqual(JSON.parse(empty).agent_action_params, null);
  });

  test(`Apply Action V3 (${label}): a failed system action stops the run — no silent false success`, () => {
    const n = node(wf, "Apply Action V3");
    assert.notEqual(n.onError, "continueRegularOutput");
    assert.equal(n.onError, undefined);          // default = stopWorkflow, like the sibling
    assert.equal(n.alwaysOutputData, undefined); // was paired with continue-on-error
    assert.equal(OLD_CLOSE.onError, undefined);
  });
}
