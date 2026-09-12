// Conversation List Pagination — pure merge/cursor helpers.
//
// No React/DOM dependency, mirroring src/lib/messagePagination.js. Every
// function here is a pure array transform: given the same inputs, always
// the same output, never touches state/refs/the DOM itself.

// Newest first, matching the server's own ORDER BY last_message_at DESC
// NULLS LAST, id DESC — a null last_message_at (a conversation with no
// message yet) always sorts last, tiebroken by conversation_id.
function compareByLastMessageAtDesc(a, b) {
  const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : null;
  const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : null;
  if (aTime === null && bTime === null) {
    return a.conversation_id < b.conversation_id ? 1 : a.conversation_id > b.conversation_id ? -1 : 0;
  }
  if (aTime === null) return 1; // a sorts after b
  if (bTime === null) return -1; // b sorts after a
  if (aTime !== bTime) return bTime - aTime;
  return a.conversation_id < b.conversation_id ? 1 : a.conversation_id > b.conversation_id ? -1 : 0;
}

// "Load next page": appends an older page (already newest-first internally,
// but as a WHOLE it belongs at the bottom of what's loaded) below the
// currently loaded conversations, de-duplicating by conversation_id as a
// defensive safeguard. Returns the SAME array reference when there is
// nothing new to add.
export function appendOlderConversations(prevRows, olderRows) {
  if (!Array.isArray(olderRows) || olderRows.length === 0) return prevRows;
  const existingIds = new Set(prevRows.map((c) => c.conversation_id));
  const deduped = olderRows.filter((c) => !existingIds.has(c.conversation_id));
  return deduped.length ? [...prevRows, ...deduped] : prevRows;
}

// Delta/poll merge: replace an already-loaded conversation in place (a
// status/assignment/last-message change), insert one that wasn't loaded
// yet (new conversation, or an old unloaded one that just became active
// again), then re-sort by the canonical ordering. Never duplicates (keyed
// by conversation_id), never discards an already-loaded row that wasn't
// part of this delta batch. Returns the SAME reference when there is
// nothing to merge.
export function upsertConversations(prevRows, changedRows) {
  if (!Array.isArray(changedRows) || changedRows.length === 0) return prevRows;
  const byId = new Map(prevRows.map((c) => [c.conversation_id, c]));
  for (const row of changedRows) {
    byId.set(row.conversation_id, row);
  }
  const merged = [...byId.values()];
  merged.sort(compareByLastMessageAtDesc);
  return merged;
}

// The (last_message_at, conversation_id) cursor for the OLDEST currently
// loaded conversation — the single source of truth
// loadMoreConversations' before_last_message_at/before_id params are
// built from. `rows` is assumed already sorted newest-first (every array
// this module produces, and every array the API returns, already is).
export function deriveConversationCursor(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { last_message_at: last.last_message_at ?? null, id: last.conversation_id };
}
