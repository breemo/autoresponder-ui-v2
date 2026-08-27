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

// ---------------------------------------------------------------------
// TEMPORARY DIAGNOSTIC — Locations "negative from silence" bug
// ---------------------------------------------------------------------
// Added to prove, from real Vercel runtime logs, exactly WHY the AI still
// answers a confident "no" for an unlisted location (Ramallah) when the
// business has one configured location (Nablus) and
// locations_list_complete = false — after the prompt-only fix in 807c5c0
// did NOT change the live behavior. Answers the questions the existing
// knowledgeRetrieval[DIAGNOSTIC] lines cannot: the runtime locations_list_
// complete value, the exact LOCATIONS block semantics that reached the
// model, whether 807c5c0's grounding rules are actually in the deployed
// system prompt, and whether earlier "only Nablus / no Ramallah branch"
// assistant turns are still being replayed into the OpenAI request.
//
// Pure function (context + already-built messages in, plain object out) —
// unit-tested in api/_lib/__tests__/aiContextResponse.test.js, called
// once by the handler wrapped in try/catch so it can never affect the
// response. Logged as a single line, greppable by "aiContext[LOCDIAG]".
//
// NEVER logs: secrets/keys/headers, embeddings, tokens, or customer
// message bodies from history. DOES log (all explicitly in scope per the
// debugging brief): booleans, counts, message roles, configured location
// names/cities, KB document titles/categories, the single current
// customer message (same as the existing diagnostic), and a length-capped
// preview of only ASSISTANT (AI-generated) history turns that match an
// exclusivity phrase — the specific evidence needed to confirm history
// poisoning. Remove this block, its handler call, and its tests once the
// root cause is confirmed.
const LOCDIAG_EXCLUSIVITY_PATTERN =
  /موقعنا الوحيد|فرعنا الوحيد|الفرع الوحيد|الموقع الوحيد|لا يوجد فرع|لا يوجد لدينا فرع|ليس لدينا فرع|ما في فرع|ما عنا فرع|only (one )?(branch|location)|single (branch|location)|no (other )?branch|does not have a branch/i;

export function buildLocationsDiagnostics(context, messages) {
  const client = (context && context.client) || {};
  const conversation = (context && context.conversation) || {};
  const locations = Array.isArray(client.locations) ? client.locations : [];
  const history = Array.isArray(conversation.history) ? conversation.history : [];
  const kb = Array.isArray(context && context.relevant_knowledge) ? context.relevant_knowledge : [];
  const systemMsg = (Array.isArray(messages) && messages[0] && typeof messages[0].content === "string") ? messages[0].content : "";

  const assistantExclusivityHits = history
    .map((m, index) => ({ index, role: m && m.role, content: (m && m.content) || "" }))
    .filter((m) => m.role === "assistant" && LOCDIAG_EXCLUSIVITY_PATTERN.test(m.content))
    .map((m) => ({ index: m.index, preview: m.content.slice(0, 160) }));

  return {
    conversation_id: conversation.id || null,
    client_id: client.id || null,
    current_message_text: conversation.current_message_text || "",
    locations_list_complete: client.locations_list_complete === true,
    locations_count: locations.length,
    locations: locations.map((l) => ({
      name: (l && l.name) || null,
      city: (l && l.city) || null,
      is_primary: !!(l && l.is_primary),
    })),
    system_prompt_len: systemMsg.length,
    locations_block_present: /\nLocations:\n/.test(systemMsg) || systemMsg.startsWith("Locations:\n"),
    locations_completeness_marker: systemMsg.includes("CONFIRMED COMPLETE list of every active location")
      ? "COMPLETE"
      : systemMsg.includes("this list is NOT confirmed complete")
        ? "INCOMPLETE"
        : "NONE",
    rule_single_location_present: systemMsg.includes("is NEVER by itself proof that it is the ONLY location"),
    rule_earlier_replies_present: systemMsg.includes(
      "Your earlier replies in this conversation are intentionally NOT included"
    ),
    rule_kb_address_present: systemMsg.includes("does NOT by itself mean that is the only location"),
    history_count: history.length,
    history_roles: history.map((m) => (m && m.role) || null),
    assistant_exclusivity_hit_count: assistantExclusivityHits.length,
    assistant_exclusivity_hits: assistantExclusivityHits,
    messages_total: Array.isArray(messages) ? messages.length : 0,
    // Post-fix (76218c9): the OpenAI-bound messages must be
    // [system, user, user, ...] with NO assistant turn. history_roles
    // above still shows the raw DB transcript (assistant turns included) —
    // this is what actually leaves for OpenAI.
    messages_roles: Array.isArray(messages) ? messages.map((m) => (m && m.role) || null) : [],
    kb_count: kb.length,
    kb_items: kb.map((k) => ({ document_title: (k && k.document_title) || null, category: (k && k.category) || null })),
  };
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
    const response = buildAiContextResponse(result.context);
    // TEMPORARY DIAGNOSTIC (see buildLocationsDiagnostics above) — never
    // allowed to affect the response.
    try {
      console.info("aiContext[LOCDIAG]", buildLocationsDiagnostics(result.context, response.messages));
    } catch (diagError) {
      console.warn("aiContext[LOCDIAG]: diagnostic failed", { message: diagError?.message });
    }
    return res.status(200).json(response);
  } catch (error) {
    console.error("ai-context: failed to resolve context:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "Failed to resolve AI context" });
  }
}
