import test from "node:test";
import assert from "node:assert/strict";
import { createMockSupabase } from "./mockSupabase.js";
import { loadConversationGate, humanTakeoverBlock } from "../conversationOwnership.js";

// Employee outbound authorization (text human reply + media sign_upload).
// Both api/_lib/humanReply.js and api/media.js#handleSignUpload gate on
// loadConversationGate() + humanTakeoverBlock(). Rule: human outbound is
// allowed ONLY on a waiting_human conversation the acting employee owns
// (assigned_user_id === actor). Everything else is blocked.

const ME = "user-me";
const OTHER = "user-other";

// ---------------------------------------------------------------------
// humanTakeoverBlock — the rule (pure, no Supabase)
// ---------------------------------------------------------------------

test("not-found gate -> null (caller emits its own 404)", () => {
  assert.equal(humanTakeoverBlock({ found: false }, ME), null);
  assert.equal(humanTakeoverBlock(undefined, ME), null);
});

test("active + unassigned -> DENIED (AUTOMATION_HANDLING) — the core bug", () => {
  const b = humanTakeoverBlock(
    { found: true, conversation_status: "active", assigned_user_id: null },
    ME
  );
  assert.ok(b);
  assert.equal(b.code, "AUTOMATION_HANDLING");
});

test("active + (somehow) assigned to me -> still DENIED (status must be waiting_human)", () => {
  const b = humanTakeoverBlock(
    { found: true, conversation_status: "active", assigned_user_id: ME },
    ME
  );
  assert.ok(b);
  assert.equal(b.code, "AUTOMATION_HANDLING");
});

test("waiting_human + unassigned (shared queue) -> DENIED (MUST_CLAIM_FIRST)", () => {
  const b = humanTakeoverBlock(
    { found: true, conversation_status: "waiting_human", assigned_user_id: null },
    ME
  );
  assert.ok(b);
  assert.equal(b.code, "MUST_CLAIM_FIRST");
});

test("waiting_human + assigned to another employee -> DENIED (ASSIGNED_TO_OTHER)", () => {
  const b = humanTakeoverBlock(
    { found: true, conversation_status: "waiting_human", assigned_user_id: OTHER },
    ME
  );
  assert.ok(b);
  assert.equal(b.code, "ASSIGNED_TO_OTHER");
});

test("waiting_human + assigned to current employee -> ALLOWED (null)", () => {
  assert.equal(
    humanTakeoverBlock(
      { found: true, conversation_status: "waiting_human", assigned_user_id: ME },
      ME
    ),
    null
  );
});

test("closed -> DENIED (CONVERSATION_CLOSED)", () => {
  const b = humanTakeoverBlock(
    { found: true, conversation_status: "closed", assigned_user_id: ME },
    ME
  );
  assert.ok(b);
  assert.equal(b.code, "CONVERSATION_CLOSED");
});

test("system_assigned_user_id (recommendation) NEVER grants send permission", () => {
  // waiting_human, recommended to me, but not actually claimed -> DENIED.
  const b1 = humanTakeoverBlock(
    {
      found: true,
      conversation_status: "waiting_human",
      assigned_user_id: null,
      system_assigned_user_id: ME,
    },
    ME
  );
  assert.equal(b1.code, "MUST_CLAIM_FIRST");

  // active, recommended to me -> DENIED.
  const b2 = humanTakeoverBlock(
    {
      found: true,
      conversation_status: "active",
      assigned_user_id: null,
      system_assigned_user_id: ME,
    },
    ME
  );
  assert.equal(b2.code, "AUTOMATION_HANDLING");
});

test("null actor vs null assignee must not fall through to ALLOWED", () => {
  const b = humanTakeoverBlock(
    { found: true, conversation_status: "waiting_human", assigned_user_id: null },
    null
  );
  assert.ok(b);
  assert.equal(b.code, "MUST_CLAIM_FIRST");
});

// ---------------------------------------------------------------------
// loadConversationGate — authoritative source + multi-tenant isolation
// ---------------------------------------------------------------------

function supaWith({ conversations = [], conversation_state = [] } = {}) {
  return createMockSupabase({ conversations, conversation_state });
}

test("reads conversation_status/assigned_user_id from public.conversations first", async () => {
  const supa = supaWith({
    conversations: [
      { id: "c1", client_id: "A", conversation_status: "waiting_human", assigned_user_id: ME },
    ],
    conversation_state: [
      // deliberately stale / disagreeing legacy mirror — must be ignored
      { conversation_id: "c1", client_id: "A", conversation_status: "closed", assigned_user_id: OTHER },
    ],
  });
  const gate = await loadConversationGate(supa, "A", "c1");
  assert.equal(gate.found, true);
  assert.equal(gate.source, "conversations");
  assert.equal(gate.conversation_status, "waiting_human");
  assert.equal(gate.assigned_user_id, ME);
});

test("multi-tenant isolation: a conversation under another client -> { found: false }", async () => {
  const supa = supaWith({
    conversations: [
      { id: "c1", client_id: "A", conversation_status: "waiting_human", assigned_user_id: ME },
    ],
  });
  const gate = await loadConversationGate(supa, "B", "c1");
  assert.equal(gate.found, false);
});

test("falls back to conversation_state only when there is no conversations row", async () => {
  const supa = supaWith({
    conversations: [],
    conversation_state: [
      { conversation_id: "old1", client_id: "A", conversation_status: "waiting_human", assigned_user_id: ME },
    ],
  });
  const gate = await loadConversationGate(supa, "A", "old1");
  assert.equal(gate.found, true);
  assert.equal(gate.source, "conversation_state");
  assert.equal(gate.assigned_user_id, ME);
});

test("end-to-end: auto-reopened conversation (active, unassigned) blocks outbound", async () => {
  const supa = supaWith({
    conversations: [
      { id: "re1", client_id: "A", conversation_status: "active", assigned_user_id: null },
    ],
  });
  const gate = await loadConversationGate(supa, "A", "re1");
  const block = humanTakeoverBlock(gate, ME);
  assert.ok(block);
  assert.equal(block.code, "AUTOMATION_HANDLING");
});

test("end-to-end: after Transfer + Claim (waiting_human, owned) outbound is allowed", async () => {
  const supa = supaWith({
    conversations: [
      { id: "re1", client_id: "A", conversation_status: "waiting_human", assigned_user_id: ME },
    ],
  });
  const gate = await loadConversationGate(supa, "A", "re1");
  assert.equal(humanTakeoverBlock(gate, ME), null);
});
