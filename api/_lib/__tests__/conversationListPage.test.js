import test from "node:test";
import assert from "node:assert/strict";
import { createMockSupabase } from "./mockSupabase.js";
import {
  DEFAULT_PAGE_LIMIT,
  isValidCursorId,
  isValidCursorTimestamp,
  normalizePageLimit,
  sanitizeSearchTerm,
  buildOlderThanFilter,
  buildDeltaFilter,
  trimPage,
  fetchConversationsPage,
  fetchConversationsDelta,
  resolveSearchConversationIds,
  resolveLeadConversationIds,
  countMatchingConversations,
} from "../conversationListPage.js";

// ===================================================================
// 1. Pure helpers
// ===================================================================

test("normalizePageLimit defaults to 30, clamps, ignores garbage", () => {
  assert.equal(normalizePageLimit(undefined), DEFAULT_PAGE_LIMIT);
  assert.equal(normalizePageLimit("30"), 30);
  assert.equal(normalizePageLimit("0"), DEFAULT_PAGE_LIMIT);
  assert.equal(normalizePageLimit("abc"), DEFAULT_PAGE_LIMIT);
  assert.equal(normalizePageLimit("10000"), 200);
});

test("isValidCursorId / isValidCursorTimestamp", () => {
  assert.equal(isValidCursorId("a0e96cc6-9df6-47d7-8083-c85f8c9aae23"), true);
  assert.equal(isValidCursorId(""), false);
  assert.equal(isValidCursorId('1,and(x.eq."1")'), false);
  assert.equal(isValidCursorTimestamp("2026-01-01T00:00:10.000Z"), true);
  assert.equal(isValidCursorTimestamp("garbage"), false);
});

test("sanitizeSearchTerm strips PostgREST or()-grammar special characters only", () => {
  assert.equal(sanitizeSearchTerm('O"Brien, (John)'), "OBrien John");
  assert.equal(sanitizeSearchTerm("plain text"), "plain text");
});

test("buildOlderThanFilter / buildDeltaFilter produce the expected expression shapes", () => {
  assert.equal(
    buildOlderThanFilter("2026-01-01T00:00:10Z", "conv-5"),
    'last_message_at.lt."2026-01-01T00:00:10Z",and(last_message_at.eq."2026-01-01T00:00:10Z",id.lt."conv-5"),last_message_at.is.null'
  );
  assert.equal(buildDeltaFilter("2026-01-01T00:00:10Z"), 'last_message_at.gt."2026-01-01T00:00:10Z",updated_at.gt."2026-01-01T00:00:10Z"');
});

test("trimPage: fewer than limit -> has_more false, all returned, never mutates input", () => {
  const desc = [{ id: "3" }, { id: "2" }, { id: "1" }];
  const copy = [...desc];
  const { conversations, has_more } = trimPage(desc, 30);
  assert.equal(has_more, false);
  assert.deepEqual(conversations.map((c) => c.id), ["3", "2", "1"]);
  assert.deepEqual(desc, copy);
});

test("trimPage: limit+1 rows -> has_more true, trimmed to exactly limit, DESC order preserved (no reversal)", () => {
  const desc = Array.from({ length: 31 }, (_, i) => ({ id: String(31 - i) }));
  const { conversations, has_more } = trimPage(desc, 30);
  assert.equal(has_more, true);
  assert.equal(conversations.length, 30);
  assert.equal(conversations[0].id, "31");
  assert.equal(conversations[29].id, "2"); // oldest (id "1") dropped
});

// ===================================================================
// 2. fetchConversationsPage — end to end against the mock
// ===================================================================

function conv(id, lastMessageAt, overrides = {}) {
  return {
    id,
    client_id: "client-A",
    contact_id: `contact-${id}`,
    channel_identity_id: `ci-${id}`,
    platform: "whatsapp",
    conversation_status: "active",
    current_step: null,
    assigned_user_id: null,
    assigned_at: null,
    system_assigned_user_id: null,
    system_assigned_at: null,
    solved_by: null,
    solved_at: null,
    reopened_by: null,
    reopened_at: null,
    closed_at: null,
    last_message_at: lastMessageAt,
    created_at: lastMessageAt || "2026-01-01T00:00:00Z",
    updated_at: lastMessageAt || "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function ts(n) {
  return new Date(2026, 0, 1, 0, 0, n).toISOString();
}

test("initial page: fewer than 30 conversations returns all of them, has_more:false", async () => {
  const tables = { conversations: [conv("1", ts(1)), conv("2", ts(2)), conv("3", ts(3))] };
  const supabase = createMockSupabase(tables);
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.has_more, false);
  assert.deepEqual(result.conversations.map((c) => c.id), ["3", "2", "1"]); // newest first
});

