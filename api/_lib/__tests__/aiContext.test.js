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
    "هل يوجد توصيل خارج نابلس؟ لا، لا يوجد توصيل خارج مدينة نابلس حالياً. طيب بتوصلوا داخل نابلس؟"
  );
  // Conversation history itself (for the Prompt Builder) is completely
  // unaffected by this — still the raw messages, in order.
  assert.equal(result.context.conversation.history.length, 2);
  assert.equal(result.context.conversation.current_message_text, "طيب بتوصلوا داخل نابلس؟");
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
