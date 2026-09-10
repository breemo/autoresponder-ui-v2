import test from "node:test";
import assert from "node:assert/strict";
import { resolveAiContext, formatWorkingHoursText } from "../aiContext.js";
import { createMockSupabase } from "./mockSupabase.js";
import { EMBEDDING_DIMENSIONS } from "../openaiEmbeddings.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

// Stubs the embeddings HTTP call only — resolveAiContext's own DB access
// still goes through the mock supabase client passed to it.
function mockEmbeddingFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.01) }] }),
  });
  process.env.OPENAI_API_KEY = "test-key";
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
}

// Shared fixture set. Two conversations for the same client on two
// different platforms — facebook (has its own reply_mode column, Stage 1)
// and whatsapp (does not — see aiContext.js's PLATFORM_ACCOUNT_MAP
// comment) — so both branches of the reply_mode resolution logic are
// exercised against real resolveAiContext() calls, not just the helper
// in isolation.
function baseTables() {
  return {
    conversations: [
      { id: "conv-1", client_id: "client-1", contact_id: "contact-1", channel_identity_id: "ci-1", platform: "facebook", conversation_status: "active", current_step: null },
      { id: "conv-2", client_id: "client-1", contact_id: "contact-1", channel_identity_id: "ci-2", platform: "whatsapp", conversation_status: "active", current_step: null },
    ],
    contact_channel_identities: [
      { id: "ci-1", client_id: "client-1", contact_id: "contact-1", platform: "facebook", channel_key: "page-123", display_name: "Page Name" },
      { id: "ci-2", client_id: "client-1", contact_id: "contact-1", platform: "whatsapp", channel_key: "wa-key-1", display_name: null },
    ],
    clients: [
      {
        id: "client-1",
        business_name: "Tasty Kitchen",
        business_description: "A real Palestinian restaurant serving mezze and grills.",
        phone: "0591234567",
        address: "Main Street, Hebron",
        website: "https://tastykitchen.example",
        timezone: "Asia/Hebron",
        working_hours: {
          timezone: "Asia/Hebron",
          days: {
            sunday: [{ open: "09:00", close: "17:00" }],
            monday: [{ open: "09:00", close: "17:00" }],
            tuesday: [{ open: "09:00", close: "17:00" }],
            wednesday: [{ open: "09:00", close: "17:00" }],
            thursday: [{ open: "09:00", close: "17:00" }],
            friday: [],
            saturday: [{ open: "09:00", close: "17:00" }],
          },
        },
      },
    ],
    client_ai_behavior: [
      { client_id: "client-1", personality: "warm and welcoming", reply_tone: "friendly", default_language: "ar", forbidden_rules: ["never quote a price"], special_instructions: null, booking_instructions: null, escalation_instructions: null },
    ],
    client_facebook: [
      { id: "fb-1", client_id: "client-1", channel_key: "page-123", display_name: "Tasty FB Page", reply_mode: "ai", is_active: true, connection_status: null },
    ],
    client_whatsapp: [
      { id: "wa-1", client_id: "client-1", channel_key: "wa-key-1", display_name: "Main WhatsApp", phone: "0591234567", is_active: true },
    ],
    features: [
      { id: "feat-fb", slug: "facebook" },
      { id: "feat-wa", slug: "whatsapp_evolution" },
    ],
    client_feature_integrations: [
      // Deliberately holds DECOY Business Profile values that must NEVER
      // surface in the returned context (test 10) — this row's config
      // mirrors exactly the kind of drift Phase 0 found live.
      { id: "cfi-fb", client_id: "client-1", feature_id: "feat-fb", config: { reply_mode: "auto", business_name: "WRONG legacy business name", business_description: "WRONG legacy description — must never appear" } },
      { id: "cfi-wa", client_id: "client-1", feature_id: "feat-wa", config: { reply_mode: "welcome_only" } },
    ],
    messages: [],
  };
}

test("scenario 7: cross-client mismatch is rejected, never used to select data", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "some-other-client", currentMessageText: "hi" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "client_mismatch");
});

