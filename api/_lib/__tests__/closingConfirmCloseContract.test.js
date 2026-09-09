import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSystemMessageVNext } from "../promptBuilderVNext.js";
import { dispatchAiTool, TOOL_ACTIONS } from "../aiTools.js";

// Fix A (endpoint consolidation) + Fix B (VNext close-tool contract).
//
// Live failure that motivated this: customer sent "تمام شكرا هيك خلص", the
// VNext Agent did NOT call request_conversation_close — it just narrated
// "هل أنت متأكد أنك انتهيت؟" as plain text. Result: no نعم/كمل buttons,
// no closing_confirm persisted, cc_classify never reached, and every
// following free-text reply looped the confirm prompt.
//
// The MEANING judgement (does this message mean "I'm closing"?) is the
// model's — these tests pin the CONTRACT the model is given, plus the
// deterministic machinery around it, not the model's output.

const FINAL = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_Final.json", import.meta.url), "utf8"));
const WA = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AutoResponder_WhatsApp_V2.json", import.meta.url), "utf8"));
const VNEXT = JSON.parse(fs.readFileSync(new URL("../../../engineering/n8n/working/AI-Agent-Core-VNext.json", import.meta.url), "utf8"));
const node = (wf, name) => wf.nodes.find((n) => n.name === name);

const SYS = buildSystemMessageVNext({ client: { business_name: "Acme" }, account: { platform: "whatsapp" }, ai_behavior: {} });
const CLOSE_TOOL_DESC = node(VNEXT, "request_conversation_close").parameters.toolDescription;

// ===================================================================
// Fix A — endpoint consolidation
// ===================================================================

test("the standalone /api/classify-closing-reply function no longer exists", () => {
  const p = new URL("../../classify-closing-reply.js", import.meta.url);
  assert.equal(fs.existsSync(p), false);
});

test("/api/ai-tools handles classify_closing_reply", () => {
  assert.ok(TOOL_ACTIONS.includes("classify_closing_reply"));
});

test("classify_closing_reply still resolves free-text as confirm / continue / substantive", async (t) => {
  const OF = globalThis.fetch;
  const OK = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => {
    globalThis.fetch = OF;
    if (OK === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = OK;
  });

  for (const decision of ["confirm", "continue", "substantive"]) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ decision }) } }] }),
    });
    const res = await dispatchAiTool(null, { action: "classify_closing_reply", params: { text: "أي رد" } });
    assert.deepEqual(res, { ok: true, decision });
  }

  // classifier failure -> conservative substantive (never confirm on uncertainty)
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const bad = await dispatchAiTool(null, { action: "classify_closing_reply", params: { text: "أي رد" } });
  assert.equal(bad.decision, "substantive");
});

test("cc_classify (both parents) points at /api/ai-tools with the classify_closing_reply action, degrades on error", () => {
  for (const wf of [FINAL, WA]) {
    const c = node(wf, "cc_classify");
    assert.match(c.parameters.url, /\/api\/ai-tools$/);
    assert.doesNotMatch(c.parameters.url, /classify-closing-reply/);
    assert.match(c.parameters.jsonBody, /"action":\s*"classify_closing_reply"/);
    assert.match(c.parameters.jsonBody, /"text":\s*\{\{ JSON\.stringify\(\$json\.text \|\| ""\) \}\}/);
    assert.equal(c.onError, "continueRegularOutput");
    assert.equal(c.credentials.httpHeaderAuth.id, "TBATq3Dn0WwGFqLu");
  }
});

// ===================================================================
// Fix B — VNext close-tool contract (prompt + tool description)
// ===================================================================

