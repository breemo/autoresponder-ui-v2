import test from "node:test";
import assert from "node:assert/strict";
import { buildAiContextResponse, buildLocationsDiagnostics } from "../../ai-context.js";

// Workflow Cutover — Step 1: proves api/ai-context.js's response now
// includes server-built OpenAI messages (via buildPromptMessages())
// alongside the unchanged `context` field, without needing a real
// Supabase client — buildAiContextResponse is pure (context in,
// {success, context, messages} out). resolveAiContext() itself is not
// touched or re-tested here (already covered by aiContext.test.js);
// buildPromptMessages()'s own prompt content is already exhaustively
// covered by promptBuilder.test.js — these tests only prove the two are
// correctly wired together in the endpoint's response shape.

function makeContext(overrides = {}) {
  return {
    client: {
      id: "client-1",
      business_name: "Tasty Kitchen",
      business_description: "A real Palestinian restaurant serving mezze and grills.",
      phone: "0591234567",
      address: "Main Street, Hebron",
      website: "https://tastykitchen.example",
      timezone: "Asia/Hebron",
      working_hours: null,
      working_hours_text: "Timezone: Asia/Hebron\nSunday–Thursday: 09:00–17:00\nFriday: Closed",
      ...overrides.client,
    },
    account: {
      platform: "whatsapp",
      channel_key: "wa-123",
      display_name: "Tasty WhatsApp",
      reply_mode: "ai",
      reply_mode_source: "account",
      is_active: true,
      ...overrides.account,
    },
    ai_behavior: {
      personality: null,
      reply_tone: null,
      default_language: null,
      forbidden_rules: [],
      special_instructions: null,
      booking_instructions: null,
      escalation_instructions: null,
      ...overrides.ai_behavior,
    },
    conversation: {
      id: "conv-1",
      status: "active",
      current_step: null,
      history: [],
      current_message_text: "",
      ...overrides.conversation,
    },
    relevant_knowledge: overrides.relevant_knowledge ?? [],
  };
}

test("1. successful response includes a messages field", () => {
  const response = buildAiContextResponse(makeContext());
  assert.ok(Array.isArray(response.messages));
  assert.ok(response.messages.length > 0);
});

test("2. messages[0].role === 'system'", () => {
  const response = buildAiContextResponse(makeContext());
  assert.equal(response.messages[0].role, "system");
});

test("3. history appears as role-separated messages", () => {
  const context = makeContext({
    conversation: {
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello, how can I help?" },
      ],
      current_message_text: "do you deliver outside Nablus?",
    },
  });
  const response = buildAiContextResponse(context);
  assert.deepEqual(
    response.messages.map((m) => m.role),
    ["system", "user", "assistant", "user"]
  );
  assert.equal(response.messages[1].content, "hi");
  assert.equal(response.messages[2].content, "hello, how can I help?");
});

test("4. current user message is last", () => {
  const context = makeContext({
    conversation: {
      history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello!" }],
      current_message_text: "كم سعر وجبة المشاوي المشكلة؟",
    },
  });
  const response = buildAiContextResponse(context);
  const last = response.messages[response.messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content, "كم سعر وجبة المشاوي المشكلة؟");
});

