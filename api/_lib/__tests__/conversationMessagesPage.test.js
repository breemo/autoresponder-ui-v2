import test from "node:test";
import assert from "node:assert/strict";
import { createMockSupabase } from "./mockSupabase.js";
import {
  DEFAULT_PAGE_LIMIT,
  isValidCursorId,
  isValidCursorCreatedAt,
  normalizePageLimit,
  buildOlderThanFilter,
  buildNewerThanFilter,
  toAscendingPage,
  fetchConversationMessagesPage,
} from "../conversationMessagesPage.js";

// ===================================================================
// 1. Pure helpers
// ===================================================================

test("isValidCursorId accepts uuid-ish / numeric-ish tokens, rejects filter-breaking characters", () => {
  assert.equal(isValidCursorId("a0e96cc6-9df6-47d7-8083-c85f8c9aae23"), true);
  assert.equal(isValidCursorId("12345"), true);
  assert.equal(isValidCursorId("m-A-old_1"), true);
  assert.equal(isValidCursorId(""), false);
  assert.equal(isValidCursorId(null), false);
  assert.equal(isValidCursorId(undefined), false);
  assert.equal(isValidCursorId('1,and(x.eq."1")'), false); // no comma/paren
  assert.equal(isValidCursorId('1"'), false); // no quote
  assert.equal(isValidCursorId("a b"), false); // no space
});

test("isValidCursorCreatedAt accepts a parseable timestamp, rejects garbage", () => {
  assert.equal(isValidCursorCreatedAt("2026-01-01T00:00:10.123Z"), true);
  assert.equal(isValidCursorCreatedAt("2026-01-01T00:00:10Z"), true);
  assert.equal(isValidCursorCreatedAt(""), false);
  assert.equal(isValidCursorCreatedAt("not-a-date"), false);
  assert.equal(isValidCursorCreatedAt(null), false);
  assert.equal(isValidCursorCreatedAt(123), false);
});

test("normalizePageLimit defaults to 50, clamps to a sane max, ignores garbage", () => {
  assert.equal(normalizePageLimit(undefined), DEFAULT_PAGE_LIMIT);
  assert.equal(normalizePageLimit("50"), 50);
  assert.equal(normalizePageLimit("0"), DEFAULT_PAGE_LIMIT);
  assert.equal(normalizePageLimit("-5"), DEFAULT_PAGE_LIMIT);
  assert.equal(normalizePageLimit("abc"), DEFAULT_PAGE_LIMIT);
  assert.equal(normalizePageLimit("10000"), 200);
  assert.equal(normalizePageLimit("12.9"), 12);
});

test("buildOlderThanFilter / buildNewerThanFilter produce the exact composite-cursor PostgREST expression", () => {
  assert.equal(
    buildOlderThanFilter("2026-01-01T00:00:10Z", "m-5"),
    'created_at.lt."2026-01-01T00:00:10Z",and(created_at.eq."2026-01-01T00:00:10Z",id.lt."m-5")'
  );
  assert.equal(
    buildNewerThanFilter("2026-01-01T00:00:10Z", "m-5"),
    'created_at.gt."2026-01-01T00:00:10Z",and(created_at.eq."2026-01-01T00:00:10Z",id.gt."m-5")'
  );
});

test("toAscendingPage: fewer rows than limit -> has_more false, all returned, order reversed to ascending", () => {
  const desc = [{ id: "3", created_at: "3" }, { id: "2", created_at: "2" }, { id: "1", created_at: "1" }];
  const { messages, has_more } = toAscendingPage(desc, 50);
  assert.equal(has_more, false);
  assert.deepEqual(messages.map((m) => m.id), ["1", "2", "3"]);
});

test("toAscendingPage: exactly limit rows fetched (limit+1 request returned only limit) -> has_more false", () => {
  const desc = Array.from({ length: 50 }, (_, i) => ({ id: String(50 - i), created_at: String(50 - i) }));
  const { messages, has_more } = toAscendingPage(desc, 50);
  assert.equal(has_more, false);
  assert.equal(messages.length, 50);
  assert.equal(messages[0].id, "1");
  assert.equal(messages[49].id, "50");
});

test("toAscendingPage: limit+1 rows fetched -> has_more true, trimmed to exactly limit, newest-of-page last", () => {
  const desc = Array.from({ length: 51 }, (_, i) => ({ id: String(51 - i), created_at: String(51 - i) }));
  const { messages, has_more } = toAscendingPage(desc, 50);
  assert.equal(has_more, true);
  assert.equal(messages.length, 50);
  // the 51st (oldest) row was dropped; ascending order preserved for the rest
  assert.equal(messages[0].id, "2");
  assert.equal(messages[49].id, "51");
});

