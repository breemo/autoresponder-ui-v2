import test from "node:test";
import assert from "node:assert/strict";
import { reopenGuardResponse } from "../conversationLifecycle.js";

// Unit coverage for the manual-reopen guard mapping added alongside
// supabase/migrations/20260907_manual_reopen_2h_window.sql. Pure function,
// no Supabase / network — verifies each deterministic RPC outcome becomes
// the intended controlled HTTP response (never a 500).

test("non-reopen actions are never guarded here", () => {
  assert.equal(reopenGuardResponse("close", { outcome: "expired" }), null);
  assert.equal(reopenGuardResponse("takeover", { outcome: "conflict" }), null);
  assert.equal(reopenGuardResponse("claim", { outcome: "already_open" }), null);
});

test("missing / ok / not_found / forbidden reopen outcomes fall through (null)", () => {
  assert.equal(reopenGuardResponse("reopen", null), null);
  assert.equal(reopenGuardResponse("reopen", undefined), null);
  assert.equal(reopenGuardResponse("reopen", { outcome: "ok" }), null);
  assert.equal(reopenGuardResponse("reopen", { outcome: "not_found" }), null);
  assert.equal(reopenGuardResponse("reopen", { outcome: "forbidden" }), null);
});

test("reopen 'expired' -> 409 REOPEN_WINDOW_EXPIRED with an archive explanation", () => {
  const r = reopenGuardResponse("reopen", { outcome: "expired" });
  assert.equal(r.status, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, "REOPEN_WINDOW_EXPIRED");
  assert.match(r.body.message, /ساعتين|مؤرشف/);
});

test("reopen 'conflict' -> 409 ANOTHER_CONVERSATION_OPEN (no raw 23505 to the client)", () => {
  const r = reopenGuardResponse("reopen", { outcome: "conflict" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ANOTHER_CONVERSATION_OPEN");
  assert.equal(r.body.success, false);
  assert.equal(typeof r.body.message, "string");
  assert.ok(r.body.message.length > 0);
});

test("reopen 'already_open' -> 409 CONVERSATION_NOT_CLOSED", () => {
  const r = reopenGuardResponse("reopen", { outcome: "already_open" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "CONVERSATION_NOT_CLOSED");
  assert.equal(r.body.success, false);
});

test("an unknown reopen outcome falls through rather than inventing a response", () => {
  assert.equal(reopenGuardResponse("reopen", { outcome: "something_new" }), null);
});
