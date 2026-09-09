import { classifyClosingReply } from "./_lib/closingReplyClassifier.js";

// Semantic closing-confirm reply classifier endpoint.
//
// Called by the n8n parent workflows (AutoResponder_Final /
// AutoResponder_WhatsApp_V2) from their `cc_classify` node, and ONLY when
// a conversation is at current_step === "closing_confirm" and the customer
// answered the "are you done?" question with free text. Button payloads
// are resolved deterministically in the workflow and never hit this route.
//
// Trust model: identical to /api/ai-tools — the caller is n8n
// (server-to-server), never a browser, so there is no actor identity. One
// server-only shared secret (the same AI_TOOLS_SECRET) gates the endpoint.
//
//   POST /api/classify-closing-reply
//   headers: { "x-ai-tools-secret": <AI_TOOLS_SECRET> }
//   body:    { "text": "<customer's latest message>" }
//   -> 200 { ok: true, decision: "confirm" | "continue" | "substantive" }
//
// classifyClosingReply never throws and always yields a decision; on any
// failure it returns the conservative "substantive" so the workflow never
// closes a conversation on uncertainty.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, code: "method_not_allowed", message: "Method not allowed" });
  }

  const providedSecret = req.headers["x-ai-tools-secret"];
  const expectedSecret = process.env.AI_TOOLS_SECRET;
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ ok: false, code: "unauthorized", message: "Unauthorized" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = typeof body.text === "string" ? body.text : "";

  const result = await classifyClosingReply(text);
  return res.status(200).json({ ok: true, decision: result.decision });
}
