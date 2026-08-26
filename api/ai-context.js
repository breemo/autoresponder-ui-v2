import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveAiContext } from "./_lib/aiContext.js";
import { buildPromptMessages } from "./_lib/promptBuilder.js";

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
// Workflow Cutover — Step 1: this endpoint now ALSO returns the
// already-built OpenAI chat messages (system + history + current user),
// produced by api/_lib/promptBuilder.js's buildPromptMessages() — the
// same pure, DB-query-free module used everywhere else. resolveAiContext()
// itself is untouched; buildPromptMessages() is called once, here, on its
// already-resolved `context`, so n8n (or any future caller) never needs
// to duplicate prompt-building logic — it just sends `messages` straight
// to the OpenAI chat-completions call.
//
// Shape:
//   POST /api/ai-context
//   headers: { "x-ai-context-secret": <AI_CONTEXT_SECRET> }
//   body: { conversation_id, client_id, current_message_text }
//   -> { success: true, context: {...}, messages: [...] }
//      (see api/_lib/aiContext.js for the exact normalized `context`
//      shape, and api/_lib/promptBuilder.js for the exact `messages`
//      shape — [system, ...history, current user])

// Pure — no DB/network involved, so it's directly unit-testable
// (api/_lib/__tests__/aiContextResponse.test.js) without a real Supabase
// client. Kept as a named export purely so the handler's exact response
// shape can be verified without going through getSupabaseServerClient()'s
// real-credentials requirement.
export function buildAiContextResponse(context) {
  return { success: true, context, messages: buildPromptMessages(context) };
}

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
    return res.status(200).json(buildAiContextResponse(result.context));
  } catch (error) {
    console.error("ai-context: failed to resolve context:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "Failed to resolve AI context" });
  }
}