test("scenario 8: reply_mode resolves from the account table when populated (facebook)", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.context.account.reply_mode, "ai");
  assert.equal(result.context.account.reply_mode_source, "account");
});

test("context.conversation.contact_on_file spans the CONTACT's conversations (V2), newest lead per field wins, other contacts excluded", async () => {
  // nothing captured anywhere -> null
  const r1 = await resolveAiContext(createMockSupabase(baseTables()), { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(r1.ok, true);
  assert.equal(r1.context.conversation.contact_on_file, null);

  const tables = baseTables();
  // conv-1 and conv-2 are the SAME contact (contact-1); a different contact's conversation is a decoy
  tables.conversations.push({ id: "conv-other", client_id: "client-1", contact_id: "contact-XX", channel_identity_id: "ci-1", platform: "facebook", conversation_status: "closed", current_step: null });
  tables.leads = [
    // captured earlier, on the contact's OTHER conversation — must still be found when resolving conv-1
    { client_id: "client-1", conversation_id: "conv-2", sender_id: "s", name: "إبراهيم", phone: "0599001852", created_at: "2026-02-01T00:00:00Z" },
    // older lead for the same contact — superseded per field
    { client_id: "client-1", conversation_id: "conv-1", sender_id: "s", name: "إبراهيم القديم", phone: null, created_at: "2026-01-01T00:00:00Z" },
    // a DIFFERENT contact's lead — must never leak in
    { client_id: "client-1", conversation_id: "conv-other", sender_id: "s", name: "شخص آخر", phone: "0000000000", created_at: "2026-03-01T00:00:00Z" },
  ];
  const r2 = await resolveAiContext(createMockSupabase(tables), { conversationId: "conv-1", clientId: "client-1", currentMessageText: "بدي تتواصلو معي" });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.context.conversation.contact_on_file, { name: "إبراهيم", phone: "0599001852" });
});

test("scenario 9: reply_mode falls back to legacy config when the account table has no usable reply_mode (whatsapp)", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveAiContext(supabase, { conversationId: "conv-2", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.context.account.reply_mode, "welcome_only");
  assert.equal(result.context.account.reply_mode_source, "legacy");
});

test("scenario 10: Business Profile never comes from client_feature_integrations.config, even when config has decoy values", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.context.client.business_name, "Tasty Kitchen");
  assert.equal(result.context.client.business_description, "A real Palestinian restaurant serving mezze and grills.");
  assert.notEqual(result.context.client.business_name, "WRONG legacy business name");
  assert.notEqual(result.context.client.business_description, "WRONG legacy description — must never appear");
});

test("scenario: relevant_knowledge is always an empty array pre-retrieval", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.context.relevant_knowledge, []);
});

test("scenario: no secrets (tokens/credentials) present anywhere in the returned context", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.context).toLowerCase();
  for (const forbidden of ["token", "secret", "access_token", "bot_token", "password"]) {
    assert.equal(serialized.includes(forbidden), false, `context leaked a "${forbidden}"-named field`);
  }
});

test("scenario 4: working hours normalize into clean grouped text", () => {
  const text = formatWorkingHoursText({
    timezone: "Asia/Hebron",
    days: {
      sunday: [{ open: "09:00", close: "17:00" }],
      monday: [{ open: "09:00", close: "17:00" }],
      tuesday: [{ open: "09:00", close: "17:00" }],
      wednesday: [{ open: "09:00", close: "17:00" }],
      thursday: [{ open: "09:00", close: "17:00" }],
      friday: [],
      saturday: [{ open: "09:00", close: "17:00" }],
    },
  });
  assert.equal(
    text,
    "Timezone: Asia/Hebron\nSunday–Thursday: 09:00–17:00\nFriday: Closed\nSaturday: 09:00–17:00"
  );
});

test("working hours normalization: null/unset input degrades to null, never throws", () => {
  assert.equal(formatWorkingHoursText(null), null);
  assert.equal(formatWorkingHoursText(undefined), null);
  assert.equal(formatWorkingHoursText({}), null);
});

