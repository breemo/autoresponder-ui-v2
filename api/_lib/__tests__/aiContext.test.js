import test from "node:test";
import assert from "node:assert/strict";
import { resolveAiContext, formatWorkingHoursText } from "../aiContext.js";
import { createMockSupabase } from "./mockSupabase.js";

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
