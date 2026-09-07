import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { recordManualTransfer } from "../conversationLifecycle.js";

// Two telemetry fixes for Team Productivity V1:
//   1. persist messages.sent_by_user_id from the human-reply webhook value
//      (authoritative n8n "Human Reply - Multi Channel Media" workflow).
//   2. write one append-only conversation_events row (event_type =
//      'transferred') on a manual "Transfer to Agent".
// Neither changes authorization, media/provider routing, or lifecycle
// state transitions.

// ---------------------------------------------------------------------
// Mock supabase — only the calls recordManualTransfer makes.
// ---------------------------------------------------------------------
function makeSupa({ conversations = [], identities = [], updateError = null, insertError = null } = {}) {
  const inserted = { conversation_events: [] };
  return {
    inserted,
    from(table) {
      if (table === "conversations") {
        const f = {};
        const b = {
          update(p) { b._patch = p; return b; },
          eq(c, v) { f[c] = v; return b; },
          select() { return b; },
          then(resolve, reject) {
            if (updateError) return Promise.resolve({ data: null, error: updateError }).then(resolve, reject);
            const rows = conversations.filter(
              (r) =>
                (f.client_id === undefined || r.client_id === f.client_id) &&
                (f.id === undefined || r.id === f.id) &&
                (f.conversation_status === undefined || r.conversation_status === f.conversation_status)
            );
            return Promise.resolve({
              data: rows.map((r) => ({ id: r.id, channel_identity_id: r.channel_identity_id })),
              error: null,
            }).then(resolve, reject);
          },
        };
        return b;
      }
      if (table === "contact_channel_identities") {
        const f = {};
        const b = {
          select() { return b; },
          eq(c, v) { f[c] = v; return b; },
          async maybeSingle() {
            const row = identities.find(
              (i) => i.id === f.id && (f.client_id === undefined || i.client_id === f.client_id)
            );
            return { data: row || null, error: null };
          },
        };
        return b;
      }
      if (table === "conversation_events") {
        return {
          async insert(row) {
            if (insertError) return { error: insertError };
            inserted.conversation_events.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

const ISO = "2026-06-15T12:00:00.000Z";

// ---------------------------------------------------------------------
// Fix 2 — recordManualTransfer
// ---------------------------------------------------------------------

test("manual transfer of an ACTIVE conversation writes exactly one 'transferred' event", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "active", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "A", sender_id: "psid-1" }],
  });
  const r = await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });

  assert.equal(r.transitioned, true);
  assert.equal(supa.inserted.conversation_events.length, 1);
  assert.deepEqual(supa.inserted.conversation_events[0], {
    client_id: "A",
    conversation_state_id: null,
    conversation_id: "cv1",
    sender_id: "psid-1",
    event_type: "transferred",
    actor_user_id: "emp1",
  });
});

test("the event actor_user_id is exactly the passed authenticated employee id", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "active", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "A", sender_id: "psid-1" }],
  });
  await recordManualTransfer(supa, { clientId: "A", actorUserId: "the-real-employee", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(supa.inserted.conversation_events[0].actor_user_id, "the-real-employee");
});

test("no 'accepted' / 'solved' / ownership event is ever produced by a transfer", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "active", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "A", sender_id: "psid-1" }],
  });
  await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });
  const types = supa.inserted.conversation_events.map((e) => e.event_type);
  assert.deepEqual(types, ["transferred"]);
  assert.ok(!types.includes("accepted"));
  assert.ok(!types.includes("solved"));
  // no assignment field is present in the event row
  assert.ok(!("assigned_user_id" in supa.inserted.conversation_events[0]));
  assert.ok(!("system_assigned_user_id" in supa.inserted.conversation_events[0]));
});

test("the transfer transitions active -> waiting_human (guarded to status='active')", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "active", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "A", sender_id: "psid-1" }],
  });
  let patch;
  const orig = supa.from.bind(supa);
  supa.from = (t) => {
    const b = orig(t);
    if (t === "conversations") {
      const u = b.update.bind(b);
      b.update = (p) => { patch = p; return u(p); };
    }
    return b;
  };
  const r = await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(r.transitioned, true);
  assert.equal(patch.conversation_status, "waiting_human");
});