// --- Phase 4B: relevant_knowledge integration -----------------------------

test("relevant_knowledge is populated from semantic retrieval when it succeeds", async (t) => {
  mockEmbeddingFetch();
  t.after(restoreFetch);

  const supabase = createMockSupabase(baseTables());
  supabase.rpc = async (name, params) => {
    assert.equal(name, "match_knowledge_chunks");
    assert.equal(params.p_client_id, "client-1");
    return {
      data: [{ document_id: "doc-1", document_title: "Menu", category: "menu", content: "Grilled chicken plate", similarity: 0.9 }],
      error: null,
    };
  };

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "what food do you serve?" });

  assert.equal(result.ok, true);
  assert.equal(result.context.relevant_knowledge.length, 1);
  assert.equal(result.context.relevant_knowledge[0].content, "Grilled chicken plate");
});

test("retrieval unavailable (RPC failure) degrades to relevant_knowledge: [] WITHOUT failing the whole AI Context request", async (t) => {
  mockEmbeddingFetch();
  t.after(restoreFetch);

  const supabase = createMockSupabase(baseTables());
  supabase.rpc = async () => ({ data: null, error: { message: "relation does not exist" } });

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "what food do you serve?" });

  assert.equal(result.ok, true); // the request itself still succeeds
  assert.deepEqual(result.context.relevant_knowledge, []);
  // Business Profile / AI Behavior are completely unaffected by the
  // Knowledge Base being unavailable.
  assert.equal(result.context.client.business_name, "Tasty Kitchen");
  assert.equal(result.context.ai_behavior.reply_tone, "friendly");
});

test("retrieval unavailable (missing OPENAI_API_KEY, no fetch mock) also degrades safely — business profile still works", async () => {
  const supabase = createMockSupabase(baseTables());
  supabase.rpc = async () => { throw new Error("must not be called without a successful embedding"); };

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "what food do you serve?" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.context.relevant_knowledge, []);
  assert.equal(result.context.client.business_name, "Tasty Kitchen");
});

test("retrieval throwing an unexpected exception still degrades to [] rather than failing the request", async (t) => {
  mockEmbeddingFetch();
  t.after(restoreFetch);

  const supabase = createMockSupabase(baseTables());
  supabase.rpc = async () => { throw new Error("unexpected connection reset"); };

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "what food do you serve?" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.context.relevant_knowledge, []);
});

// --- Tenant isolation at the AI Context layer ------------------------------

test("cross-client isolation: client A's AI context never contains client B's knowledge, even if the RPC is passed the wrong id by mistake", async (t) => {
  mockEmbeddingFetch();
  t.after(restoreFetch);

  const supabase = createMockSupabase(baseTables());
  // Simulates the RPC's own client_id-scoped behavior: it only ever
  // returns rows for the client_id it was actually called with.
  const knowledgeByClient = {
    "client-1": [{ document_id: "doc-a1", document_title: "Client A Menu", category: "menu", content: "Client A's own dish", similarity: 0.9 }],
    "client-2": [{ document_id: "doc-b1", document_title: "Client B Menu", category: "menu", content: "Client B's own dish — must NEVER reach client A", similarity: 0.95 }],
  };
  supabase.rpc = async (name, params) => ({ data: knowledgeByClient[params.p_client_id] || [], error: null });

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "what's on the menu?" });

  assert.equal(result.ok, true);
  const contents = result.context.relevant_knowledge.map((r) => r.content);
  assert.ok(contents.includes("Client A's own dish"));
  assert.ok(!contents.some((c) => c.includes("Client B")), "client B's content must never appear in client A's context");
  // And the RPC itself was always called with client-1's own id, never
  // an id derived from anywhere else.
});

// --- Phase 1: Context-Aware Knowledge Retrieval (end-to-end) --------------
//
// Proves resolveAiContext() actually wires conversation history into the
// text that gets embedded for retrieval — not just that
// buildContextualRetrievalQuery() works in isolation (already covered in
// knowledgeRetrieval.test.js).

