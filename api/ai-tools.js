import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { dispatchAiTool, TOOL_ACTIONS } from "./_lib/aiTools.js";

// AI Engine V1 — AI Agent tool endpoint (single consolidated Vercel
// Function — Hobby plan function-count discipline, same reason
// api/client-router.js and api/conversation.js are consolidated).
//
// Trust model: identical to api/smart-assign-conversation.js and
// api/ai-context.js — the caller is n8n (server-to-server, the AI Agent's
// tool calls), never a browser, so there is no actor_user_id. A single
// server-only shared secret gates the endpoint. Once verified, the ONLY
// identity the body carries is conversation_id; every tool derives
// client_id / tenant / sender server-side from that conversation's own
// row (see api/_lib/aiTools.js). The Agent never sees client_id, a
// service-role key, or a generic database tool.
//
// Shape:
//   POST /api/ai-tools
//   headers: { "x-ai-tools-secret": <AI_TOOLS_SECRET> }
//   body:    { "action": "<one of TOOL_ACTIONS>", ...action params }
//            (params may also be nested under "params": { ... })
//   -> 200 { ok: true, ... }              on success
//   -> 4xx { ok: false, code, message }   on bad input / not found
//   -> 200 { ok: false, code, message }   for soft failures a tool wants
//                                          the Agent to react to (e.g.
//                                          invalid_phone) — see each
//                                          handler; `status` on the result
//                                          controls the HTTP code.
//
// Every response is deliberately small and JSON — safe to hand straight
// back to the Agent as a tool result.

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
  const action = body.action;
  if (!action || !TOOL_ACTIONS.includes(action)) {
    return res.status(400).json({ ok: false, code: "unknown_action", message: `action must be one of: ${TOOL_ACTIONS.join(", ")}` });
  }

  // Params: accept both flat ({ action, conversation_id, ... }) and nested
  // ({ action, params: { ... } }) so the n8n HTTP Request Tool can be
  // configured either way.
  const params = body.params && typeof body.params === "object" ? body.params : body;

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ ok: false, code: "server_not_configured", message: "Server is not configured" });
  }

  try {
    const result = await dispatchAiTool(supabase, { action, params });
    const status = typeof result.status === "number" ? result.status : result.ok ? 200 : 400;
    // Don't leak the internal `status` field into the Agent-facing body.
    const { status: _omit, ...bodyOut } = result;
    return res.status(status).json(bodyOut);
  } catch (error) {
    console.error("ai-tools: unhandled error", { action, code: error?.code, message: error?.message });
    return res.status(500).json({ ok: false, code: "tool_failed", message: "Tool execution failed" });
  }
}
