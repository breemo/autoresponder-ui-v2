import test from "node:test";
import assert from "node:assert/strict";
import { resolveActor } from "../../knowledge-documents.js";
import { createMockSupabase } from "./mockSupabase.js";

function baseTables() {
  return {
    users: [
      { id: "admin-1", role: "admin", must_change_password: false },
      { id: "client-user-1", role: "client", must_change_password: false },
    ],
    client_users: [
      { id: "cu-1", user_id: "client-user-1", client_id: "client-1", role: "owner", is_active: true, permissions_overrides: null },
    ],
    clients: [
      { id: "client-1", plan_id: "plan-1" },
      { id: "client-2", plan_id: "plan-2" },
    ],
    plans: [
      { id: "plan-1", allow_self_edit: true },
      { id: "plan-2", allow_self_edit: false },
    ],
  };
}

test("client isolation: a client actor always resolves to THEIR OWN client_id, ignoring any requestedClientId", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveActor(supabase, { actorUserId: "client-user-1", requestedClientId: "client-2" });
  assert.ok(result.actor);
  assert.equal(result.actor.kind, "client");
  assert.equal(result.actor.clientId, "client-1"); // never "client-2", even though that's what was requested
});

test("client isolation: write access requires the client's plan to allow self-edit", async () => {
  const tables = baseTables();
  // Move the client user onto the plan that does NOT allow self-edit.
  tables.clients[0].plan_id = "plan-2";
  const supabase = createMockSupabase(tables);
  const result = await resolveActor(supabase, { actorUserId: "client-user-1" });
  assert.equal(result.actor.clientId, "client-1");
  assert.equal(result.actor.canWrite, false);
});

test("client isolation: write access is granted when the plan allows self-edit", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveActor(supabase, { actorUserId: "client-user-1" });
  assert.equal(result.actor.canWrite, true);
});

test("admin target access: an admin may target any real client, explicitly supplied", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveActor(supabase, { actorUserId: "admin-1", requestedClientId: "client-2" });
  assert.ok(result.actor);
  assert.equal(result.actor.kind, "admin");
  assert.equal(result.actor.clientId, "client-2");
  assert.equal(result.actor.canWrite, true);
});

test("admin target access: a nonexistent target client is rejected, not silently accepted", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveActor(supabase, { actorUserId: "admin-1", requestedClientId: "no-such-client" });
  assert.equal(result.actor, undefined);
  assert.equal(result.error.status, 404);
});

test("admin target access: client_id is required for an admin actor (no implicit tenant to fall back to)", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveActor(supabase, { actorUserId: "admin-1" });
  assert.equal(result.actor, undefined);
  assert.equal(result.error.status, 400);
});

test("unknown actor is rejected", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveActor(supabase, { actorUserId: "nobody" });
  assert.equal(result.actor, undefined);
  assert.equal(result.error.status, 401);
});

test("missing actor_user_id is rejected", async () => {
  const supabase = createMockSupabase(baseTables());
  const result = await resolveActor(supabase, {});
  assert.equal(result.actor, undefined);
  assert.equal(result.error.status, 401);
});