test("Phase 1: a conversational follow-up embeds a contextualized query end-to-end, not just the raw current message", async (t) => {
  let capturedInput = null;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    capturedInput = body.input;
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.01) }] }) };
  };
  process.env.OPENAI_API_KEY = "test-key";
  t.after(restoreFetch);

  const tables = baseTables();
  tables.messages = [
    { id: "m1", client_id: "client-1", conversation_id: "conv-1", message: "هل يوجد توصيل خارج نابلس؟", direction: "inbound", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", client_id: "client-1", conversation_id: "conv-1", message: "لا، لا يوجد توصيل خارج مدينة نابلس حالياً.", direction: "outbound", created_at: "2026-01-01T00:00:05Z" },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "طيب بتوصلوا داخل نابلس؟" });

  assert.equal(result.ok, true);
  assert.equal(
    capturedInput?.[0],
    "هل يوجد توصيل خارج نابلس؟ طيب بتوصلوا داخل نابلس؟"
  );
  // Conversation history itself (for the Prompt Builder) is completely
  // unaffected by this — still the raw messages, in order.
  assert.equal(result.context.conversation.history.length, 2);
  assert.equal(result.context.conversation.current_message_text, "طيب بتوصلوا داخل نابلس؟");
});

test("VNext path: useContextualRetrieval:false embeds the RAW current message — no follow-up heuristic rewrite", async (t) => {
  let capturedInput = null;
  globalThis.fetch = async (url, options) => {
    capturedInput = JSON.parse(options.body).input;
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.01) }] }) };
  };
  process.env.OPENAI_API_KEY = "test-key";
  t.after(restoreFetch);

  const tables = baseTables();
  tables.messages = [
    { id: "m1", client_id: "client-1", conversation_id: "conv-1", message: "هل يوجد توصيل خارج نابلس؟", direction: "inbound", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", client_id: "client-1", conversation_id: "conv-1", message: "لا، لا يوجد توصيل خارج مدينة نابلس حالياً.", direction: "outbound", created_at: "2026-01-01T00:00:05Z" },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });

  const result = await resolveAiContext(supabase, {
    conversationId: "conv-1",
    clientId: "client-1",
    currentMessageText: "طيب بتوصلوا داخل نابلس؟",
    useContextualRetrieval: false,
  });

  assert.equal(result.ok, true);
  // The follow-up marker "طيب" is IGNORED on this path — the query is verbatim.
  assert.equal(capturedInput?.[0], "طيب بتوصلوا داخل نابلس؟");
  // history and messages are still fully built for the Agent transcript.
  assert.equal(result.context.conversation.history.length, 2);
});

// --- Business Voice + Authoritative Locations ------------------------------

test("locations A/B: a client with zero client_locations rows still builds a valid profile, with locations_list_complete defaulting false (address alone never implies a complete branch list)", async () => {
  const supabase = createMockSupabase(baseTables()); // no client_locations table/rows at all
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.context.client.address, "Main Street, Hebron");
  assert.deepEqual(result.context.client.locations, []);
  assert.equal(result.context.client.locations_list_complete, false);
});

test("locations C/D/E: multiple active locations appear (primary correctly flagged), an inactive one is excluded", async () => {
  const tables = baseTables();
  tables.clients[0].locations_list_complete = true;
  tables.client_locations = [
    { id: "loc-1", client_id: "client-1", name: "Nablus Branch", address: "Rafidia St", city: "Nablus", phone: null, working_hours: null, is_primary: true, is_active: true, created_at: "2026-01-01T00:00:00Z" },
    { id: "loc-2", client_id: "client-1", name: "Ramallah Branch", address: "Al-Manara", city: "Ramallah", phone: null, working_hours: null, is_primary: false, is_active: true, created_at: "2026-01-02T00:00:00Z" },
    { id: "loc-3", client_id: "client-1", name: "Closed Branch", address: "Old St", city: "Nablus", phone: null, working_hours: null, is_primary: false, is_active: false, created_at: "2026-01-03T00:00:00Z" },
  ];
  const supabase = createMockSupabase(tables);
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });

  assert.equal(result.ok, true);
  const names = result.context.client.locations.map((l) => l.name);
  assert.ok(names.includes("Nablus Branch"));
  assert.ok(names.includes("Ramallah Branch"));
  assert.ok(!names.includes("Closed Branch"), "inactive location must never appear in the AI context");

  const primary = result.context.client.locations.find((l) => l.is_primary);
  assert.equal(primary?.name, "Nablus Branch");
});