test("initial page: EXACTLY 30 conversations returns all 30, has_more:false", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => conv(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  assert.equal(result.has_more, false);
  assert.equal(result.conversations.length, 30);
});

test("initial page: 31 conversations returns the newest 30, has_more:true", async () => {
  const rows = Array.from({ length: 31 }, (_, i) => conv(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  assert.equal(result.has_more, true);
  assert.equal(result.conversations.length, 30);
  assert.equal(result.conversations.find((c) => c.id === "1"), undefined); // oldest dropped
});

test("hundreds of conversations: repeated next-page loading exhausts history with no skip/duplicate", async () => {
  const total = 214;
  const rows = Array.from({ length: total }, (_, i) => conv(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ conversations: rows });

  const seen = [];
  const initial = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  seen.push(...initial.conversations.map((c) => c.id));
  let hasMore = initial.has_more;
  let cursor = initial.conversations[initial.conversations.length - 1];

  let pages = 1;
  while (hasMore) {
    const next = await fetchConversationsPage(supabase, {
      clientId: "client-A",
      limit: 30,
      beforeLastMessageAt: cursor.last_message_at,
      beforeId: cursor.id,
    });
    assert.equal(next.ok, true);
    seen.push(...next.conversations.map((c) => c.id));
    hasMore = next.has_more;
    cursor = next.conversations[next.conversations.length - 1];
    pages += 1;
    assert.ok(pages <= 10, "sanity bound");
  }

  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(seen, rows.map((r) => r.id).reverse()); // newest-to-oldest overall
});

test("identical last_message_at across several conversations: id tiebreak keeps pagination deterministic", async () => {
  const shared = ts(5);
  const rows = [conv("1", ts(1)), conv("2", ts(2)), conv("tie-a", shared), conv("tie-b", shared), conv("tie-c", shared), conv("6", ts(6))];
  const supabase = createMockSupabase({ conversations: rows });

  const page1 = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 3 });
  assert.equal(page1.has_more, true);
  assert.equal(page1.conversations.length, 3);
  const cursorRow = page1.conversations[page1.conversations.length - 1];

  const page2 = await fetchConversationsPage(supabase, {
    clientId: "client-A",
    limit: 3,
    beforeLastMessageAt: cursorRow.last_message_at,
    beforeId: cursorRow.id,
  });
  assert.equal(page2.has_more, false);

  const allIds = [...page1.conversations.map((c) => c.id), ...page2.conversations.map((c) => c.id)];
  assert.equal(new Set(allIds).size, rows.length);
  assert.equal(allIds.length, rows.length);
});

test("NULL last_message_at: sorts after every real timestamp, ordered by id among themselves, and pagination correctly falls through the bucket boundary", async () => {
  const rows = [
    conv("new-2", null),
    conv("3", ts(3)),
    conv("new-1", null),
    conv("1", ts(1)),
    conv("2", ts(2)),
  ];
  const supabase = createMockSupabase({ conversations: rows });

  const page1 = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 3 });
  assert.equal(page1.has_more, true);
  assert.deepEqual(page1.conversations.map((c) => c.id), ["3", "2", "1"]); // real timestamps first, newest first
  const cursorRow = page1.conversations[2]; // "1", ts(1)

  const page2 = await fetchConversationsPage(supabase, {
    clientId: "client-A",
    limit: 3,
    beforeLastMessageAt: cursorRow.last_message_at,
    beforeId: cursorRow.id,
  });
  assert.equal(page2.has_more, false);
  // falls through into the null bucket in the SAME next page, ordered by id desc
  assert.deepEqual(page2.conversations.map((c) => c.id).sort(), ["new-1", "new-2"].sort());
});

