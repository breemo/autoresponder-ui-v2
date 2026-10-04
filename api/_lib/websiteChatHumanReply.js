// Website Chat employee replies (called from api/_lib/humanReply.js AFTER its
// existing authorization + Human Takeover ownership checks).
//
// website_chat has no external provider: the reply is persisted directly as
// an outbound `human` message on the conversation, and the visitor's widget
// receives it by polling (shown as "Team"). Every other platform keeps the
// unchanged n8n Human Reply path.

// Returns { isWebsiteChat, senderId } for a conversation already scoped to
// the actor's client. Any lookup problem -> { isWebsiteChat: false } so the
// existing (non-Website-Chat) path is never blocked by this check.
export async function resolveWebsiteChatReplyTarget(supabase, clientId, conversationId) {
  try {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .select("id, client_id, platform, channel_identity_id")
      .eq("id", conversationId)
      .eq("client_id", clientId)
      .maybeSingle();
    if (error || !conversation || conversation.platform !== "website_chat") return { isWebsiteChat: false };

    const { data: identity, error: identityError } = await supabase
      .from("contact_channel_identities")
      .select("id, sender_id")
      .eq("id", conversation.channel_identity_id)
      .eq("client_id", clientId)
      .maybeSingle();
    if (identityError || !identity?.sender_id) return { isWebsiteChat: true, senderId: null };
    return { isWebsiteChat: true, senderId: identity.sender_id };
  } catch {
    return { isWebsiteChat: false };
  }
}

// Same row shape the n8n Human Reply workflow's `insert message` writes for
// other channels (text only — Website Chat media is not supported in MVP).
export function buildWebsiteChatHumanReplyRow({ clientId, conversationId, senderId, message, sentByUserId }) {
  return {
    client_id: clientId,
    channel: "website_chat",
    sender: senderId,
    message,
    direction: "outbound",
    reply_source: "human",
    sent_by_user_id: sentByUserId || null,
    conversation_id: conversationId,
    message_type: "text",
  };
}

export async function persistWebsiteChatHumanReply(supabase, row) {
  const { error } = await supabase.from("messages").insert(row);
  return !error;
}