test("locations F: locations_list_complete is represented clearly and only true when explicitly set", async () => {
  const tables = baseTables();
  tables.clients[0].locations_list_complete = true;
  tables.client_locations = [
    { id: "loc-1", client_id: "client-1", name: "Nablus Branch", address: "Rafidia St", city: "Nablus", phone: null, working_hours: null, is_primary: true, is_active: true, created_at: "2026-01-01T00:00:00Z" },
  ];
  const supabase = createMockSupabase(tables);
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.context.client.locations_list_complete, true);
});

test("locations: a not-yet-applied migration (client_locations query errors) degrades safely to locations: [] rather than failing AI Context", async () => {
  const tables = baseTables();
  const supabase = createMockSupabase(tables);
  const realFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    if (table === "client_locations") {
      return { select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ order: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }) }) }) }) }) };
    }
    return realFrom(table);
  };

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.context.client.locations, []);
  assert.equal(result.context.client.locations_list_complete, false);
  assert.equal(result.context.client.business_name, "Tasty Kitchen");
});

test("locations I: tenant isolation — client A's context never contains client B's locations", async () => {
  const tables = baseTables();
  tables.client_locations = [
    { id: "loc-a", client_id: "client-1", name: "Client A Branch", address: "A St", city: "Nablus", phone: null, working_hours: null, is_primary: true, is_active: true, created_at: "2026-01-01T00:00:00Z" },
    { id: "loc-b", client_id: "client-2", name: "Client B Branch — must never leak", address: "B St", city: "Ramallah", phone: null, working_hours: null, is_primary: true, is_active: true, created_at: "2026-01-01T00:00:00Z" },
  ];
  const supabase = createMockSupabase(tables);
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  const names = result.context.client.locations.map((l) => l.name);
  assert.ok(names.includes("Client A Branch"));
  assert.ok(!names.some((n) => n.includes("Client B")), "client B's location must never appear in client A's context");
});

// Regression (production locations_list_complete=false bug investigation,
// item 7 of the required test matrix): tenant isolation must hold for the
// completeness FLAG itself, not just the location rows — client A's
// locations_list_complete must never be read from/contaminated by client
// B's row.
test("regression 7: locations_list_complete tenant isolation — client A's flag is never client B's", async () => {
  const tables = baseTables();
  tables.clients.push({ ...tables.clients[0], id: "client-2", business_name: "Other Business", locations_list_complete: true });
  tables.clients[0].locations_list_complete = false;
  tables.client_locations = [
    { id: "loc-a", client_id: "client-1", name: "Nablus Branch", address: "Nablus", city: "Nablus", phone: null, working_hours: null, is_primary: true, is_active: true, created_at: "2026-01-01T00:00:00Z" },
  ];
  const supabase = createMockSupabase(tables);
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.context.client.locations_list_complete, false, "client A must see its own false flag, never client B's true flag");
});

// --- AI Reply Quality V2: media-aware conversation history ---------------

test("V2 history: an inbound media message with no caption becomes a neutral internal placeholder, in order", async () => {
  const tables = baseTables();
  tables.messages = [
    { id: "m1", client_id: "client-1", conversation_id: "conv-1", message: "مرحبا", message_type: "text", direction: "inbound", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", client_id: "client-1", conversation_id: "conv-1", message: "", message_type: "image", direction: "inbound", created_at: "2026-01-01T00:00:05Z" },
    { id: "m3", client_id: "client-1", conversation_id: "conv-1", message: "", message_type: "audio", direction: "inbound", created_at: "2026-01-01T00:00:10Z" },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "شو رأيك فيها؟" });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.context.conversation.history.map((h) => h.content),
    ["مرحبا", "[Customer sent an image]", "[Customer sent an audio message]"]
  );
  assert.equal(result.context.conversation.history.every((h) => h.role === "user"), true);
});