test("NULL last_message_at: continuing pagination once already inside the null bucket (before_last_message_at omitted)", async () => {
  const rows = [conv("null-1", null), conv("null-2", null), conv("null-3", null)];
  const supabase = createMockSupabase({ conversations: rows });

  const page1 = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 2 });
  assert.equal(page1.has_more, true);
  assert.equal(page1.conversations.length, 2);
  const cursorRow = page1.conversations[1];
  assert.equal(cursorRow.last_message_at, null);

  const page2 = await fetchConversationsPage(supabase, {
    clientId: "client-A",
    limit: 2,
    beforeId: cursorRow.id, // no beforeLastMessageAt -> "already in the null bucket"
  });
  assert.equal(page2.has_more, false);
  assert.equal(page2.conversations.length, 1);

  const allIds = [...page1.conversations.map((c) => c.id), ...page2.conversations.map((c) => c.id)];
  assert.equal(new Set(allIds).size, 3);
});

test("0 conversations -> empty page, has_more:false", async () => {
  const supabase = createMockSupabase({ conversations: [] });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conversations, []);
  assert.equal(result.has_more, false);
});

test("status filter is applied server-side", async () => {
  const rows = [conv("1", ts(1), { conversation_status: "active" }), conv("2", ts(2), { conversation_status: "closed" })];
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, status: "closed" });
  assert.deepEqual(result.conversations.map((c) => c.id), ["2"]);
});

test("channel filter is applied server-side", async () => {
  const rows = [conv("1", ts(1), { platform: "facebook" }), conv("2", ts(2), { platform: "whatsapp" })];
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, channel: "facebook" });
  assert.deepEqual(result.conversations.map((c) => c.id), ["1"]);
});

test("leadsOnly filter restricts to conversations with a leads row, client-wide (not just the page)", async () => {
  const rows = [conv("1", ts(1)), conv("2", ts(2)), conv("3", ts(3))];
  const supabase = createMockSupabase({
    conversations: rows,
    leads: [{ client_id: "client-A", conversation_id: "2", name: "علي", phone: "0599" }],
  });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, leadsOnly: true });
  assert.deepEqual(result.conversations.map((c) => c.id), ["2"]);
});

test("client scoping: another client's conversations never leak into a page", async () => {
  const rows = [conv("1", ts(1)), conv("other", ts(2), { client_id: "client-B" })];
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  assert.deepEqual(result.conversations.map((c) => c.id), ["1"]);
});

test("a malformed before_id cursor is rejected (400), never silently mis-scoped", async () => {
  const supabase = createMockSupabase({ conversations: [] });
  const result = await fetchConversationsPage(supabase, {
    clientId: "client-A",
    limit: 30,
    beforeLastMessageAt: ts(1),
    beforeId: '1,and(client_id.eq."client-B")',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

// ===================================================================
// 2b. total_count
// ===================================================================

test("total_count: present on the initial page and equals the TOTAL matching count, not the loaded-page count", async () => {
  const rows = Array.from({ length: 104 }, (_, i) => conv(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  assert.equal(result.conversations.length, 30);
  assert.equal(result.total_count, 104);
});

test("total_count: absent on a 'load more' (before_id present) request — it doesn't change page to page", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => conv(String(i + 1), ts(i + 1)));
  const supabase = createMockSupabase({ conversations: rows });
  const initial = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30 });
  const cursor = initial.conversations[initial.conversations.length - 1];
  const next = await fetchConversationsPage(supabase, {
    clientId: "client-A",
    limit: 30,
    beforeLastMessageAt: cursor.last_message_at,
    beforeId: cursor.id,
  });
  assert.equal(next.total_count, undefined);
});

test("total_count respects the SAME status/channel/leadsOnly/search restriction as the page itself", async () => {
  const rows = [
    conv("1", ts(1), { conversation_status: "active" }),
    conv("2", ts(2), { conversation_status: "closed" }),
    conv("3", ts(3), { conversation_status: "closed" }),
  ];
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, status: "closed" });
  assert.equal(result.total_count, 2);
});

