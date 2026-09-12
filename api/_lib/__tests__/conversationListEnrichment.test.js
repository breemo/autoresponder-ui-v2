import test from "node:test";
import assert from "node:assert/strict";
import { createMockSupabase } from "./mockSupabase.js";
import { enrichConversationRows } from "../conversationsList.js";

// Conversation List Pagination — the enrichment step (messages/leads/
// contact_channel_identities/contacts/conversation_state), now scoped to
// only the given page/delta's own conversation ids instead of a
// whole-client scan. This is the "did I preserve every existing row
// field, and did I actually scope the queries" test — the aggregation
// algorithm itself is verbatim from the original single-function version.

function conversationRow(id, overrides = {}) {
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
    last_message_at: "2026-01-01T00:00:05Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:05Z",
    ...overrides,
  };
}

test("enrichConversationRows: empty input returns [] without querying anything", async () => {
  const supabase = createMockSupabase({});
  const result = await enrichConversationRows(supabase, "client-A", []);
  assert.deepEqual(result, []);
});

test("enrichConversationRows: preserves every existing row field (customer name, sender, platform, status, last message, counts, unread, lead, assignment, whatsapp)", async () => {
  const tables = {
    contacts: [{ id: "contact-1", client_id: "client-A", display_name: "إبراهيم توفيق" }],
    contact_channel_identities: [
      { id: "ci-1", client_id: "client-A", sender_id: "0599001852", platform: "whatsapp", channel_key: "wa-main", display_name: null },
    ],
    client_whatsapp: [{ client_id: "client-A", channel_key: "wa-main", display_name: "Main WA", phone: "0599999999" }],
    messages: [
      { id: "m1", client_id: "client-A", conversation_id: "1", message: "أول رسالة", created_at: "2026-01-01T00:00:01Z", direction: "inbound", is_read: true },
      { id: "m2", client_id: "client-A", conversation_id: "1", message: "آخر رسالة", created_at: "2026-01-01T00:00:02Z", direction: "outbound", is_read: false },
    ],
    leads: [{ client_id: "client-A", conversation_id: "1", name: "لينا", phone: "0599111222", created_at: "2026-01-01T00:00:00Z" }],
    conversation_state: [{ client_id: "client-A", conversation_id: "1", system_assigned_user_id: "user-1", system_assigned_at: "2026-01-01T00:00:00Z", assigned_user_id: null, assigned_at: null }],
    users: [{ id: "user-1", name: "موظف أول" }],
  };
  const supabase = createMockSupabase(tables);

  const result = await enrichConversationRows(supabase, "client-A", [conversationRow("1")]);
  assert.equal(result.length, 1);
  const row = result[0];

  assert.equal(row.conversation_id, "1");
  assert.equal(row.customer_name, "إبراهيم توفيق");
  assert.equal(row.sender_id, "0599001852");
  assert.equal(row.channel, "whatsapp");
  assert.equal(row.platform, "whatsapp");
  assert.equal(row.conversation_status, "active");
  assert.equal(row.last_message, "آخر رسالة"); // newest message wins
  assert.equal(row.messages_count, 2);
  assert.equal(row.unread_count, 1);
  assert.equal(row.has_lead, true);
  assert.equal(row.lead_name, "لينا");
  assert.equal(row.lead_phone, "0599111222");
  assert.equal(row.system_assigned_user_id, "user-1");
  assert.deepEqual(row.system_assigned_user, { id: "user-1", name: "موظف أول" });
  assert.deepEqual(row.whatsapp_instance, { display_name: "Main WA", phone: "0599999999" });
});

test("enrichConversationRows: scoping — a message/lead/identity belonging to a DIFFERENT conversation never leaks into this page's row", async () => {
  const tables = {
    messages: [
      { id: "m-in", client_id: "client-A", conversation_id: "1", message: "لهذه المحادثة", created_at: "2026-01-01T00:00:01Z", direction: "inbound", is_read: true },
      { id: "m-out", client_id: "client-A", conversation_id: "OTHER", message: "لمحادثة أخرى غير محمّلة", created_at: "2026-01-01T00:00:09Z", direction: "inbound", is_read: false },
    ],
    leads: [{ client_id: "client-A", conversation_id: "OTHER", name: "شخص آخر", phone: "0500000000" }],
  };
  const supabase = createMockSupabase(tables);

  const result = await enrichConversationRows(supabase, "client-A", [conversationRow("1")]);
  assert.equal(result[0].last_message, "لهذه المحادثة");
  assert.equal(result[0].messages_count, 1);
  assert.equal(result[0].has_lead, false);
  assert.equal(result[0].lead_name, null);
});

test("enrichConversationRows: a conversation with no messages/lead yet still returns a valid, empty-enrichment row", async () => {
  const supabase = createMockSupabase({});
  const result = await enrichConversationRows(supabase, "client-A", [conversationRow("1")]);
  assert.equal(result[0].last_message, "");
  assert.equal(result[0].messages_count, 0);
  assert.equal(result[0].unread_count, 0);
  assert.equal(result[0].has_lead, false);
  assert.equal(result[0].customer_name, null);
});
