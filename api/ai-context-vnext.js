import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveAiContext } from "./_lib/aiContext.js";
import { buildPromptMessagesVNext } from "./_lib/promptBuilderVNext.js";

// AI-Agent-Core VNext — reliable-context endpoint.
//
// A thin, isolated sibling of api/ai-context.js used ONLY by the
// experimental engineering/n8n/working/AI-Agent-Core-VNext.json workflow.
// api/ai-context.js and the legacy Core are completely untouched — this is
// the rollback-safe way to try the simplified architecture.
//
// Two differences from /api/ai-context:
//   1. resolveAiContext() is called with useContextualRetrieval: false —
//      Knowledge Base pre-retrieval uses the RAW current customer message
//      only, with NO isLikelyFollowUp / previous-turn / demonstrative
//      query rewriting. The Agent itself resolves conversational
//      references and calls search_business_knowledge when it needs more.
//   2. `messages` is built by promptBuilderVNext (a leaner, business-type
//      agnostic system prompt) instead of the legacy promptBuilder.
//
// Trust model, identity-validation chain and shared-secret header are
// identical to /api/ai-context (same AI_CONTEXT_SECRET,
// x-ai-context-secret). resolveAiContext() enforces the tenant/identity
// checks server-side exactly as before.
//
// Shape:
//   POST /api/ai-context-vnext
//   headers: { "x-ai-context-secret": <AI_CONTEXT_SECRET> }
//   body: { conversation_id, client_id, current_message_text }
//   -> { success: true, context: {...}, messages: [system, ...transcript, current user] }

// Pure (context in, response out) — unit-testable without a Supabase
// client, same pattern as api/ai-context.js's buildAiContextResponse.
export function buildAiContextVNextResponse(context) {
  return { success: true, context, messages: buildPromptMessagesVNext(context) };
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
    const result = await resolveAiContext(supabase, {
      conversationId,
      clientId,
      currentMessageText,
      useContextualRetrieval: false,
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message, code: result.code });
    }
    return res.status(200).json(buildAiContextVNextResponse(result.context));
  } catch (error) {
    console.error("ai-context-vnext: failed to resolve context:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "Failed to resolve AI context" });
  }
}
