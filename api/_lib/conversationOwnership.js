// The single authoritative "can this employee act on this conversation"
// read, shared by every gate that enforces Human Takeover ownership
// (api/_lib/humanReply.js — send a reply; api/media.js action "sign_upload"
// — attach media to a reply).
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

// The shared ownership rule: a conversation in the human queue
// (waiting_human) may only be acted on by its assigned employee — and if
// nobody has claimed it yet (assigned_user_id null), nobody may act until
// someone does. Any other status has no owner concept and is unrestricted.
// Returns null when allowed, or { message } (Arabic, caller-facing) when
// blocked — identical wording to what humanReply.js / media.js returned
// before, so no UI copy changes.
export function humanTakeoverBlock(gate, actorUserId) {
  if (!gate?.found) return null;
  if (gate.conversation_status !== "waiting_human") return null;
  if (gate.assigned_user_id === actorUserId) return null;
  return {
    message: gate.assigned_user_id
      ? "هذه المحادثة مستلمة بواسطة موظف آخر"
      : "يجب استلام المحادثة أولاً",
  };
}
