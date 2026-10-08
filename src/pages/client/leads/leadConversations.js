// Loads the V2 `conversations` rows that have a captured lead, through the
// EXISTING authorized Inbox list endpoint (server-side, service-role,
// scoped to the actor's own client membership + INBOX permission):
//   GET /api/conversation?resource=list&actor_user_id=&leads_only=1&limit=200
//       [&before_last_message_at=&before_id=]
// No new API, params or schema. `conversations` is RLS-closed to the browser,
// so this is the only trustworthy source of a lead conversation's channel and
// account identity. Read-only — never mutates anything.
import { deriveConversationCursor } from "../../../lib/conversationListPagination.js";

const PAGE_LIMIT = 200; // the endpoint's own MAX_PAGE_LIMIT
const MAX_PAGES = 25; // hard bound (5,000 lead conversations)

export async function fetchLeadConversations(actorUserId, fetchImpl = fetch) {
  const byId = new Map();
  if (!actorUserId) return { status: "skipped", byId };

  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ resource: "list", actor_user_id: actorUserId, leads_only: "1", limit: String(PAGE_LIMIT) });
    if (cursor) {
      if (cursor.last_message_at) params.set("before_last_message_at", cursor.last_message_at);
      params.set("before_id", cursor.id);
    }
    let response;
    let data;
    try {
      response = await fetchImpl(`/api/conversation?${params.toString()}`);
      data = await response.json().catch(() => ({}));
    } catch {
      return { status: byId.size ? "partial" : "error", byId };
    }
    if (response.status === 401 || response.status === 403) return { status: "forbidden", byId };
    if (!response.ok || data?.success === false) return { status: byId.size ? "partial" : "error", byId };

    const rows = data.conversations || [];
    for (const row of rows) {
      if (!row?.conversation_id) continue;
      byId.set(row.conversation_id, {
        platform: row.platform || row.channel || null,
        channel_key: row.channel_key || null,
        whatsapp_instance: row.whatsapp_instance || null,
      });
    }
    if (!data.has_more || rows.length === 0) return { status: "ok", byId };
    cursor = deriveConversationCursor(rows);
    if (!cursor) return { status: "ok", byId };
  }
  return { status: "partial", byId };
}
