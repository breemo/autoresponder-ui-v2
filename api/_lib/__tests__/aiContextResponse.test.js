import test from "node:test";
import assert from "node:assert/strict";
import { buildAiContextResponse } from "../../ai-context.js";

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
