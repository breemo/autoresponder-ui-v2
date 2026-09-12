// Message Pagination / Load Older Messages — pure merge helpers.
//
// No React/DOM dependency, so these can be unit tested directly and
// reused wherever ClientMessages.jsx needs to combine a freshly-fetched
// page of messages with what's already loaded. Every function here is a
// pure array transform: given the same inputs, always the same output,
// never touches state/refs/the DOM itself.

// Prepends an older page (already in ascending order) above what's
// currently loaded, de-duplicating by id as a defensive safeguard (the
// cursor query is already exact, but a retried/overlapping response must
// never produce a duplicate bubble). Returns the SAME array reference
// when there is nothing new to add, so a caller using this as a React
// state updater gets a correct no-op bail-out for free.
export function prependUniqueMessages(prevRows, olderRows) {
  if (!Array.isArray(olderRows) || olderRows.length === 0) return prevRows;
  const existingIds = new Set(prevRows.map((m) => m.id));
  const deduped = olderRows.filter((m) => !existingIds.has(m.id));
  return deduped.length ? [...deduped, ...prevRows] : prevRows;
}

// Appends a newer page (already in ascending order) below what's
// currently loaded — used by both the 5s poll and the post-send
// follow-up. Same de-duplication and same-reference no-op guarantee as
// prependUniqueMessages above.
export function appendUniqueMessages(prevRows, newerRows) {
  if (!Array.isArray(newerRows) || newerRows.length === 0) return prevRows;
  const existingIds = new Set(prevRows.map((m) => m.id));
  const deduped = newerRows.filter((m) => !existingIds.has(m.id));
  return deduped.length ? [...prevRows, ...deduped] : prevRows;
}

// The (created_at, id) cursor for the oldest/newest currently-loaded
// message — the single source of truth loadOlderMessages' before_* and
// fetchAndAppendNewerMessages' after_* cursors are built from. `rows` is
// assumed already in ascending chronological order (every array this
// module produces, and every array the API returns, already is).
export function deriveMessageCursors(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { oldest: null, newest: null };
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    oldest: { created_at: first.created_at, id: first.id },
    newest: { created_at: last.created_at, id: last.id },
  };
}
