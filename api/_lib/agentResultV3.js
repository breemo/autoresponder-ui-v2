// Auto Responder — AI Engine V3.
//
// The ONE structured contract between the single General Agent and the
// deterministic Apply-Action layer. The Agent returns exactly one JSON
// object; this module parses + validates it and — critically — NEVER lets
// an invalid, empty or ambiguous result mutate lifecycle state. Every
// failure path degrades to a plain `reply` with no system action.
//
// The n8n `Validate Structured Output` node (AI-Agent-Core-V3.json)
// inlines an equivalent of `validateAgentResultV3`; the cross-check test
// (api/_lib/__tests__/aiEngineV3.test.js) keeps the two in sync. The
// backend re-validates in `applyAgentActionV3` (api/_lib/aiTools.js) as
// defense in depth, so a drifted inline copy still cannot execute a bogus
// action.

// The complete action vocabulary. Anything else is treated as "reply".
export const V3_ACTIONS = ["reply", "handover", "save_contact", "request_confirmation", "close_conversation"];

// action -> the deterministic system effect the parent's Apply Action
// performs (null = send the reply, touch nothing).
export const V3_ACTION_EFFECT = {
  reply: null,
  handover: "request_handover",
  save_contact: "upsert_lead",
  request_confirmation: "close_needs_confirmation", // persists current_step = closing_confirm
  close_conversation: "close_confirmed", // waiting_human + closing_confirmed
};

const MAX_REPLY = 4000;
const MAX_OPTION = 40;
const MAX_OPTIONS = 3;
const MAX_PARAM = 400;
const PARAM_KEYS = ["name", "phone", "reason"];

function str(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function safe(replyText) {
  return { action: "reply", reply: replyText || "", action_params: {}, options: [], intent: "unknown" };
}

// Always returns { ok, result } where `result` is a fully-formed, safe V3
// object. ok:false means the raw input was unusable / unsafe and `result`
// is the conservative fallback (plain reply, no action).
//
// `raw` may be the Agent's already-parsed object OR its raw string output
// (tolerates a leading/trailing prose wrapper or a ```json fence).
export function validateAgentResultV3(raw, { fallbackReply = "" } = {}) {
  let obj = raw;

  if (typeof raw === "string") {
    const s = raw.trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    // No JSON at all — the model answered in plain prose. Send that (it is
    // usually a real answer), not the technical fallback.
    if (start === -1 || end === -1 || end <= start) {
      return { ok: false, result: safe(s || fallbackReply) };
    }
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch {
      return { ok: false, result: safe(s || fallbackReply) };
    }
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, result: safe(typeof raw === "string" ? raw.trim() || fallbackReply : fallbackReply) };
  }

  const reply = str(obj.reply != null ? obj.reply : obj.message != null ? obj.message : obj.text, MAX_REPLY);

  let action = typeof obj.action === "string" ? obj.action.trim().toLowerCase() : "reply";
  if (!V3_ACTIONS.includes(action)) action = "reply";

  // A non-reply action with no customer-facing text is unsafe (the
  // customer would get a silent lifecycle change) -> downgrade to reply.
  if (action !== "reply" && !reply) {
    return { ok: false, result: safe(fallbackReply || "") };
  }

  const rawParams =
    obj.action_params && typeof obj.action_params === "object" && !Array.isArray(obj.action_params)
      ? obj.action_params
      : {};
  const action_params = {};
  for (const key of PARAM_KEYS) {
    const val = str(rawParams[key], MAX_PARAM);
    if (val) action_params[key] = val;
  }
  // save_contact carries one optional boolean: whether the customer
  // explicitly wants a human to follow up. The Agent decides it
  // semantically; we only pass the flag through so the executor can chain
  // the existing handover after a successful save.
  if (action === "save_contact" && (rawParams.handover_after_save === true || rawParams.handover_after_save === "true")) {
    action_params.handover_after_save = true;
  }

  const options = [];
  for (const o of Array.isArray(obj.options) ? obj.options : []) {
    const val = str(o, MAX_OPTION);
    if (val) options.push(val);
    if (options.length >= MAX_OPTIONS) break;
  }

  const intent = str(obj.intent, 60) || "unknown";

  return {
    ok: true,
    result: { action, reply: reply || fallbackReply || "", action_params, options, intent },
  };
}
