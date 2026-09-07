// The single authoritative "can this employee send a human outbound
// message on this conversation" read, shared by every employee outbound
// gate (api/_lib/humanReply.js — send a text/media reply; api/media.js
// action "sign_upload" — mint the Storage upload URL for a reply
// attachment).
//
// ---------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------
// Conversation Lifecycle V2 (supabase/migrations/20260825_conversation_lifecycle_v2.sql)
// made public.conversations the AUTHORITATIVE table for conversation_status
// and assigned_user_id: apply_conversation_lifecycle_action writes it in
// every 'ok' path (accept / solve / reopen) and only mirrors
// conversation_state as a "best-effort compatibility dual-write". The
// Inbox frontend already reads ownership from public.conversations first
// (api/_lib/conversationsList.js: `row.assigned_user_id ?? state...`), and
// the claim/close endpoints already act on public.conversations.
//
// The send-a-reply and attach-media gates, however, still read
// conversation_state directly. When the dual-write to conversation_state
// lags or fails — or the conversation was reopened by the resolver, which
// updates public.conversations but not conversation_state — the two
// disagree: the composer is enabled (frontend saw `conversations` = "I own
// it") but POST /api/conversation (human_reply) rejects with
// "يجب استلام المحادثة أولاً" (backend saw stale `conversation_state`).
// This helper closes that gap by reading the same authoritative table the
// frontend and the lifecycle RPCs use, with conversation_state kept only
// as a fallback for a pre-V2 conversation that has no conversations row.
//
// Returns:
//   { found: false }                              — no such conversation for this client
//   { found: true, source, conversation_id,
//     conversation_status, assigned_user_id }      — authoritative snapshot
export async function loadConversationGate(supabase, clientId, conversationId) {
  const { data: conv, error: convError } = await supabase
    .from("conversations")
    .select("id, conversation_status, assigned_user_id")
    .eq("client_id", clientId)
    .eq("id", conversationId)
    .maybeSingle();
  if (convError) throw convError;

  if (conv) {
    return {
      found: true,
      source: "conversations",
      conversation_id: conv.id,
      conversation_status: conv.conversation_status || "active",
      assigned_user_id: conv.assigned_user_id ?? null,
    };
  }

  // Fallback: a conversation that predates Conversation Model V2 has no
  // public.conversations row — its lifecycle still lives in conversation_state.
  const { data: state, error: stateError } = await supabase
    .from("conversation_state")
    .select("conversation_id, conversation_status, assigned_user_id")
    .eq("client_id", clientId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (stateError) throw stateError;

  if (!state) return { found: false };

  return {
    found: true,
    source: "conversation_state",
    conversation_id: state.conversation_id,
    conversation_status: state.conversation_status || "active",
    assigned_user_id: state.assigned_user_id ?? null,
  };
}

// The shared "may this employee send a human outbound message" rule.
//
// Human outbound (text reply OR media) is permitted ONLY when the
// conversation is actually in human-handling mode AND owned by the acting
// employee:
//
//     conversation_status === 'waiting_human'
//     AND assigned_user_id === actorUserId
//
// Everything else is blocked:
//   - 'active' (or any other AI/Auto-driven status) -> automation owns the
//     conversation. An active conversation is NOT sendable just because it
//     currently has no owner — this is the fix for the resolver's
//     customer-triggered auto-reopen (and any normal AI conversation),
//     which leaves conversation_status='active', assigned_user_id=null.
//     The employee must use Transfer to Agent (-> waiting_human) then
//     Claim/Accept (-> assigned) first.
//   - 'waiting_human' with a different owner -> another employee has it.
//   - 'waiting_human' with no owner -> Claim/Accept first (shared queue).
//   - 'closed' -> reopen first.
//
// assigned_user_id is the ONLY ownership signal. system_assigned_user_id
// (a Smart Assignment RECOMMENDATION) is never consulted here and never
// grants send permission — loadConversationGate does not even read it.
//
// Returns null when allowed, or { message, code } (message is Arabic,
// caller-facing) when blocked.
export function humanTakeoverBlock(gate, actorUserId) {
  if (!gate?.found) return null; // caller returns its own 404

  const status = gate.conversation_status;

  if (
    status === "waiting_human" &&
    gate.assigned_user_id &&
    gate.assigned_user_id === actorUserId
  ) {
    return null;
  }

  if (status === "closed") {
    return { code: "CONVERSATION_CLOSED", message: "المحادثة مغلقة. أعد فتحها أولاً لإرسال رسالة." };
  }

  if (status === "waiting_human") {
    return gate.assigned_user_id
      ? { code: "ASSIGNED_TO_OTHER", message: "هذه المحادثة مستلمة بواسطة موظف آخر" }
      : { code: "MUST_CLAIM_FIRST", message: "يجب استلام المحادثة أولاً" };
  }

  // 'active' or any other AI/Auto-driven status.
  return {
    code: "AUTOMATION_HANDLING",
    message: "هذه المحادثة يديرها الرد الآلي حالياً. استخدم «تحويل إلى موظف» ثم «استلام المحادثة» للرد يدوياً.",
  };
}