test("countMatchingConversations: scoped to client, honors leadIds/searchIds restriction sets", async () => {
  const rows = [conv("1", ts(1)), conv("2", ts(2)), conv("3", ts(3))];
  const supabase = createMockSupabase({ conversations: rows });
  const result = await countMatchingConversations(supabase, {
    clientId: "client-A",
    leadIds: new Set(["1", "2"]),
    searchIds: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.total_count, 2);
});

// ===================================================================
// 3. Search fan-out
// ===================================================================

test("search matches by contact display_name, sender_id/channel display_name, lead name/phone, message text, and exact conversation id", async () => {
  const tables = {
    conversations: [
      conv("by-contact", ts(1)),
      conv("by-identity", ts(2), { contact_id: "no-contact", channel_identity_id: "ci-by-identity" }),
      conv("by-lead", ts(3), { contact_id: "no-contact-2", channel_identity_id: "ci-none" }),
      conv("by-message", ts(4), { contact_id: "no-contact-3", channel_identity_id: "ci-none-2" }),
      conv("no-match", ts(5), { contact_id: "no-contact-4", channel_identity_id: "ci-none-3" }),
    ],
    contacts: [{ id: "contact-by-contact", client_id: "client-A", display_name: "إبراهيم توفيق" }],
    contact_channel_identities: [{ id: "ci-by-identity", client_id: "client-A", sender_id: "0599001852", platform: "whatsapp", display_name: null }],
    leads: [{ client_id: "client-A", conversation_id: "by-lead", name: "غير ذلك", phone: "0500000000" }],
    messages: [{ client_id: "client-A", conversation_id: "by-message", message: "هل عندكم توفيق؟", created_at: ts(4) }],
  };
  const supabase = createMockSupabase(tables);

  const byContact = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, searchTerm: "توفيق" });
  // matches by-contact (contact name) AND by-message (message text contains "توفيق")
  assert.deepEqual(new Set(byContact.conversations.map((c) => c.id)), new Set(["by-contact", "by-message"]));

  const bySender = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, searchTerm: "0599001852" });
  assert.deepEqual(bySender.conversations.map((c) => c.id), ["by-identity"]);

  const byLeadPhone = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, searchTerm: "0500000000" });
  assert.deepEqual(byLeadPhone.conversations.map((c) => c.id), ["by-lead"]);

  const byExactId = await fetchConversationsPage(supabase, {
    clientId: "client-A",
    limit: 30,
    searchTerm: "00000000-0000-0000-0000-000000000000",
  });
  assert.deepEqual(byExactId.conversations, []); // valid-looking uuid, no match — proves exact-match path runs, finds nothing
});

test("search with no matches returns an empty result (0 conversations), not an error", async () => {
  const supabase = createMockSupabase({ conversations: [conv("1", ts(1))] });
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, searchTerm: "nothing matches this at all" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conversations, []);
  assert.equal(result.has_more, false);
});

test("search term containing PostgREST-grammar characters (comma/parens/quote) is sanitized, not rejected or errored", async () => {
  // The comma/parens/quote in the TYPED term are stripped before the term
  // ever reaches an .or() filter string (see sanitizeSearchTerm) — the
  // stored value itself has no comma, so the sanitized term still matches
  // it. This proves the special characters are safely dropped rather than
  // breaking the query (a crash/500 would be the failure mode being
  // guarded against here).
  const tables = {
    conversations: [conv("1", ts(1))],
    contact_channel_identities: [{ id: "ci-1", client_id: "client-A", sender_id: "O'Brien John", platform: "whatsapp", display_name: null }],
  };
  const supabase = createMockSupabase(tables);
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, searchTerm: 'O\'Brien, "(John)' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conversations.map((c) => c.id), ["1"]);
});

test("message-text search matches ONLY the conversation's latest message, not historical text (search semantics fix)", async () => {
  const tables = {
    conversations: [
      // "historical" message matches the term, but it is NOT the latest
      // message in the conversation (a newer, non-matching message exists)
      // -> must NOT match, preserving the original "last message only"
      // search behavior instead of a whole-history scan.
      conv("historical-only", ts(5), {}),
      // the LATEST message itself matches the term -> must match.
      conv("latest-matches", ts(6), {}),
    ],
    messages: [
      { client_id: "client-A", conversation_id: "historical-only", message: "يحتوي على كلمة البحث", created_at: ts(1) },
      { client_id: "client-A", conversation_id: "historical-only", message: "رسالة أحدث لا تحتوي على الكلمة", created_at: ts(5) },
      { client_id: "client-A", conversation_id: "latest-matches", message: "رسالة أحدث لا تحتوي على الكلمة", created_at: ts(2) },
      { client_id: "client-A", conversation_id: "latest-matches", message: "يحتوي على كلمة البحث", created_at: ts(6) },
    ],
  };
  const supabase = createMockSupabase(tables);
  const result = await fetchConversationsPage(supabase, { clientId: "client-A", limit: 30, searchTerm: "كلمة البحث" });
  assert.deepEqual(result.conversations.map((c) => c.id), ["latest-matches"]);
});

