import test from "node:test";
import assert from "node:assert/strict";
import { resolveConversationRoute } from "../../conversation.js";

// Vercel Hobby Function-count consolidation (Merge #2) — verifies every
// old top-level API URL's request shape still maps to the intended
// consolidated action after api/conversations.js, api/conversation-
// lifecycle.js, and api/human-reply.js were folded into api/conversation.js.
// Network-free: resolveConversationRoute is a pure function, no Supabase
// involved.

test("GET ?resource=list routes to the former api/conversations.js logic", () => {
  const route = resolveConversationRoute({ method: "GET", query: { resource: "list", actor_user_id: "u1" } });
  assert.equal(route, "list");
});

test("POST action=claim routes to the former api/conversation-lifecycle.js logic", () => {
  const route = resolveConversationRoute({ method: "POST", body: { action: "claim", conversation_id: "c1" } });
  assert.equal(route, "lifecycle");
});

for (const action of ["close", "reopen", "takeover"]) {
  test(`POST action=${action} routes to the former api/conversation-lifecycle.js logic`, () => {
    const route = resolveConversationRoute({ method: "POST", body: { action, conversation_id: "c1" } });
    assert.equal(route, "lifecycle");
  });
}

test("POST action=human_reply routes to the former api/human-reply.js logic", () => {
  const route = resolveConversationRoute({ method: "POST", body: { action: "human_reply", conversation_id: "c1", message: "hi" } });
  assert.equal(route, "human_reply");
});

test("GET with no resource routes to this file's own Conversation Card logic (unchanged)", () => {
  const route = resolveConversationRoute({ method: "GET", query: { conversation_id: "c1" } });
  assert.equal(route, "self");
});

test("GET ?resource=notes routes to this file's own notes logic (unchanged)", () => {
  const route = resolveConversationRoute({ method: "GET", query: { resource: "notes", conversation_id: "c1" } });
  assert.equal(route, "self");
});

for (const action of ["add_note", "edit_note", "delete_note"]) {
  test(`POST action=${action} routes to this file's own notes logic (unchanged)`, () => {
    const route = resolveConversationRoute({ method: "POST", body: { action } });
    assert.equal(route, "self");
  });
}

test("an unrecognized POST action falls through to this file's own dispatch, which still returns a controlled 'Unknown action' error", () => {
  const route = resolveConversationRoute({ method: "POST", body: { action: "not_a_real_action" } });
  assert.equal(route, "self");
});

test("PUT/DELETE never match a delegated sub-domain — self dispatch still enforces 'Method not allowed'", () => {
  assert.equal(resolveConversationRoute({ method: "PUT", query: {}, body: {} }), "self");
  assert.equal(resolveConversationRoute({ method: "DELETE", query: {}, body: {} }), "self");
});

test("resource=list only matches on GET, never on POST (POST ?resource=list with no matching action falls through to self)", () => {
  const route = resolveConversationRoute({ method: "POST", query: { resource: "list" }, body: {} });
  assert.equal(route, "self");
});
