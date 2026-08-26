import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveAiContext } from "./_lib/aiContext.js";

// AI Engine V1 — Phase 3: authoritative AI Context endpoint.
//
// Trust model — same shape as api/smart-assign-conversation.js (the
// existing "caller is not a human browser session" precedent in this
// app): there is no human actor here, the caller is n8n (server-to-
// server), so this is protected by a shared secret header rather than
// the actor_user_id/resolveActingMembership pattern every browser-facing
// endpoint uses. Once the secret is verified, conversation_id/client_id
// are STILL never trusted blindly — see api/_lib/aiContext.js's full
// identity-validation chain (conversation_id is the only real anchor;
// client_id is checked against the conversation's own row, not used to
// select data directly).
//
// This endpoint does NOT build or return OpenAI prompt messages — that
// is api/_lib/promptBuilder.js's job, kept as a separate, DB-query-free
// module per the Phase 3 spec (§10: "must NOT perform DB queries
// itself"). Wiring prompt-building into this endpoint's response, or
// into the actual OpenAI call, is a workflow-cutover-phase decision, not
// made here.
//
// Shape:
//   POST /api/ai-context
//   headers: { "x-ai-context-secret": <AI_CONTEXT_SECRET> }
//   body: { conversation_id, client_id, current_message_text }
//   -> { success: true, context: {...} }  (see api/_lib/aiContext.js for
//      the exact normalized shape)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const providedSecret = req.headers["x-ai-context-secret"];
  const expectedSecret = process.env.AI_CONTEXT_SECRET;
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const conversationId = req.body?.conversation_id;
  const clientId = req.body?.client_id;
  const currentMessageText = req.body?.current_message_text;

  try {
    const result = await resolveAiContext(supabase, { conversationId, clientId, currentMessageText });
    if (!result.ok) {
      // Generic messages only — never echoes back which part of the
      // input was wrong beyond what the status code itself implies (see
      // aiContext.js's own comment on why client_mismatch and not_found
      // are deliberately not distinguished in the response body).
      return res.status(result.status).json({ success: false, message: result.message, code: result.code });
    }
    return res.status(200).json({ success: true, context: result.context });
  } catch (error) {
    console.error("ai-context: failed to resolve context:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "Failed to resolve AI context" });
  }
}
