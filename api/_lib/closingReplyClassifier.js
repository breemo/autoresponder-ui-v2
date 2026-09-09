// Semantic closing-confirm reply classifier.
//
// Used ONLY when a conversation is already at current_step ===
// "closing_confirm" (the customer was just asked "are you sure you're
// done?") AND the customer answered with FREE TEXT. Deterministic
// quick-reply button payloads (CLOSE_CONVERSATION / CONTINUE_CONVERSATION)
// never reach here — the n8n gate resolves those without a model call.
//
// The model does exactly one job: read the customer's latest message IN
// THAT closing-confirm context and label its MEANING as one of:
//   confirm     — agrees they are finished / fine to end the chat. A bare
//                 yes, an acknowledgement, a thank-you or a closing
//                 blessing ("يعطيكم العافية", "يسلمو", "that's all") count.
//   continue    — clearly NOT done: wants to keep going, still thinking,
//                 asks you to wait, or says they still have a question
//                 without asking it yet ("لا", "لسا", "wait", "keep going").
//   substantive — ignores the yes/no and says or asks something that needs
//                 a real answer: a question, a new request, new info
//                 ("بالمناسبة وين موقعكم؟", "كم السعر؟"). A courtesy mixed
//                 with a real question is substantive.
//
// There is NO affirmative / negative / sign-off word list here, and there
// must never be one — dialects and languages are open-ended; the model
// understands the meaning, the workflow only executes the label.
//
// Server-only, fetch()-based — same minimal-dependency discipline as
// openaiEmbeddings.js. OPENAI_API_KEY is read only from process.env,
// never logged, never echoed back in any error.
//
// SAFE DEFAULT: every failure path — no API key, empty text, network
// error, non-2xx, unparseable body, invalid JSON, unknown label, timeout
// — resolves to "substantive". A closing_confirm is never resolved as
// "confirm" on uncertainty: closing a conversation must be conservative.

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

// gpt-4o-mini — the smallest chat model already in use on this project
// (the AI-Agent-Core / VNext "OpenAI Chat Model" node). No new model,
// provider or infrastructure is introduced for this classifier.
export const CLASSIFIER_MODEL = "gpt-4o-mini";

const REQUEST_TIMEOUT_MS = 8000;

export const VALID_DECISIONS = ["confirm", "continue", "substantive"];

const SYSTEM_PROMPT = [
  "You are a classifier inside a customer-support chat system. You never talk to the customer and you never answer their question.",
  "",
  'CONTEXT: the business has just asked the customer to confirm they are finished with the conversation (an "are you done? / anything else?" question). You are given ONLY the customer\'s reply to that question.',
  "",
  "Classify the MEANING of that reply — in whatever language, dialect or register it is written — as exactly one of:",
  '- "confirm": the customer agrees they are done, or is fine to end the chat. A bare yes, a simple acknowledgement, a thank-you, or a blessing said as a closing courtesy all count as confirm.',
  '- "continue": the customer indicates they are NOT done — they want to keep going, are still thinking, ask you to wait, or say they still have something to ask without asking it yet.',
  '- "substantive": the customer ignores the yes/no and actually says or asks something that needs a real answer — a question, a new request, or a new piece of information. If the reply mixes a courtesy with a real question or request, it is substantive.',
  "",
  'Respond with ONLY a JSON object of the form {"decision":"confirm"} , {"decision":"continue"} or {"decision":"substantive"}. Nothing else.',
].join("\n");

// Always resolves { ok: true, decision, reason? } — never throws, never
// returns ok:false. `reason` is present only on a safe-default path, for
// observability; callers act on `decision` alone.
export async function classifyClosingReply(text) {
  const message = typeof text === "string" ? text.trim() : "";
  if (!message) return { ok: true, decision: "substantive", reason: "empty_input" };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: true, decision: "substantive", reason: "missing_api_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        temperature: 0,
        max_tokens: 20,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: true,
      decision: "substantive",
      reason: error && error.name === "AbortError" ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { ok: true, decision: "substantive", reason: "api_error", status: response.status };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: true, decision: "substantive", reason: "invalid_response" };
  }

  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : null;

  let parsed;
  try {
    parsed = JSON.parse(String(content));
  } catch (error) {
    return { ok: true, decision: "substantive", reason: "invalid_json" };
  }

  const decision =
    parsed && typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : null;
  if (!VALID_DECISIONS.includes(decision)) {
    return { ok: true, decision: "substantive", reason: "unknown_decision" };
  }

  return { ok: true, decision };
}