test("V2 history: the internal 'Unsupported media' marker never leaks into AI context", async () => {
  const tables = baseTables();
  tables.messages = [
    { id: "m1", client_id: "client-1", conversation_id: "conv-1", message: "⚠️ وسائط غير مدعومة / Unsupported media", message_type: "text", direction: "inbound", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", client_id: "client-1", conversation_id: "conv-1", message: "بعتتلكم صورة", message_type: "text", direction: "inbound", created_at: "2026-01-01T00:00:05Z" },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "بعتتلكم صورة" });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.context.conversation.history);
  assert.equal(serialized.includes("Unsupported media"), false);
  assert.equal(serialized.includes("وسائط غير مدعومة"), false);
  assert.equal(result.context.conversation.history[0].content, "[Customer sent an attachment]");
});

test("V2 history: a real caption on a media message is kept as-is, not replaced by a placeholder", async () => {
  const tables = baseTables();
  tables.messages = [
    { id: "m1", client_id: "client-1", conversation_id: "conv-1", message: "هاي المنتج يلي بدي اياه", message_type: "image", direction: "inbound", created_at: "2026-01-01T00:00:00Z" },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });

  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "كم سعره؟" });
  assert.equal(result.ok, true);
  assert.equal(result.context.conversation.history[0].content, "هاي المنتج يلي بدي اياه");
});

// --- Regression: SHORT MESSAGE != FOLLOW-UP (generic, end-to-end) --------
//
// Live regression after 474072c: a short standalone topic ("التوصيل")
// following an unrelated prior turn ("...عروض...") inherited the prior
// turn into the retrieval query, so the previous topic's chunk kept being
// retrieved and repeated. A standalone topic must embed ONLY itself; a
// genuine referential follow-up ("كم سعره؟") must still inherit.

function captureEmbeddingInput(t) {
  const state = { input: null };
  globalThis.fetch = async (url, options) => {
    state.input = JSON.parse(options.body).input;
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.01) }] }) };
  };
  process.env.OPENAI_API_KEY = "test-key";
  t.after(restoreFetch);
  return state;
}

function offerHistoryTables() {
  const tables = baseTables();
  tables.messages = [
    { id: "m1", client_id: "client-1", conversation_id: "conv-1", message: "ممكن تحكيلنا اذا في عروض او فعاليات هاي الفترة", direction: "inbound", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", client_id: "client-1", conversation_id: "conv-1", message: "أكيد، عنا عرض عائلي لـ 4-5 أشخاص بـ 150 شيكل.", direction: "outbound", created_at: "2026-01-01T00:00:05Z" },
  ];
  return tables;
}

for (const standalone of ["التوصيل", "وجبات اليوم", "طلب وجبة", "الموقع", "الأسعار", "ساعات العمل", "طرق الدفع"]) {
  test(`retrieval: standalone "${standalone}" after an offer turn embeds only itself`, async (t) => {
    const cap = captureEmbeddingInput(t);
    const supabase = createMockSupabase(offerHistoryTables());
    supabase.rpc = async () => ({ data: [], error: null });
    const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: standalone });
    assert.equal(result.ok, true);
    assert.equal(cap.input?.[0], standalone, "standalone topic must not inherit the offer turn");
  });
}

for (const followup of ["كم سعره؟", "شو بشمل؟"]) {
  test(`retrieval: referential "${followup}" inherits the previous CUSTOMER question only (not the assistant reply)`, async (t) => {
    const cap = captureEmbeddingInput(t);
    const supabase = createMockSupabase(offerHistoryTables());
    supabase.rpc = async () => ({ data: [], error: null });
    const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: followup });
    assert.equal(result.ok, true);
    assert.equal(cap.input?.[0], `ممكن تحكيلنا اذا في عروض او فعاليات هاي الفترة ${followup}`);
    assert.equal(cap.input?.[0].includes("عرض عائلي"), false, "the assistant's previous verbose reply must not be in the retrieval query");
  });
}

