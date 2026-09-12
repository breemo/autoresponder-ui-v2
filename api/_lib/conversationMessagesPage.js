// Message Pagination / Load Older Messages — read path only.
//
// Additive, opt-in extension of the existing GET /api/conversation
// ?resource=messages endpoint (api/conversation.js). When the caller omits
// `limit`, the endpoint behaves EXACTLY as before this feature (full
// history, no `has_more`) — this module is only ever invoked when `limit`
// is present. No schema/migration change: every filter here uses columns
// (`client_id`, `conversation_id`, `created_at`, `id`) the table already
// exposes and this endpoint already selects.
//
// Cursor: the composite tuple (created_at, id) — never created_at alone.
// Two messages can legitimately share the exact same created_at; id is
// the deterministic tiebreaker so a page can never skip or duplicate a
// row regardless of how many rows share a timestamp. Works whether `id`
// is a uuid or a numeric type — it's only ever used as an opaque, total
// ordering, never interpreted.
//
// Three modes, selected by which params are present:
//   - neither before_* nor after_*  -> initial page: the newest `limit`
//     messages.
//   - before_created_at + before_id -> "Load older": the next page
//     strictly BEFORE that cursor.
//   - after_created_at  + after_id  -> polling/delta: everything strictly
//     AFTER that cursor (used to append newly arrived messages without
//     ever re-fetching or discarding already-loaded history).

export const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 200;
// Safety cap only — far above how many messages could realistically land
// in one 5s poll interval or one post-send follow-up window. Never limits
// normal operation; exists purely so a pathological burst can't return an
// unbounded response.
const AFTER_QUERY_SAFETY_LIMIT = 500;

const ID_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidCursorId(id) {
  return typeof id === "string" && ID_TOKEN_RE.test(id);
}

export function isValidCursorCreatedAt(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

export function normalizePageLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_PAGE_LIMIT);
}

// PostgREST composite-cursor filter for supabase-js `.or(...)`, expressing
// the tuple comparison (created_at, id) < / > (createdAt, id) as
// `created_at OP val OR (created_at = val AND id OP val)`. Values are
// always quoted (PostgREST's own recommendation for values that may
// contain characters significant to its filter grammar) and are only ever
// built from inputs already checked by isValidCursorCreatedAt/
// isValidCursorId above, so no comma/paren/quote can reach this string.
export function buildOlderThanFilter(createdAt, id) {
  return `created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt."${id}")`;
}

export function buildNewerThanFilter(createdAt, id) {
  return `created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt."${id}")`;
}

// Trims a DESC-fetched (limit+1) page down to `limit` rows, derives
// has_more from whether that extra row was actually present, and returns
// the page in ascending chronological order — the shape both the initial
// page and an older page share. Never mutates the input array.
export function toAscendingPage(descRows, limit) {
  const rows = Array.isArray(descRows) ? descRows : [];
  const has_more = rows.length > limit;
  const trimmed = (has_more ? rows.slice(0, limit) : rows.slice()).reverse();
  return { messages: trimmed, has_more };
}

// Runs the actual Supabase query for whichever mode the params select and
// returns a uniform { ok, status, message, messages, has_more } result.
// clientId/conversationId are assumed already resolved/authorized by the
// caller (api/conversation.js) — this function only builds and runs the
// query.
export async function fetchConversationMessagesPage(
  supabase,
  { clientId, conversationId, limit, beforeCreatedAt, beforeId, afterCreatedAt, afterId }
) {
  const hasBefore = beforeCreatedAt !== undefined || beforeId !== undefined;
  const hasAfter = afterCreatedAt !== undefined || afterId !== undefined;

  if (hasBefore && hasAfter) {
    return { ok: false, status: 400, message: "before_* and after_* cursors are mutually exclusive" };
  }

  if (hasAfter) {
    if (!isValidCursorCreatedAt(afterCreatedAt) || !isValidCursorId(afterId)) {
      return { ok: false, status: 400, message: "Invalid after cursor" };
    }
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("client_id", clientId)
      .eq("conversation_id", conversationId)
      .or(buildNewerThanFilter(afterCreatedAt, afterId))
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(AFTER_QUERY_SAFETY_LIMIT);
    if (error) return { ok: false, status: 500, message: "DB_ERROR", error };
    // No pagination concept going forward from "now" — every row strictly
    // newer than the cursor is returned (up to the safety cap above).
    return { ok: true, status: 200, messages: data || [], has_more: false };
  }

  if (hasBefore && (!isValidCursorCreatedAt(beforeCreatedAt) || !isValidCursorId(beforeId))) {
    return { ok: false, status: 400, message: "Invalid before cursor" };
  }

  const pageLimit = normalizePageLimit(limit);

  let query = supabase.from("messages").select("*").eq("client_id", clientId).eq("conversation_id", conversationId);
  if (hasBefore) {
    query = query.or(buildOlderThanFilter(beforeCreatedAt, beforeId));
  }
  query = query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageLimit + 1);

  const { data, error } = await query;
  if (error) return { ok: false, status: 500, message: "DB_ERROR", error };

  const { messages, has_more } = toAscendingPage(data, pageLimit);
  return { ok: true, status: 200, messages, has_more };
}