for (const [where, text] of [
  ["system prompt", SYS],
  ["tool description", CLOSE_TOOL_DESC],
]) {
  test(`${where}: a clear sign-off is a semantic trigger — decided from MEANING, not a word list`, () => {
    assert.match(text, /(from the meaning of the customer's own message|means they are finished and signing off)/i);
    // no baked-in vocabulary matching in the guidance
    assert.doesNotMatch(text, /if the message (contains|includes|starts with)/i);
  });

  test(`${where}: "تمام شكراً هيك خلص" (the live-failure message) is an explicit in-scope example`, () => {
    assert.match(text, /تمام شكراً هيك خلص/);
  });

  test(`${where}: courtesy in the SAME message does not cancel a close`, () => {
    assert.match(text, /(thank-you or acknowledgement in the SAME message does not cancel)/i);
  });

  test(`${where}: bare thanks/courtesy alone is NOT a forced close`, () => {
    assert.match(text, /Do NOT call it for a bare thanks(\/| or )acknowledgement with no closing signal/i);
  });

  test(`${where}: courtesy + a new question is NOT a close (answer the question instead)`, () => {
    assert.match(text, /do NOT call it when the same message also asks something new or opens a new topic/i);
    assert.match(text, /answer that instead/i);
  });

  test(`${where}: the Agent must NEVER produce the confirmation question itself`, () => {
    assert.match(text, /NEVER write that "are you sure you're done\?" question yourself/i);
    assert.match(text, /(call this tool instead|if you are about to ask it, call this tool)/i);
  });

  test(`${where}: still conservative — unsure => do not call, reply normally`, () => {
    assert.match(text, /(not sure|If you are not sure).*(do not call it|just reply normally)/is);
  });
}

test("VNext prompt: a BARE acknowledgement stays a normal turn (no closing step)", () => {
  assert.match(SYS, /A bare thanks or acknowledgement on its own/i);
  assert.match(SYS, /Do not start any closing step for it/i);
});

test("promptBuilderVNext source carries NO close-detection word/phrase list", () => {
  const src = fs.readFileSync(new URL("../promptBuilderVNext.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /CLOSE_WORDS|SIGNOFF_WORDS|CLOSING_PHRASES/);
  assert.doesNotMatch(src, /\.(includes|startsWith)\(\s*["'`](خلص|bye|done)/i);
});

// ===================================================================
// Fix B — the confirmation prompt + buttons belong to the machinery
// (parent normalize_core_result), never the model
// ===================================================================

function runNormalizeCore(wf, { sub, baseText = "", integration = {}, prep = {} }) {
  const code = node(wf, "normalize_core_result").parameters.jsCode;
  const $items = (n) => {
    if (n === "Code in JavaScript1") return [{ json: { platform: "facebook", channelKey: "k", text: baseText, sender_id: "s" } }];
    if (n === "client_feature") return [{ json: { client_id: "c1", config: {}, clients: {}, ...integration } }];
    if (n === "prepare_conversation") return [{ json: { conversation_id: "cv1", conversation_status: "active", current_step: null, ...prep } }];
    return [];
  };
  return new Function("$items", "$json", code)($items, sub)[0].json;
}

// The full closing-confirm contract that normalize_core_result MUST emit
// once the close tool has run, regardless of the tool-observation shape.
function assertClosingConfirmContract(out, { arabic }) {
  assert.equal(out.action, "close_needs_confirmation");
  assert.equal(out.current_step, "closing_confirm");
  assert.equal(out.next_step, "closing_confirm");
  assert.equal(out.quick_reply_action, "closing_confirm");
  assert.deepEqual(
    out.quick_replies.map((q) => q.payload),
    ["CLOSE_CONVERSATION", "CONTINUE_CONVERSATION"]
  );
  assert.deepEqual(
    out.quick_replies.map((q) => q.title),
    ["نعم", "كمل المحادثة"]
  );
  if (arabic) {
    assert.match(out.reply, /[؀-ۿ]/);
    assert.match(out.reply, /حابب أتأكد/);
  } else {
    assert.doesNotMatch(out.reply, /[؀-ۿ]/);
    assert.match(out.reply, /Just to confirm/i);
  }
  // a close REQUEST keeps the conversation active (only a CONFIRMED close,
  // handled deterministically elsewhere, moves it to waiting_human)
  assert.equal(out.conversation_status, "active");
}

// The exact live failure: close tool executed (action derives from the
// tool NAME and is reliable), but the langchain tool observation was
// malformed / unparseable, so quick_reply_action + current_step arrived
// null, and the model produced a chatty non-canonical wrap-up line.
const LIVE_FAILURE_SUB = {
  reply: "تمام 👍 طلبك أكيد — إذا حابب تكمل ولا عندك أي شي ثاني بس اكتب رسالة.",
  intent: "closing",
  action: "close_needs_confirmation",
  quick_reply_action: null,
  current_step: null,
  conversation_status: null,
};

// A clean, fully-populated observation.
const VALID_OBS_SUB = {
  reply: "sure",
  intent: "closing",
  action: "close_needs_confirmation",
  quick_reply_action: "closing_confirm",
  conversation_status: "active",
  current_step: "closing_confirm",
};

for (const [label, wf] of [["Final", FINAL], ["WhatsApp", WA]]) {
  test(`${label}: LIVE FAILURE — tool executed, observation unparseable, model wrote a conversational reply -> full closing-confirm contract is still forced`, () => {
    const out = runNormalizeCore(wf, { sub: LIVE_FAILURE_SUB, baseText: "تمام شكرا هيك خلص" });
    assert.notEqual(out.reply, LIVE_FAILURE_SUB.reply); // the model's line must NOT win
    assertClosingConfirmContract(out, { arabic: true });
  });

  test(`${label}: observation missing ONLY quick_reply_action still forces the whole contract`, () => {
    const out = runNormalizeCore(wf, {
      sub: { reply: "ok", intent: "closing", action: "close_needs_confirmation", current_step: null, quick_reply_action: null, conversation_status: "active" },
      baseText: "that's all, thanks",
    });
    assertClosingConfirmContract(out, { arabic: false });
  });

  test(`${label}: close signalled only via the embedded reply object still forces the contract`, () => {
    const out = runNormalizeCore(wf, {
      sub: { reply: JSON.stringify({ action: "close_needs_confirmation", reply: "خلص، شكرًا" }), intent: "unknown", conversation_status: null },
      baseText: "خلص",
    });
    assertClosingConfirmContract(out, { arabic: true });
  });

  test(`${label}: a VALID observation behaves identically (same forced contract)`, () => {
    const out = runNormalizeCore(wf, { sub: VALID_OBS_SUB, baseText: "ok thanks that's all" });
    assert.notEqual(out.reply, VALID_OBS_SUB.reply); // still machinery-owned
    assertClosingConfirmContract(out, { arabic: false });
  });

  test(`${label}: a NON-close AI turn is completely untouched — model reply passes through, no step, no buttons`, () => {
    const out = runNormalizeCore(wf, {
      sub: { reply: "We're open 9–5.", intent: "knowledge", action: null, quick_reply_action: null, conversation_status: "active", current_step: null },
      baseText: "what are your hours?",
    });
    assert.equal(out.reply, "We're open 9–5.");
    assert.equal(out.quick_replies, null);
    assert.equal(out.quick_reply_action, null);
    assert.equal(out.current_step, null);
    assert.equal(out.action, null);
  });

  test(`${label}: a handover turn is untouched by the closing-confirm forcing`, () => {
    const out = runNormalizeCore(wf, {
      sub: { reply: "A teammate will follow up.", intent: "human_request", action: "human_handover", quick_reply_action: null, conversation_status: "waiting_human", current_step: null },
      baseText: "بدي احكي مع موظف",
    });
    assert.equal(out.action, "human_handover");
    assert.equal(out.current_step, null);
    assert.equal(out.quick_replies, null);
    assert.equal(out.conversation_status, "waiting_human");
  });

  test(`${label}: normalize_core_result keys the contract on the tool RESULT, not on message text`, () => {
    const code = node(wf, "normalize_core_result").parameters.jsCode;
    // the trigger is the normalized action, never a phrase/word scan of base.text
    assert.match(code, /const closeRequested\s*=\s*\n?\s*coreAction === "close_needs_confirmation"/);
    assert.doesNotMatch(code, /base\.text.*(خلص|bye|done|thanks|شكرا)/i);
  });
}

// ===================================================================
// Final / WhatsApp parity
// ===================================================================

test("Final and WhatsApp are byte-identical on the whole closing-confirm surface", () => {
  for (const n of ["closing_confirm_gate", "cc_route", "cc_classify", "cc_decision", "closing_confirm_switch", "normalize_core_result"]) {
    assert.deepEqual(node(FINAL, n).parameters, node(WA, n).parameters, `${n} parameters identical`);
  }
});