test("toAscendingPage never mutates its input array", () => {
  const desc = [{ id: "2" }, { id: "1" }];
  const copy = [...desc];
  toAscendingPage(desc, 50);
  assert.deepEqual(desc, copy);
});

// ===================================================================
// 2. fetchConversationMessagesPage — end to end against the mock
// ===================================================================

function row(id, createdAt, overrides = {}) {
  return {
    id,
    client_id: "client-A",
    conversation_id: "conv-A",
    message: `msg-${id}`,
    direction: "inbound",
    created_at: createdAt,
    message_type: "text",
    is_read: true,
    ...overrides,
  };
}

function ts(n) {
  // deterministic, strictly increasing ISO timestamps
  return new Date(2026, 0, 1, 0, 0, n).toISOString();
}

test("initial page: conversation with FEWER than 50 messages returns all of them, has_more:false", async () => {
  const tables = { messages: [row("1", ts(1)), row("2", ts(2)), row("3", ts(3))] };
  const supabase = createMockSupabase(tables);
  const result = await fetchConversationMessagesPage(supabase, { clientId: "client-A", conversationId: "conv-A", limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.has_more, false);
  assert.deepEqual(result.messages.map((m) => m.id), ["1", "2", "3"]);
});

test("initial page: EXACTLY 50 messages returns all 50 in ascending order, has_more:false", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ messages: rows });
  const result = await fetchConversationMessagesPage(supabase, { clientId: "client-A", conversationId: "conv-A", limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.has_more, false);
  assert.equal(result.messages.length, 50);
  assert.deepEqual(result.messages.map((m) => m.id), rows.map((r) => r.id));
});

test("initial page: 51 messages returns the NEWEST 50 in chronological order, has_more:true", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => row(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ messages: rows });
  const result = await fetchConversationMessagesPage(supabase, { clientId: "client-A", conversationId: "conv-A", limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.has_more, true);
  assert.equal(result.messages.length, 50);
  // the OLDEST message (id "1") is the one left out of the initial page
  assert.equal(result.messages.find((m) => m.id === "1"), undefined);
  assert.deepEqual(result.messages.map((m) => m.id), rows.slice(1).map((r) => r.id));
  // still in normal chronological (ascending) order
  for (let i = 1; i < result.messages.length; i += 1) {
    assert.ok(new Date(result.messages[i - 1].created_at) <= new Date(result.messages[i].created_at));
  }
});

test("hundreds of messages: repeated Load Older eventually exhausts history with no skip/duplicate", async () => {
  const total = 237;
  const rows = Array.from({ length: total }, (_, i) => row(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ messages: rows });

  const seen = [];
  let cursorBefore = null;
  let hasMore = true;

  // initial page
  const initial = await fetchConversationMessagesPage(supabase, { clientId: "client-A", conversationId: "conv-A", limit: 50 });
  seen.unshift(...initial.messages.map((m) => m.id));
  hasMore = initial.has_more;
  cursorBefore = { created_at: initial.messages[0].created_at, id: initial.messages[0].id };

  let pages = 1;
  while (hasMore) {
    const older = await fetchConversationMessagesPage(supabase, {
      clientId: "client-A",
      conversationId: "conv-A",
      limit: 50,
      beforeCreatedAt: cursorBefore.created_at,
      beforeId: cursorBefore.id,
    });
    assert.equal(older.ok, true);
    seen.unshift(...older.messages.map((m) => m.id));
    hasMore = older.has_more;
    cursorBefore = { created_at: older.messages[0].created_at, id: older.messages[0].id };
    pages += 1;
    assert.ok(pages <= 10, "sanity bound to avoid an infinite loop on a real bug");
  }

  assert.equal(seen.length, total);
  assert.deepEqual(seen, rows.map((r) => r.id)); // exact order, no skip, no duplicate
  assert.equal(new Set(seen).size, total); // no duplicates
});