test("5. Knowledge Base excerpts appear in the system message when relevant_knowledge exists", () => {
  const context = makeContext({
    relevant_knowledge: [
      { document_title: "Delivery Policy", category: "policy", content: "We do not deliver outside Nablus.", similarity: 0.9 },
    ],
  });
  const response = buildAiContextResponse(context);
  assert.match(response.messages[0].content, /## RELEVANT KNOWLEDGE BASE EXCERPTS/);
  assert.match(response.messages[0].content, /We do not deliver outside Nablus\./);
});

test("6. no relevant knowledge still returns valid messages, with no excerpts section", () => {
  const response = buildAiContextResponse(makeContext({ relevant_knowledge: [] }));
  assert.ok(Array.isArray(response.messages));
  assert.ok(response.messages.length > 0);
  assert.equal(response.messages[0].role, "system");
  assert.doesNotMatch(response.messages[0].content, /## RELEVANT KNOWLEDGE BASE EXCERPTS/);
});

test("7. the existing context field remains present and unchanged (same reference, not cloned/altered)", () => {
  const context = makeContext();
  const response = buildAiContextResponse(context);
  assert.equal(response.context, context);
  assert.equal(response.success, true);
});

// ---------------------------------------------------------------------
// TEMPORARY DIAGNOSTIC — buildLocationsDiagnostics (Locations bug).
// Remove alongside the diagnostic block in api/ai-context.js.
// ---------------------------------------------------------------------

function makeLocationsContext(overrides = {}) {
  return makeContext({
    client: {
      locations: [{ name: "فرع نابلس", city: "نابلس", is_primary: true }],
      locations_list_complete: false,
      ...overrides.client,
    },
    conversation: {
      history: overrides.history ?? [],
      current_message_text: overrides.current_message_text ?? "عندكم فرع في رام الله؟",
    },
    relevant_knowledge: overrides.relevant_knowledge,
  });
}

test("LOCDIAG 1. reports runtime locations_list_complete=false and INCOMPLETE block marker", () => {
  const context = makeLocationsContext();
  const response = buildAiContextResponse(context);
  const diag = buildLocationsDiagnostics(context, response.messages);

  assert.equal(diag.locations_list_complete, false);
  assert.equal(diag.locations_count, 1);
  assert.deepEqual(diag.locations, [{ name: "فرع نابلس", city: "نابلس", is_primary: true }]);
  assert.equal(diag.locations_block_present, true);
  assert.equal(diag.locations_completeness_marker, "INCOMPLETE");
});

test("LOCDIAG 2. detects the 807c5c0 grounding rules in the built system prompt", () => {
  const context = makeLocationsContext();
  const response = buildAiContextResponse(context);
  const diag = buildLocationsDiagnostics(context, response.messages);

  assert.equal(diag.rule_single_location_present, true);
  assert.equal(diag.rule_earlier_replies_present, true);
  assert.equal(diag.rule_kb_address_present, true);
});

test("LOCDIAG 3. COMPLETE marker when locations_list_complete=true", () => {
  const context = makeLocationsContext({ client: { locations_list_complete: true } });
  const response = buildAiContextResponse(context);
  const diag = buildLocationsDiagnostics(context, response.messages);

  assert.equal(diag.locations_list_complete, true);
  assert.equal(diag.locations_completeness_marker, "COMPLETE");
});

test("LOCDIAG 4. NONE marker and no block when zero locations configured", () => {
  const context = makeContext({ conversation: { current_message_text: "عندكم فرع في رام الله؟" } });
  const response = buildAiContextResponse(context);
  const diag = buildLocationsDiagnostics(context, response.messages);

  assert.equal(diag.locations_count, 0);
  assert.equal(diag.locations_block_present, false);
  assert.equal(diag.locations_completeness_marker, "NONE");
});

test("LOCDIAG 5. flags earlier assistant exclusivity turns replayed into history (Arabic)", () => {
  const context = makeLocationsContext({
    history: [
      { role: "user", content: "عندكم فرع في رام الله؟" },
      { role: "assistant", content: "لا، ليس لدينا فرع في رام الله. موقعنا الوحيد هو في نابلس." },
      { role: "user", content: "طيب وبالنسبة رام الله؟" },
    ],
  });
  const response = buildAiContextResponse(context);
  const diag = buildLocationsDiagnostics(context, response.messages);

  assert.equal(diag.history_count, 3);
  assert.deepEqual(diag.history_roles, ["user", "assistant", "user"]);
  assert.equal(diag.assistant_exclusivity_hit_count, 1);
  assert.equal(diag.assistant_exclusivity_hits[0].index, 1);
  assert.match(diag.assistant_exclusivity_hits[0].preview, /موقعنا الوحيد/);
});

test("LOCDIAG 6. does not flag a clean history and never logs customer message bodies", () => {
  const context = makeLocationsContext({
    history: [
      { role: "user", content: "مرحبا، بدي اسأل عن رقم سري 123456" },
      { role: "assistant", content: "أهلاً بك! كيف أقدر أساعدك؟" },
    ],
  });
  const response = buildAiContextResponse(context);
  const diag = buildLocationsDiagnostics(context, response.messages);

  assert.equal(diag.assistant_exclusivity_hit_count, 0);
  assert.deepEqual(diag.assistant_exclusivity_hits, []);
  // only roles are captured from history — no user content leaks into the diag object
  assert.equal(JSON.stringify(diag).includes("رقم سري"), false);
});

test("LOCDIAG 7. reports KB titles/categories only, and total message count", () => {
  const context = makeLocationsContext({
    relevant_knowledge: [
      { document_title: "معلومات عامة", category: "faq", content: "الموقع: نابلس", similarity: 0.6 },
    ],
    history: [
      { role: "user", content: "مرحبا" },
      { role: "assistant", content: "أهلاً" },
    ],
  });
  const response = buildAiContextResponse(context);
  const diag = buildLocationsDiagnostics(context, response.messages);

  assert.equal(diag.kb_count, 1);
  assert.deepEqual(diag.kb_items, [{ document_title: "معلومات عامة", category: "faq" }]);
  assert.equal(JSON.stringify(diag.kb_items).includes("نابلس"), false);
  assert.equal(diag.messages_total, response.messages.length);
});

test("LOCDIAG 8. never throws on a malformed/empty context", () => {
  assert.doesNotThrow(() => buildLocationsDiagnostics(undefined, undefined));
  assert.doesNotThrow(() => buildLocationsDiagnostics({}, []));
  const diag = buildLocationsDiagnostics({ client: {}, conversation: {} }, null);
  assert.equal(diag.locations_count, 0);
  assert.equal(diag.messages_total, 0);
});