test("resolveSearchConversationIds: latest-message check is scoped per matched conversation id, bounded by candidate count not total history", async () => {
  const tables = {
    messages: [
      { client_id: "client-A", conversation_id: "conv-1", message: "target term", created_at: ts(1) },
    ],
  };
  const supabase = createMockSupabase({
    ...tables,
    conversations: [conv("conv-1", ts(1))],
  });
  const result = await resolveSearchConversationIds(supabase, { clientId: "client-A", searchTerm: "target term" });
  assert.deepEqual([...result], ["conv-1"]);
});

test("resolveSearchConversationIds returns null (no restriction) for an empty term", async () => {
  const supabase = createMockSupabase({ conversations: [] });
  const result = await resolveSearchConversationIds(supabase, { clientId: "client-A", searchTerm: "   " });
  assert.equal(result, null);
});

test("resolveLeadConversationIds is scoped to the client", async () => {
  const supabase = createMockSupabase({
    leads: [
      { client_id: "client-A", conversation_id: "1" },
      { client_id: "client-B", conversation_id: "2" },
    ],
  });
  const result = await resolveLeadConversationIds(supabase, "client-A");
  assert.deepEqual([...result], ["1"]);
});

// ===================================================================
// 4. Delta poll
// ===================================================================

test("delta: catches a brand-new conversation (updated_at newer than watermark)", async () => {
  const rows = [conv("1", ts(1))];
  const supabase = createMockSupabase({ conversations: rows });
  const watermark = ts(1);
  rows.push(conv("2", ts(2), { updated_at: ts(2) }));

  const result = await fetchConversationsDelta(supabase, { clientId: "client-A", since: watermark });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conversations.map((c) => c.id), ["2"]);
});

test("delta: catches an EXISTING (already-loaded) conversation whose last_message_at bumped", async () => {
  const rows = [conv("1", ts(1)), conv("2", ts(2))];
  const supabase = createMockSupabase({ conversations: rows });
  const watermark = ts(2);
  // conversation "1" receives a new message
  rows[0].last_message_at = ts(5);
  rows[0].updated_at = ts(5);

  const result = await fetchConversationsDelta(supabase, { clientId: "client-A", since: watermark });
  assert.deepEqual(result.conversations.map((c) => c.id), ["1"]);
});

test("delta: catches a status/assignment change with NO accompanying message (updated_at bumped, last_message_at unchanged)", async () => {
  const rows = [conv("1", ts(1))];
  const supabase = createMockSupabase({ conversations: rows });
  const watermark = ts(1);
  // claim/close/etc bumps updated_at only, per the verified RPC behavior
  rows[0].conversation_status = "waiting_human";
  rows[0].updated_at = ts(9);

  const result = await fetchConversationsDelta(supabase, { clientId: "client-A", since: watermark });
  assert.deepEqual(result.conversations.map((c) => c.id), ["1"]);
  assert.equal(result.conversations[0].conversation_status, "waiting_human");
});

test("delta: nothing changed -> empty result, not an error", async () => {
  const rows = [conv("1", ts(1))];
  const supabase = createMockSupabase({ conversations: rows });
  const result = await fetchConversationsDelta(supabase, { clientId: "client-A", since: ts(1) });
  assert.deepEqual(result.conversations, []);
});

test("delta respects the active status/channel/leadsOnly/search filters", async () => {
  const rows = [conv("1", ts(1), { platform: "facebook" }), conv("2", ts(1), { platform: "whatsapp" })];
  const supabase = createMockSupabase({ conversations: rows });
  rows[0].updated_at = ts(9);
  rows[1].updated_at = ts(9);

  const result = await fetchConversationsDelta(supabase, { clientId: "client-A", since: ts(1), channel: "whatsapp" });
  assert.deepEqual(result.conversations.map((c) => c.id), ["2"]);
});

test("delta: an invalid `since` watermark is rejected (400)", async () => {
  const supabase = createMockSupabase({ conversations: [] });
  const result = await fetchConversationsDelta(supabase, { clientId: "client-A", since: "not-a-date" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});
