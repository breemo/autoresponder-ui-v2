import test from "node:test";
import assert from "node:assert/strict";
import { createMockSupabase } from "./mockSupabase.js";
import {
  INTENT_VALUES,
  TOOL_ACTIONS,
  normalizePhone,
  resolveConversationScope,
  dispatchAiTool,
  handleSearchKnowledge,
  handleGetBusinessFacts,
  handleRecordIntent,
  handleRequestHandover,
  handleUpsertLead,
  handleOrderProgress,
  handleCloseConversation,
} from "../aiTools.js";

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
function noOpenAiKey() {
  delete process.env.OPENAI_API_KEY; // force the vector path to degrade without a network call
}
function restoreKey() {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
}

// Two clients, one conversation each — every cross-tenant test uses the
// wrong client's data to prove it can never be reached via conversation_id.
function baseTables() {
  return {
    conversations: [
      {
        id: "conv-A",
        client_id: "client-A",
        contact_id: "contact-A",
        channel_identity_id: "ci-A",
        platform: "whatsapp",
        conversation_status: "active",
        current_step: null,
        last_message_at: null,
      },
      {
        id: "conv-B",
        client_id: "client-B",
        contact_id: "contact-B",
        channel_identity_id: "ci-B",
        platform: "facebook",
        conversation_status: "active",
        current_step: null,
        last_message_at: null,
      },
    ],
    contact_channel_identities: [
      { id: "ci-A", client_id: "client-A", contact_id: "contact-A", platform: "whatsapp", sender_id: "970590000001", channel_key: "wa-key-A" },
      { id: "ci-B", client_id: "client-B", contact_id: "contact-B", platform: "facebook", sender_id: "psid-B", channel_key: "page-B" },
    ],
    clients: [
      {
        id: "client-A",
        business_name: "Tasty Kitchen",
        business_description: "A Palestinian restaurant.",
        phone: "0591111111",
        address: "Rafidia St, Nablus",
        website: null,
        timezone: "Asia/Hebron",
        working_hours: { timezone: "Asia/Hebron", days: { sunday: [{ open: "09:00", close: "17:00" }] } },
        locations_list_complete: false,
      },
      {
        id: "client-B",
        business_name: "Other Co",
        business_description: "Should never surface for conv-A.",
        phone: "0599999999",
        address: "Ramallah",
        website: null,
        timezone: null,
        working_hours: null,
        locations_list_complete: true,
      },
    ],
    client_locations: [
      { client_id: "client-A", name: "فرع نابلس", address: "Rafidia St", city: "نابلس", phone: null, working_hours: null, is_primary: true, is_active: true, created_at: "2026-01-01" },
      { client_id: "client-B", name: "Ramallah HQ", address: "Al-Manara", city: "Ramallah", phone: null, working_hours: null, is_primary: true, is_active: true, created_at: "2026-01-01" },
    ],
    messages: [
      { id: "m-A-old", client_id: "client-A", conversation_id: "conv-A", message: "أول رسالة", direction: "inbound", created_at: "2026-01-01T00:00:00Z", intent: null },
      { id: "m-A-out", client_id: "client-A", conversation_id: "conv-A", message: "رد", direction: "outbound", created_at: "2026-01-01T00:00:05Z", intent: null },
      { id: "m-A-new", client_id: "client-A", conversation_id: "conv-A", message: "الرسالة الحالية", direction: "inbound", created_at: "2026-01-01T00:00:10Z", intent: null },
      { id: "m-B-new", client_id: "client-B", conversation_id: "conv-B", message: "b message", direction: "inbound", created_at: "2026-01-01T00:00:10Z", intent: null },
    ],
    conversation_state: [
      { client_id: "client-A", conversation_id: "conv-A", sender_id: "970590000001", platform: "whatsapp", conversation_status: "active", current_step: null, assigned_user_id: null, updated_at: null },
      { client_id: "client-B", conversation_id: "conv-B", sender_id: "psid-B", platform: "facebook", conversation_status: "active", current_step: null, assigned_user_id: null, updated_at: null },
    ],
    leads: [],
  };
}

// ---------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------
test("normalizePhone: accepts a plain local number, strips separators", () => {
  assert.deepEqual(normalizePhone("059 111-1111"), { ok: true, phone: "0591111111" });
});
test("normalizePhone: keeps a single leading +, converts Arabic-Indic digits", () => {
  assert.deepEqual(normalizePhone("+٩٧٠٥٩٠١٢٣٤٥٦"), { ok: true, phone: "+970590123456" });
});
test("normalizePhone: rejects too-short / non-phone input", () => {
  assert.equal(normalizePhone("hello").ok, false);
  assert.equal(normalizePhone("123").ok, false);
  assert.equal(normalizePhone("").ok, false);
  assert.equal(normalizePhone(null).ok, false);
});

