import test from "node:test";
import assert from "node:assert/strict";
import { appendUniqueMessages, prependUniqueMessages, deriveMessageCursors } from "../messagePagination.js";

function m(id, created_at, overrides = {}) {
  return { id, created_at, message: `msg-${id}`, ...overrides };
}

// ===================================================================
// prependUniqueMessages — "Load Older"
// ===================================================================

test("prependUniqueMessages: an older page is prepended above the currently loaded messages, order preserved", () => {
  const prev = [m("3", "3"), m("4", "4")];
  const older = [m("1", "1"), m("2", "2")];
  const result = prependUniqueMessages(prev, older);
  assert.deepEqual(result.map((x) => x.id), ["1", "2", "3", "4"]);
});

test("prependUniqueMessages: never replaces or drops already-loaded messages (older AND newer stay intact)", () => {
  const prev = [m("10", "10"), m("11", "11"), m("12", "12")];
  const older = [m("8", "8"), m("9", "9")];
  const result = prependUniqueMessages(prev, older);
  // everything that was already loaded is still there, untouched, in place
  assert.deepEqual(result.map((x) => x.id), ["8", "9", "10", "11", "12"]);
  assert.equal(result[2], prev[0]); // same object reference — not re-created/replaced
  assert.equal(result[3], prev[1]);
  assert.equal(result[4], prev[2]);
});

test("prependUniqueMessages: repeated Load Older calls keep extending backward with no gaps/duplicates", () => {
  let loaded = [m("5", "5"), m("6", "6")];
  loaded = prependUniqueMessages(loaded, [m("3", "3"), m("4", "4")]);
  loaded = prependUniqueMessages(loaded, [m("1", "1"), m("2", "2")]);
  assert.deepEqual(loaded.map((x) => x.id), ["1", "2", "3", "4", "5", "6"]);
});

test("prependUniqueMessages: defensive de-dup — an overlapping/duplicate older response never produces a duplicate bubble", () => {
  const prev = [m("3", "3"), m("4", "4")];
  const olderWithOverlap = [m("2", "2"), m("3", "3")]; // "3" is already loaded
  const result = prependUniqueMessages(prev, olderWithOverlap);
  assert.deepEqual(result.map((x) => x.id), ["2", "3", "4"]);
  assert.equal(result.filter((x) => x.id === "3").length, 1);
});

test("prependUniqueMessages: empty older page returns the SAME reference (no-op, no re-render)", () => {
  const prev = [m("1", "1")];
  assert.equal(prependUniqueMessages(prev, []), prev);
  assert.equal(prependUniqueMessages(prev, null), prev);
});

test("prependUniqueMessages: an older page that turns out to be entirely already-known still no-ops (same reference)", () => {
  const prev = [m("1", "1"), m("2", "2")];
  assert.equal(prependUniqueMessages(prev, [m("1", "1")]), prev);
});

// ===================================================================
// appendUniqueMessages — polling / post-send follow-up
// ===================================================================

test("appendUniqueMessages: new inbound message is appended after the currently loaded messages, order preserved", () => {
  const prev = [m("1", "1"), m("2", "2")];
  const result = appendUniqueMessages(prev, [m("3", "3")]);
  assert.deepEqual(result.map((x) => x.id), ["1", "2", "3"]);
});

test("appendUniqueMessages: employee outbound while OLDER pages are already loaded — older pages untouched, new row appended at the end", () => {
  // conv-A's full loaded state after an earlier "Load older": [old-2, old-1(oldest omitted), 1, 2] etc.
  const prev = [m("old-1", "0"), m("old-2", "0.5"), m("1", "1"), m("2", "2")];
  const afterSend = appendUniqueMessages(prev, [m("3", "3", { direction: "outbound" })]);
  assert.deepEqual(afterSend.map((x) => x.id), ["old-1", "old-2", "1", "2", "3"]);
  // the older pages are the exact same objects — never re-fetched/replaced
  assert.equal(afterSend[0], prev[0]);
  assert.equal(afterSend[1], prev[1]);
});

test("appendUniqueMessages: empty newer-page (nothing new) returns the SAME reference — no state update, no render", () => {
  const prev = [m("1", "1")];
  assert.equal(appendUniqueMessages(prev, []), prev);
  assert.equal(appendUniqueMessages(prev, undefined), prev);
});

test("appendUniqueMessages: defensive de-dup — a duplicate/overlapping poll response never produces a duplicate bubble", () => {
  const prev = [m("1", "1"), m("2", "2")];
  const result = appendUniqueMessages(prev, [m("2", "2"), m("3", "3")]);
  assert.deepEqual(result.map((x) => x.id), ["1", "2", "3"]);
});

// ===================================================================
// Interleaving: "load older" and "poll newer" touch disjoint regions
// ===================================================================

test("older-prepend and newer-append never conflict: applying both (in either order) against the same base yields the same final, complete, ordered, duplicate-free list", () => {
  const base = [m("3", "3"), m("4", "4")]; // what's currently loaded
  const older = [m("1", "1"), m("2", "2")]; // resolves from a "Load older" click
  const newer = [m("5", "5")]; // resolves from a poll tick, arriving around the same time

  const orderA = appendUniqueMessages(prependUniqueMessages(base, older), newer);
  const orderB = prependUniqueMessages(appendUniqueMessages(base, newer), older);

  assert.deepEqual(orderA.map((x) => x.id), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(orderB.map((x) => x.id), ["1", "2", "3", "4", "5"]);
});

// ===================================================================
// deriveMessageCursors
// ===================================================================

test("deriveMessageCursors: empty list -> both null", () => {
  assert.deepEqual(deriveMessageCursors([]), { oldest: null, newest: null });
});

test("deriveMessageCursors: single message -> oldest === newest", () => {
  const result = deriveMessageCursors([m("1", "2026-01-01T00:00:01Z")]);
  assert.deepEqual(result.oldest, { created_at: "2026-01-01T00:00:01Z", id: "1" });
  assert.deepEqual(result.newest, { created_at: "2026-01-01T00:00:01Z", id: "1" });
});

test("deriveMessageCursors: first/last of an ascending list", () => {
  const rows = [m("1", "2026-01-01T00:00:01Z"), m("2", "2026-01-01T00:00:02Z"), m("3", "2026-01-01T00:00:03Z")];
  const result = deriveMessageCursors(rows);
  assert.deepEqual(result.oldest, { created_at: "2026-01-01T00:00:01Z", id: "1" });
  assert.deepEqual(result.newest, { created_at: "2026-01-01T00:00:03Z", id: "3" });
});