test("a conversation already in waiting_human is NOT transferred and writes NO event", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "waiting_human", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "A", sender_id: "psid-1" }],
  });
  const r = await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(r.transitioned, false);
  assert.equal(supa.inserted.conversation_events.length, 0);
});

test("a closed conversation is NOT transferred and writes NO event", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "closed", channel_identity_id: "i1" }],
  });
  const r = await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(r.transitioned, false);
  assert.equal(supa.inserted.conversation_events.length, 0);
});

test("cross-tenant: an employee of client A cannot transfer client B's conversation (no transition, no event)", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "B", conversation_status: "active", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "B", sender_id: "psid-b" }],
  });
  const r = await recordManualTransfer(supa, { clientId: "A", actorUserId: "empA", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(r.transitioned, false);
  assert.equal(supa.inserted.conversation_events.length, 0);
});

test("the sender_id lookup is tenant-scoped and falls back to '' when the identity is missing", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "active", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "B", sender_id: "wrong-tenant" }], // identity belongs to client B
  });
  await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(supa.inserted.conversation_events[0].sender_id, "");
});

test("a failed event insert is swallowed — the state transition still counts", async () => {
  const supa = makeSupa({
    conversations: [{ id: "cv1", client_id: "A", conversation_status: "active", channel_identity_id: "i1" }],
    identities: [{ id: "i1", client_id: "A", sender_id: "psid-1" }],
    insertError: { code: "42501", message: "RLS" },
  });
  const r = await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(r.transitioned, true); // did not throw
  assert.equal(supa.inserted.conversation_events.length, 0);
});

test("a real DB error on the state UPDATE is surfaced as { error }", async () => {
  const supa = makeSupa({ updateError: { code: "XX000", message: "boom" } });
  const r = await recordManualTransfer(supa, { clientId: "A", actorUserId: "emp1", conversationId: "cv1", updatedAtIso: ISO });
  assert.equal(r.transitioned, false);
  assert.ok(r.error);
});

// ---------------------------------------------------------------------
// Fix 1 — n8n "insert message" node + the human-reply API path (contract)
// ---------------------------------------------------------------------

function hrWorkflow() {
  const p = fileURLToPath(
    new URL("../../../engineering/n8n/working/Human Reply - Multi Channel Media.json", import.meta.url)
  );
  return JSON.parse(readFileSync(p, "utf8"));
}

test("Human Reply 'insert message' node persists sent_by_user_id from the webhook body", () => {
  const wf = hrWorkflow();
  const node = wf.nodes.find((n) => n.name === "insert message");
  assert.ok(node, "insert message node exists");
  const body = node.parameters.jsonBody;
  assert.match(body, /sent_by_user_id:\s*\n?\s*\$node\["Webhook"\]\.json\["body"\]\["sent_by_user_id"\] \|\| null/);
  // unchanged essentials
  assert.match(body, /reply_source: "human"/);
  assert.match(body, /direction: "outbound"/);
  assert.match(body, /conversation_id:\s*\n?\s*\$node\["get_conversation_v2"\]\.json\["id"\]/);
  assert.match(body, /media_path:/);
  assert.match(body, /media_mime_type:/);
  assert.match(body, /media_file_name:/);
  assert.match(body, /media_size_bytes:/);
});

test("Human Reply workflow node/edge integrity is unchanged (22 nodes, 24 edges)", () => {
  const wf = hrWorkflow();
  const edges = Object.values(wf.connections).reduce(
    (acc, v) => acc + (v.main || []).reduce((a, c) => a + c.length, 0),
    0
  );
  assert.equal(wf.nodes.length, 22);
  assert.equal(edges, 24);
});

test("the human-reply API forwards sent_by_user_id = the AUTHENTICATED actor's id (never request input)", () => {
  const src = readFileSync(fileURLToPath(new URL("../humanReply.js", import.meta.url)), "utf8");
  // actor is resolved server-side from actor_user_id via resolveActingMembership
  assert.match(src, /resolveActingMembership\(supabase, actor_user_id\)/);
  // and the webhook payload's sent_by_user_id is that resolved actor, not req.body
  assert.match(src, /sent_by_user_id:\s*actor\.user\.id/);
  assert.doesNotMatch(src, /sent_by_user_id:\s*req\.body/);
});