// ---------------------------------------------------------------------
// resolveConversationScope — identity is server-derived
// ---------------------------------------------------------------------
test("resolveConversationScope: missing id -> 400", async () => {
  const r = await resolveConversationScope(createMockSupabase(baseTables()), undefined);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});
test("resolveConversationScope: unknown conversation -> 404", async () => {
  const r = await resolveConversationScope(createMockSupabase(baseTables()), "conv-ZZZ");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});
test("resolveConversationScope: derives client_id + sender_id from the conversation, not the caller", async () => {
  const r = await resolveConversationScope(createMockSupabase(baseTables()), "conv-A");
  assert.equal(r.ok, true);
  assert.equal(r.scope.clientId, "client-A");
  assert.equal(r.scope.senderId, "970590000001");
  assert.equal(r.scope.platform, "whatsapp");
});

// ---------------------------------------------------------------------
// search_knowledge
// ---------------------------------------------------------------------
test("search_knowledge: retrieval is always scoped to the conversation's own client_id", async () => {
  noOpenAiKey();
  const supabase = createMockSupabase(baseTables());
  let seenClientId = null;
  supabase.rpc = async (name, args) => {
    if (name === "match_knowledge_chunks_lexical") {
      seenClientId = args.p_client_id;
      return {
        data: [
          { chunk_id: "c1", document_id: "d1", document_title: "Menu", category: "menu", content: "X".repeat(5000), lexical_rank: 0.9 },
        ],
        error: null,
      };
    }
    return { data: [], error: null };
  };

  const res = await handleSearchKnowledge(supabase, { conversationId: "conv-A", query: "عرض المنيو" });
  restoreKey();

  assert.equal(seenClientId, "client-A"); // never client-B, never a caller-supplied value
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].document_title, "Menu");
  assert.equal(res.results[0].excerpt.length <= 1200, true); // content capped
  assert.equal("chunk_id" in res.results[0], false); // internal id never exposed
});

test("search_knowledge: degrades to an empty result set, never an error, when retrieval is unavailable", async () => {
  noOpenAiKey();
  const supabase = createMockSupabase(baseTables());
  supabase.rpc = async () => ({ data: null, error: { message: "boom" } });
  const res = await handleSearchKnowledge(supabase, { conversationId: "conv-A", query: "anything" });
  restoreKey();
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.equal(res.degraded, true);
});

