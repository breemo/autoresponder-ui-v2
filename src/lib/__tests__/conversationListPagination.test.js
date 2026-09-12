import test from "node:test";
import assert from "node:assert/strict";
import { appendOlderConversations, upsertConversations, deriveConversationCursor } from "../conversationListPagination.js";

function c(id, lastMessageAt, overrides = {}) {
  return { conversation_id: id, last_message_at: lastMessageAt, ...overrides };
}

// ===================================================================
// appendOlderConversations — "load next page" (scroll near bottom)
// ===================================================================

test("appendOlderConversations: an older page is appended below the currently loaded conversations", () => {
  const prev = [c("1", "3"), c("2", "2")];
  const older = [c("3", "1"), c("4", "0")];
  const result = appendOlderConversations(prev, older);
  assert.deepEqual(result.map((x) => x.conversation_id), ["1", "2", "3", "4"]);
});

test("appendOlderConversations: never discards already-loaded conversations (same object references)", () => {
  const prev = [c("1", "3"), c("2", "2")];
  const older = [c("3", "1")];
  const result = appendOlderConversations(prev, older);
  assert.equal(result[0], prev[0]);
  assert.equal(result[1], prev[1]);
});

test("appendOlderConversations: repeated calls keep extending with no gaps/duplicates", () => {
  let loaded = [c("1", "5"), c("2", "4")];
  loaded = appendOlderConversations(loaded, [c("3", "3"), c("4", "2")]);
  loaded = appendOlderConversations(loaded, [c("5", "1"), c("6", "0")]);
  assert.deepEqual(loaded.map((x) => x.conversation_id), ["1", "2", "3", "4", "5", "6"]);
});

test("appendOlderConversations: defensive de-dup — an overlapping older page never produces a duplicate", () => {
  const prev = [c("1", "3"), c("2", "2")];
  const result = appendOlderConversations(prev, [c("2", "2"), c("3", "1")]);
  assert.deepEqual(result.map((x) => x.conversation_id), ["1", "2", "3"]);
});

test("appendOlderConversations: empty page returns the SAME reference (no-op, no render)", () => {
  const prev = [c("1", "1")];
  assert.equal(appendOlderConversations(prev, []), prev);
  assert.equal(appendOlderConversations(prev, null), prev);
});

// ===================================================================
// upsertConversations — delta/poll merge
// ===================================================================

test("upsertConversations: a brand-new conversation is inserted and moved to its correct (newest-first) position", () => {
  const prev = [c("1", "5"), c("2", "3")];
  const result = upsertConversations(prev, [c("new", "9")]);
  assert.deepEqual(result.map((x) => x.conversation_id), ["new", "1", "2"]);
});

test("upsertConversations: an unloaded OLD conversation that receives a new message is inserted and moves to the top", () => {
  // "old" was never in the loaded set at all (outside the loaded page)
  const prev = [c("1", "5"), c("2", "3")];
  const result = upsertConversations(prev, [c("old", "9")]);
  assert.deepEqual(result.map((x) => x.conversation_id), ["old", "1", "2"]);
});

test("upsertConversations: an already-loaded conversation is REPLACED in place (updated fields) and re-sorted to the top", () => {
  const prev = [c("1", "5", { unread_count: 2 }), c("2", "3")];
  const result = upsertConversations(prev, [c("2", "9", { unread_count: 0 })]);
  assert.deepEqual(result.map((x) => x.conversation_id), ["2", "1"]);
  assert.equal(result[0].unread_count, 0);
  assert.equal(result[0].last_message_at, "9");
});

test("upsertConversations: a status/assignment change with an UNCHANGED last_message_at still updates the row in place", () => {
  const prev = [c("1", "5", { conversation_status: "active" })];
  const result = upsertConversations(prev, [c("1", "5", { conversation_status: "waiting_human" })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].conversation_status, "waiting_human");
});

test("upsertConversations: never duplicates — same conversation appearing twice across polls stays one row", () => {
  let loaded = [c("1", "1")];
  loaded = upsertConversations(loaded, [c("1", "5")]);
  loaded = upsertConversations(loaded, [c("1", "9")]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].last_message_at, "9");
});

test("upsertConversations: never discards already-loaded OLDER pages not touched by this delta", () => {
  const prev = [c("1", "5"), c("2", "3"), c("3", "1")]; // "3" came from an earlier Load Older
  const result = upsertConversations(prev, [c("1", "9")]);
  assert.deepEqual(result.map((x) => x.conversation_id).sort(), ["1", "2", "3"].sort());
});

test("upsertConversations: empty delta returns the SAME reference (no-op, no render)", () => {
  const prev = [c("1", "1")];
  assert.equal(upsertConversations(prev, []), prev);
  assert.equal(upsertConversations(prev, undefined), prev);
});

// ===================================================================
// deriveConversationCursor
// ===================================================================

test("deriveConversationCursor: empty list -> null", () => {
  assert.equal(deriveConversationCursor([]), null);
});

test("deriveConversationCursor: the LAST (oldest) row of a newest-first list", () => {
  const rows = [c("1", "3"), c("2", "2"), c("3", "1")];
  assert.deepEqual(deriveConversationCursor(rows), { last_message_at: "1", id: "3" });
});

test("deriveConversationCursor: a null last_message_at on the oldest row is preserved as null (not coerced)", () => {
  const rows = [c("1", "3"), c("2", null)];
  assert.deepEqual(deriveConversationCursor(rows), { last_message_at: null, id: "2" });
});