test("identical created_at across several messages: id tiebreaker keeps pagination deterministic (no skip, no duplicate)", async () => {
  // 3 messages share the EXACT same created_at; ids provide the only
  // deterministic ordering between them.
  const shared = ts(5);
  const rows = [
    row("1", ts(1)),
    row("2", ts(2)),
    row("tie-a", shared),
    row("tie-b", shared),
    row("tie-c", shared),
    row("6", ts(6)),
  ];
  const supabase = createMockSupabase({ messages: rows });

  const page1 = await fetchConversationMessagesPage(supabase, { clientId: "client-A", conversationId: "conv-A", limit: 3 });
  assert.equal(page1.ok, true);
  assert.equal(page1.has_more, true);
  assert.equal(page1.messages.length, 3);

  const oldestOnPage1 = page1.messages[0];
  const page2 = await fetchConversationMessagesPage(supabase, {
    clientId: "client-A",
    conversationId: "conv-A",
    limit: 3,
    beforeCreatedAt: oldestOnPage1.created_at,
    beforeId: oldestOnPage1.id,
  });
  assert.equal(page2.ok, true);
  assert.equal(page2.has_more, false);

  const allIds = [...page2.messages.map((m) => m.id), ...page1.messages.map((m) => m.id)];
  assert.deepEqual(allIds.sort(), rows.map((r) => r.id).sort());
  assert.equal(new Set(allIds).size, rows.length); // nobody duplicated
  assert.equal(allIds.length, rows.length); // nobody skipped
});

test("after cursor (polling): returns only messages strictly newer than the cursor, ascending, no limit re-fetch of history", async () => {
  const rows = [row("1", ts(1)), row("2", ts(2)), row("3", ts(3))];
  const supabase = createMockSupabase({ messages: rows });

  const noneYet = await fetchConversationMessagesPage(supabase, {
    clientId: "client-A",
    conversationId: "conv-A",
    afterCreatedAt: ts(3),
    afterId: "3",
  });
  assert.equal(noneYet.ok, true);
  assert.deepEqual(noneYet.messages, []);
  assert.equal(noneYet.has_more, false);

  // a new inbound message arrives (id "4") while the newest loaded is "2"
  rows.push(row("4", ts(4)));
  const delta = await fetchConversationMessagesPage(supabase, {
    clientId: "client-A",
    conversationId: "conv-A",
    afterCreatedAt: ts(2),
    afterId: "2",
  });
  assert.equal(delta.ok, true);
  assert.deepEqual(delta.messages.map((m) => m.id), ["3", "4"]); // only strictly newer than "2"
});

test("employee outbound arriving while older pages are loaded is still correctly picked up by the newer-cursor query", async () => {
  const rows = [row("1", ts(1)), row("2", ts(2))];
  const supabase = createMockSupabase({ messages: rows });
  // employee sends -> n8n inserts the outbound row
  rows.push(row("3", ts(3), { direction: "outbound" }));

  const delta = await fetchConversationMessagesPage(supabase, {
    clientId: "client-A",
    conversationId: "conv-A",
    afterCreatedAt: ts(2),
    afterId: "2",
  });
  assert.deepEqual(delta.messages.map((m) => m.id), ["3"]);
  assert.equal(delta.messages[0].direction, "outbound");
});

test("client_id / conversation_id scoping: another conversation's or another client's rows never leak into a page", async () => {
  const rows = [
    row("a1", ts(1)),
    row("a2", ts(2)),
    row("other-conv", ts(3), { conversation_id: "conv-B" }),
    row("other-client", ts(4), { client_id: "client-B", conversation_id: "conv-A" }),
  ];
  const supabase = createMockSupabase({ messages: rows });
  const result = await fetchConversationMessagesPage(supabase, { clientId: "client-A", conversationId: "conv-A", limit: 50 });
  assert.deepEqual(result.messages.map((m) => m.id), ["a1", "a2"]);
});

test("before_* and after_* together is rejected (mutually exclusive)", async () => {
  const supabase = createMockSupabase({ messages: [] });
  const result = await fetchConversationMessagesPage(supabase, {
    clientId: "client-A",
    conversationId: "conv-A",
    limit: 50,
    beforeCreatedAt: ts(1),
    beforeId: "1",
    afterCreatedAt: ts(1),
    afterId: "1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("a malformed cursor (id containing filter-breaking characters) is rejected, never silently mis-scoped", async () => {
  const supabase = createMockSupabase({ messages: [row("1", ts(1))] });
  const result = await fetchConversationMessagesPage(supabase, {
    clientId: "client-A",
    conversationId: "conv-A",
    limit: 50,
    beforeCreatedAt: ts(1),
    beforeId: '1,and(client_id.eq."client-B")',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});
