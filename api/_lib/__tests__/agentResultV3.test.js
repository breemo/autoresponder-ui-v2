import test from "node:test";
import assert from "node:assert/strict";
import { validateAgentResultV3, V3_ACTIONS, V3_ACTION_EFFECT } from "../agentResultV3.js";

// AI Engine V3 — the ONE structured contract. The only hard guarantee:
// an invalid / empty / ambiguous Agent result can NEVER carry a lifecycle
// action. Everything unsafe degrades to a plain reply.

test("the action vocabulary is exactly the five agreed values", () => {
  assert.deepEqual([...V3_ACTIONS].sort(), ["close_conversation", "handover", "reply", "request_confirmation", "save_contact"].sort());
  assert.equal(V3_ACTION_EFFECT.reply, null);
});

test("a clean reply object passes through, normalized", () => {
  const { ok, result } = validateAgentResultV3({
    action: "reply",
    reply: "  أهلاً، كيف بقدر أساعدك؟  ",
    action_params: { junk: "x" },
    options: [],
    intent: "greeting",
  });
  assert.equal(ok, true);
  assert.equal(result.action, "reply");
  assert.equal(result.reply, "أهلاً، كيف بقدر أساعدك؟");
  assert.deepEqual(result.action_params, {}); // unknown keys dropped
  assert.deepEqual(result.options, []);
  assert.equal(result.intent, "greeting");
});

test("each non-reply action is accepted with its params", () => {
  const h = validateAgentResultV3({ action: "handover", reply: "رح أحولك لموظف.", action_params: { reason: "شكوى", extra: 1 } });
  assert.equal(h.result.action, "handover");
  assert.deepEqual(h.result.action_params, { reason: "شكوى" });

  const s = validateAgentResultV3({ action: "save_contact", reply: "سجلت بياناتك.", action_params: { name: "علي", phone: "0599123456" } });
  assert.deepEqual(s.result.action_params, { name: "علي", phone: "0599123456" });

  const c = validateAgentResultV3({ action: "request_confirmation", reply: "متأكد إنك خلصت؟", options: ["نعم", "كمل", "لأ", "رابع", "خامس"] });
  assert.equal(c.result.action, "request_confirmation");
  assert.deepEqual(c.result.options, ["نعم", "كمل", "لأ"]); // capped at 3

  const x = validateAgentResultV3({ action: "close_conversation", reply: "شكراً لتواصلك معنا 🙏" });
  assert.equal(x.result.action, "close_conversation");
});

test("a raw JSON string (even wrapped in prose / a fence) is parsed", () => {
  const wrapped = 'Here is my answer:\n```json\n{"action":"reply","reply":"سعر الكشف 50 شيكل","intent":"pricing"}\n```\nHope that helps.';
  const { ok, result } = validateAgentResultV3(wrapped);
  assert.equal(ok, true);
  assert.equal(result.reply, "سعر الكشف 50 شيكل");
  assert.equal(result.intent, "pricing");
});

test("an unknown action value is downgraded to reply (never executed)", () => {
  const { result } = validateAgentResultV3({ action: "delete_everything", reply: "..." });
  assert.equal(result.action, "reply");
});

test("a non-reply action with NO reply text is unsafe -> reply fallback, ok:false", () => {
  for (const action of ["handover", "close_conversation", "save_contact", "request_confirmation"]) {
    const { ok, result } = validateAgentResultV3({ action, reply: "   " }, { fallbackReply: "عذراً، صار خطأ." });
    assert.equal(ok, false);
    assert.equal(result.action, "reply");
    assert.equal(result.reply, "عذراً، صار خطأ.");
  }
});

test("garbage input -> safe reply with the fallback text, NEVER a lifecycle action", () => {
  for (const bad of ["", "not json at all", "{ broken", null, undefined, 42, [], { nope: true }, '{"action":"handover"}']) {
    const { ok, result } = validateAgentResultV3(bad, { fallbackReply: "تقنيّاً في مشكلة، جرّب بعد شوي." });
    assert.equal(result.action, "reply");
    assert.notEqual(result.action, "handover");
    assert.notEqual(result.action, "close_conversation");
    if (!ok) assert.ok(typeof result.reply === "string");
  }
});

test("oversized fields are bounded", () => {
  const { result } = validateAgentResultV3({
    action: "reply",
    reply: "x".repeat(9000),
    options: ["y".repeat(200)],
    action_params: { reason: "z".repeat(2000) },
    intent: "i".repeat(500),
  });
  assert.ok(result.reply.length <= 4000);
  assert.ok(result.options[0].length <= 40);
  assert.ok(result.action_params.reason.length <= 400);
  assert.ok(result.intent.length <= 60);
});

test("intent defaults to \"unknown\" and never affects the action", () => {
  const { result } = validateAgentResultV3({ action: "reply", reply: "hi" });
  assert.equal(result.intent, "unknown");
});