test("Phase 1: a standalone factual query embeds unchanged end-to-end, even with unrelated history present", async (t) => {
  let capturedInput = null;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    capturedInput = body.input;
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.01) }] }) };
  };
  process.env.OPENAI_API_KEY = "test-key";
  t.after(restoreFetch);

  const tables = baseTables();
  tables.messages = [
    { id: "m1", client_id: "client-1", conversation_id: "conv-1", message: "هل يوجد توصيل خارج نابلس؟", direction: "inbound", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", client_id: "client-1", conversation_id: "conv-1", message: "لا، لا يوجد توصيل خارج مدينة نابلس حالياً.", direction: "outbound", created_at: "2026-01-01T00:00:05Z" },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });

  await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "كم سعر وجبة المشاوي المشكلة؟" });

  assert.equal(capturedInput?.[0], "كم سعر وجبة المشاوي المشكلة؟");
});

// ---------------------------------------------------------------------
// AI Engine V3 — working-hours context wiring (issue #2)
// ---------------------------------------------------------------------

test("V3 context: configured clients.working_hours reaches context.client.working_hours_text", async () => {
  const supabase = createMockSupabase(baseTables()); // baseTables client-1 has Sun–Sat 09:00–17:00, Fri closed
  supabase.rpc = async () => ({ data: [], error: null });
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "شو ساعات العمل؟" });
  assert.equal(result.ok, true);
  assert.ok(result.context.client.working_hours_text, "working_hours_text must be populated");
  assert.match(result.context.client.working_hours_text, /09:00.*17:00/s);
  assert.match(result.context.client.working_hours_text, /Asia\/Hebron/);
});

test("V3 context: a one-branch business with hours ONLY on its single location surfaces them as business hours", async () => {
  const tables = baseTables();
  tables.clients[0].working_hours = null; // no client-wide hours
  tables.clients[0].timezone = null;
  tables.client_locations = [
    {
      client_id: "client-1",
      name: "الفرع الوحيد",
      address: "شارع رفيديا",
      city: "نابلس",
      phone: "0599000000",
      is_primary: true,
      is_active: true,
      created_at: "2026-01-01",
      working_hours: { timezone: "Asia/Hebron", days: { sunday: [{ open: "08:00", close: "16:00" }], monday: [{ open: "08:00", close: "16:00" }] } },
    },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "امتى بتفتحوا؟" });
  assert.equal(result.ok, true);
  assert.ok(result.context.client.working_hours_text, "single-location hours must be surfaced as business hours");
  assert.match(result.context.client.working_hours_text, /08:00.*16:00/s);
});

test("V3 context: MULTIPLE locations with per-branch hours are NOT collapsed into one business-hours line", async () => {
  const tables = baseTables();
  tables.clients[0].working_hours = null;
  tables.client_locations = [
    { client_id: "client-1", name: "فرع نابلس", city: "نابلس", is_primary: true, is_active: true, created_at: "2026-01-01", working_hours: { days: { sunday: [{ open: "08:00", close: "16:00" }] } } },
    { client_id: "client-1", name: "فرع رام الله", city: "رام الله", is_primary: false, is_active: true, created_at: "2026-01-02", working_hours: { days: { sunday: [{ open: "10:00", close: "18:00" }] } } },
  ];
  const supabase = createMockSupabase(tables);
  supabase.rpc = async () => ({ data: [], error: null });
  const result = await resolveAiContext(supabase, { conversationId: "conv-1", clientId: "client-1", currentMessageText: "ساعات العمل؟" });
  assert.equal(result.ok, true);
  assert.equal(result.context.client.working_hours_text, null); // stays per-location only
  assert.equal(result.context.client.locations.length, 2);
});