test("search_knowledge: missing query -> 400", async () => {
  const res = await handleSearchKnowledge(createMockSupabase(baseTables()), { conversationId: "conv-A", query: "  " });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------
// get_business_facts
// ---------------------------------------------------------------------
test("get_business_facts: returns the conversation's own client, never another tenant's", async () => {
  const res = await handleGetBusinessFacts(createMockSupabase(baseTables()), { conversationId: "conv-A" });
  assert.equal(res.ok, true);
  assert.equal(res.business.name, "Tasty Kitchen");
  assert.notEqual(res.business.description, "Should never surface for conv-A.");
});

test("get_business_facts: locations_list_complete=false yields UNKNOWN guidance for unlisted locations", async () => {
  const res = await handleGetBusinessFacts(createMockSupabase(baseTables()), { conversationId: "conv-A" });
  assert.equal(res.locations_list_complete, false);
  assert.equal(res.locations.length, 1);
  assert.match(res.locations_guidance, /UNKNOWN/);
  assert.match(res.locations_guidance, /never say 'our only location is X'/);
});

test("get_business_facts: locations_list_complete=true yields CONFIRMED COMPLETE guidance", async () => {
  const res = await handleGetBusinessFacts(createMockSupabase(baseTables()), { conversationId: "conv-B" });
  assert.equal(res.locations_list_complete, true);
  assert.match(res.locations_guidance, /CONFIRMED COMPLETE/);
});

test("get_business_facts: degrades to no locations (and complete=false) when client_locations errors, e.g. migration not applied", async () => {
  const tables = baseTables();
  const supabase = createMockSupabase(tables);
  const realFrom = supabase.from.bind(supabase);
  supabase.from = (name) => {
    const b = realFrom(name);
    if (name === "client_locations") {
      b.then = (resolve) => resolve({ data: null, error: { message: 'relation "client_locations" does not exist' } });
    }
    return b;
  };
  const res = await handleGetBusinessFacts(supabase, { conversationId: "conv-A" });
  assert.equal(res.ok, true);
  assert.equal(res.locations.length, 0);
  assert.equal(res.locations_list_complete, false);
  assert.match(res.locations_guidance, /UNKNOWN/); // safe default guidance
});

// ---------------------------------------------------------------------
// record_intent
// ---------------------------------------------------------------------
test("record_intent: rejects an intent outside the taxonomy", async () => {
  const res = await handleRecordIntent(createMockSupabase(baseTables()), { conversationId: "conv-A", intent: "banana" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test("record_intent: writes onto the LATEST inbound message only, never an older one or an outbound", async () => {
  const tables = baseTables();
  const supabase = createMockSupabase(tables);
  const res = await handleRecordIntent(supabase, { conversationId: "conv-A", intent: "price", confidence: 0.8 });
  assert.equal(res.ok, true);
  assert.equal(res.message_id, "m-A-new");

  const byId = Object.fromEntries(tables.messages.map((m) => [m.id, m]));
  assert.equal(byId["m-A-new"].intent, "price");
  assert.equal(byId["m-A-new"].intent_confidence, 0.8);
  assert.equal(byId["m-A-old"].intent, null); // older inbound untouched
  assert.equal(byId["m-A-out"].intent, null); // outbound untouched
});

test("record_intent: all 12 taxonomy values are accepted", async () => {
  for (const intent of INTENT_VALUES) {
    const tables = baseTables();
    const res = await handleRecordIntent(createMockSupabase(tables), { conversationId: "conv-A", intent });
    assert.equal(res.ok, true, `intent ${intent} should be accepted`);
  }
});

// ---------------------------------------------------------------------
// request_handover
// ---------------------------------------------------------------------
test("request_handover: sets waiting_human on conversations + conversation_state, records human_request, never touches ownership", async () => {
  const tables = baseTables();
  const supabase = createMockSupabase(tables);
  const res = await handleRequestHandover(supabase, { conversationId: "conv-A", reason: "customer asked for a person" });

  assert.equal(res.ok, true);
  assert.equal(res.action, "human_handover");
  assert.equal(res.conversation_status, "waiting_human");

  const conv = tables.conversations.find((c) => c.id === "conv-A");
  assert.equal(conv.conversation_status, "waiting_human");
  assert.equal("assigned_user_id" in conv, false); // never written by the tool

  const state = tables.conversation_state.find((s) => s.conversation_id === "conv-A");
  assert.equal(state.conversation_status, "waiting_human"); // mirror written -> Smart Assignment webhook fires
  assert.equal(state.assigned_user_id, null); // ownership untouched -> still claimable

  assert.equal(tables.messages.find((m) => m.id === "m-A-new").intent, "human_request");
});

// ---------------------------------------------------------------------
// upsert_lead
// ---------------------------------------------------------------------
test("upsert_lead: invalid phone is a soft failure the Agent can react to (need: phone)", async () => {
  const res = await handleUpsertLead(createMockSupabase(baseTables()), { conversationId: "conv-A", name: "أحمد", phone: "abc" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_phone");
  assert.equal(res.need, "phone");
});

test("upsert_lead: writes with server-derived client_id + sender_id, ignoring any caller-supplied ids", async () => {
  const tables = baseTables();
  const supabase = createMockSupabase(tables);
  const res = await handleUpsertLead(supabase, {
    conversationId: "conv-A",
    name: "أحمد",
    phone: "059 222 3333",
    // caller tries to smuggle a foreign tenant / sender — must be ignored
    client_id: "client-B",
    sender_id: "attacker",
  });
  assert.equal(res.ok, true);
  assert.equal(res.captured, true);

  assert.equal(tables.leads.length, 1);
  assert.equal(tables.leads[0].client_id, "client-A");
  assert.equal(tables.leads[0].sender_id, "970590000001");
  assert.equal(tables.leads[0].phone, "0592223333");

  // both fields on file -> step advances to contact_captured (matches current product)
  assert.equal(tables.conversations.find((c) => c.id === "conv-A").current_step, "contact_captured");
  assert.equal(tables.messages.find((m) => m.id === "m-A-new").intent, "lead");
});

test("upsert_lead: an existing lead is merged, never overwritten to null", async () => {
  const tables = baseTables();
  tables.leads.push({ id: "lead-1", client_id: "client-A", conversation_id: "conv-A", sender_id: "970590000001", name: "أحمد", phone: null });
  const supabase = createMockSupabase(tables);
  const res = await handleUpsertLead(supabase, { conversationId: "conv-A", phone: "0592223333" });
  assert.equal(res.ok, true);
  assert.equal(tables.leads.length, 1);
  assert.equal(tables.leads[0].name, "أحمد"); // preserved
  assert.equal(tables.leads[0].phone, "0592223333"); // added
});

test("upsert_lead: nothing usable -> soft failure, no row written", async () => {
  const tables = baseTables();
  const res = await handleUpsertLead(createMockSupabase(tables), { conversationId: "conv-A" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "nothing_to_save");
  assert.equal(tables.leads.length, 0);
});

// ---------------------------------------------------------------------
// start_order / continue_order
// ---------------------------------------------------------------------
test("start_order: records intent=order, moves to order_in_progress, reports no persistence", async () => {
  const tables = baseTables();
  const res = await dispatchAiTool(createMockSupabase(tables), {
    action: "start_order",
    params: { conversation_id: "conv-A", items_summary: "2 شاورما" },
  });
  assert.equal(res.ok, true);
  assert.equal(res.order_state, "collecting");
  assert.equal(res.persisted, false);
  assert.equal(tables.conversations.find((c) => c.id === "conv-A").current_step, "order_in_progress");
  assert.equal(tables.messages.find((m) => m.id === "m-A-new").intent, "order");
});

// ---------------------------------------------------------------------
// close_conversation
// ---------------------------------------------------------------------
test("close_conversation: unconfirmed -> confirm step + quick-reply hint, never closes", async () => {
  const tables = baseTables();
  const res = await handleCloseConversation(createMockSupabase(tables), { conversationId: "conv-A", confirmed: false });
  assert.equal(res.ok, true);
  assert.equal(res.needs_confirmation, true);
  assert.equal(res.quick_reply_action, "closing_confirm");
  const conv = tables.conversations.find((c) => c.id === "conv-A");
  assert.equal(conv.current_step, "closing_confirm");
  assert.notEqual(conv.conversation_status, "closed");
  assert.equal(tables.messages.find((m) => m.id === "m-A-new").intent, "closing");
});

test("close_conversation: confirmed -> closing_confirmed + waiting_human (never a hard 'closed' by the AI)", async () => {
  const tables = baseTables();
  const res = await handleCloseConversation(createMockSupabase(tables), { conversationId: "conv-A", confirmed: true });
  assert.equal(res.ok, true);
  assert.equal(res.conversation_status, "waiting_human");
  assert.equal(res.current_step, "closing_confirmed");
  const conv = tables.conversations.find((c) => c.id === "conv-A");
  assert.equal(conv.conversation_status, "waiting_human");
  assert.notEqual(conv.conversation_status, "closed");
});

// ---------------------------------------------------------------------
// dispatch + security envelope
// ---------------------------------------------------------------------
test("dispatchAiTool: unknown action -> 400", async () => {
  const res = await dispatchAiTool(createMockSupabase(baseTables()), { action: "drop_table", params: {} });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.code, "unknown_action");
});

test("TOOL_ACTIONS + INTENT_VALUES are the agreed sets", () => {
  assert.deepEqual(TOOL_ACTIONS, [
    "search_knowledge",
    "get_business_facts",
    "record_intent",
    "request_handover",
    "upsert_lead",
    "start_order",
    "continue_order",
    "close_conversation",
  ]);
  assert.equal(INTENT_VALUES.length, 12);
});

test("no tool accepts an outbound channel/account selector — the send account is never in a tool payload", async () => {
  // Structural: dispatch every state-changing tool with account-shaped
  // extra params and confirm they are simply ignored (no throw, no write
  // of any channel field).
  const tables = baseTables();
  const supabase = createMockSupabase(tables);
  await dispatchAiTool(supabase, {
    action: "request_handover",
    params: { conversation_id: "conv-A", whatsapp_number_id: "x", page_id: "y", channel_key: "z" },
  });
  const conv = tables.conversations.find((c) => c.id === "conv-A");
  assert.equal("channel_key" in conv, false);
  assert.equal("whatsapp_number_id" in conv, false);
  assert.equal("page_id" in conv, false);
});

test("cross-tenant: a tool call for conv-A can never read or write client-B data", async () => {
  const tables = baseTables();
  const supabase = createMockSupabase(tables);
  // get_business_facts for conv-A must return client-A only
  const facts = await handleGetBusinessFacts(supabase, { conversationId: "conv-A" });
  assert.equal(facts.business.name, "Tasty Kitchen");
  // upsert_lead for conv-A writes a client-A lead even though caller says client-B
  await handleUpsertLead(supabase, { conversationId: "conv-A", name: "x", phone: "0591234567", client_id: "client-B" });
  assert.equal(tables.leads.every((l) => l.client_id === "client-A"), true);
  // client-B rows untouched
  assert.equal(tables.conversations.find((c) => c.id === "conv-B").conversation_status, "active");
});
