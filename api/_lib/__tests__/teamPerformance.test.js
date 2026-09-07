import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computePerformance, resolveRange, resolvePerformanceScope } from "../teamPerformance.js";

// Team Productivity V1 — the CLIENT-SCOPED metrics engine + its authz
// decision. Authoritative sources only: conversation_events, conversations,
// messages, client_users/users. Never conversation_state,
// system_assigned_user_id, or conversations.assigned_user_id for history.

// ---------------------------------------------------------------------
// Mock supabase — the query shapes computePerformance uses.
// ---------------------------------------------------------------------
function makeDb(tables) {
  return {
    from(table) {
      const src = tables[table] || [];
      const f = [];
      let limitN = null;
      const orders = [];
      const b = {
        select() { return b; },
        eq(c, v) { f.push({ op: "eq", c, v }); return b; },
        in(c, v) { f.push({ op: "in", c, v }); return b; },
        gte(c, v) { f.push({ op: "gte", c, v }); return b; },
        lte(c, v) { f.push({ op: "lte", c, v }); return b; },
        not(c, _is, v) { f.push({ op: "not", c, v }); return b; },
        order(c, o) { orders.push({ c, asc: !(o && o.ascending === false) }); return b; },
        limit(n) { limitN = n; return b; },
        then(resolve, reject) {
          try {
            let rows = src.filter((row) =>
              f.every((flt) => {
                const val = row[flt.c];
                if (flt.op === "eq") return val === flt.v;
                if (flt.op === "in") return flt.v.includes(val);
                if (flt.op === "gte") return val != null && new Date(val).getTime() >= new Date(flt.v).getTime();
                if (flt.op === "lte") return val != null && new Date(val).getTime() <= new Date(flt.v).getTime();
                if (flt.op === "not") return val !== null && val !== undefined; // "is null" -> keep non-null
                return true;
              })
            );
            for (let i = orders.length - 1; i >= 0; i -= 1) {
              const { c, asc } = orders[i];
              rows = rows.slice().sort((x, y) => {
                const xv = x[c], yv = y[c];
                if (xv === yv) return 0;
                return (xv < yv ? -1 : 1) * (asc ? 1 : -1);
              });
            }
            if (limitN != null) rows = rows.slice(0, limitN);
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e).then(resolve, reject);
          }
        },
      };
      return b;
    },
  };
}

const NOW = new Date("2026-06-15T12:00:00Z");
const FROM = "2026-06-01T00:00:00Z";
const TO = "2026-06-15T12:00:00Z";
const TODAY_START = "2026-06-14T21:00:00Z"; // 2026-06-15 00:00 UTC+3

function baseArgs(overrides = {}) {
  return {
    clientId: "A",
    fromIso: FROM,
    toIso: TO,
    todayStartIso: TODAY_START,
    now: NOW,
    drillEmployeeId: null,
    ...overrides,
  };
}

const EMP_A = { user_id: "empA", name: "Alice", role: "agent", is_active: true };
const EMP_B = { user_id: "empB", name: "Bob", role: "agent", is_active: true };

// ---------------------------------------------------------------------
// resolveRange — UTC+3 boundaries
// ---------------------------------------------------------------------
test("resolveRange: today = UTC+3 calendar day", () => {
  const r = resolveRange({ range: "today" }, new Date("2026-06-15T12:00:00Z"));
  assert.equal(r.range, "today");
  assert.equal(r.from, "2026-06-14T21:00:00.000Z"); // 2026-06-15 00:00 UTC+3
  assert.equal(r.today_start, "2026-06-14T21:00:00.000Z");
});

test("resolveRange: month = 1st of the UTC+3 month", () => {
  const r = resolveRange({ range: "month" }, new Date("2026-06-15T00:30:00Z")); // 03:30 UTC+3, still June 15
  assert.equal(r.from, "2026-05-31T21:00:00.000Z"); // 2026-06-01 00:00 UTC+3
});

test("resolveRange: week starts Monday (UTC+3)", () => {
  // 2026-06-17 is a Wednesday
  const r = resolveRange({ range: "week" }, new Date("2026-06-17T09:00:00Z"));
  assert.equal(r.from, "2026-06-14T21:00:00.000Z"); // Monday 2026-06-15 00:00 UTC+3
});

test("resolveRange: custom clamps the end to end-of-day UTC+3 and never past now", () => {
  const r = resolveRange({ range: "custom", from: "2026-06-01", to: "2026-06-10" }, new Date("2026-06-15T12:00:00Z"));
  assert.equal(r.from, "2026-05-31T21:00:00.000Z");
  assert.equal(r.to, "2026-06-10T20:59:59.999Z"); // 2026-06-10 23:59:59.999 UTC+3
});

test("resolveRange: unknown range falls back to today", () => {
  assert.equal(resolveRange({ range: "garbage" }, NOW).range, "today");
});

// ---------------------------------------------------------------------
// computePerformance — the metrics
// ---------------------------------------------------------------------

test("accepted event = a handling cycle / claim; distinct conversation = handled", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-10T09:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-10T10:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "reopened", actor_user_id: null, created_at: "2026-06-10T11:00:00Z" }, // auto reopen
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-10T12:00:00Z" }, // 2nd cycle, same conv
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  const a = r.employees[0];
  assert.equal(a.conversations_handled, 1); // distinct conversation_id
  assert.equal(a.handling_cycles, 2); // two accepted events
});

test("solved is attributed to the SOLVED actor (not the accepter)", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-10T09:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empB", created_at: "2026-06-10T10:00:00Z" },
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A, EMP_B] }));
  const byId = Object.fromEntries(r.employees.map((e) => [e.user_id, e]));
  assert.equal(byId.empA.conversations_solved, 0);
  assert.equal(byId.empB.conversations_solved, 1);
  assert.equal(byId.empA.conversations_handled, 1);
});

test("system_assigned is NEVER counted as handling", async () => {
  const db = makeDb({
    conversation_events: [
      // system_assign is not even fetched (not in CYCLE_EVENT_TYPES); prove
      // it changes nothing even if present
      { client_id: "A", conversation_id: "c1", event_type: "system_assigned", actor_user_id: null, target_user_id: "empA", created_at: "2026-06-10T09:00:00Z" },
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  assert.equal(r.employees[0].conversations_handled, 0);
  assert.equal(r.employees[0].handling_cycles, 0);
});

test("reopened credit: a customer/auto reopen (actor NULL) does NOT count as an employee reopen", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "reopened", actor_user_id: null, created_at: "2026-06-10T11:00:00Z" },
      { client_id: "A", conversation_id: "c2", event_type: "reopened", actor_user_id: "empA", created_at: "2026-06-10T12:00:00Z" },
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  assert.equal(r.employees[0].manual_reopens, 1); // only the actor=empA one
});

test("A solves, customer auto-reopens, B claims & solves -> BOTH get handled+1 and solved+1", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-05T09:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-05T10:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "reopened", actor_user_id: null, created_at: "2026-06-05T11:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empB", created_at: "2026-06-05T11:30:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empB", created_at: "2026-06-05T12:30:00Z" },
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A, EMP_B] }));
  const byId = Object.fromEntries(r.employees.map((e) => [e.user_id, e]));
  assert.equal(byId.empA.conversations_handled, 1);
  assert.equal(byId.empA.conversations_solved, 1);
  assert.equal(byId.empA.handling_cycles, 1);
  assert.equal(byId.empB.conversations_handled, 1);
  assert.equal(byId.empB.conversations_solved, 1);
  assert.equal(byId.empB.handling_cycles, 1);
  // two completed cycles -> two resolution samples team-wide
  assert.equal(r.team.resolution_sample, 2);
});

test("resolution uses accepted -> solved of the SAME cycle (not started_at -> solved_at)", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-10T09:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-10T09:30:00Z" },
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  assert.equal(r.employees[0].avg_resolution_sec, 1800); // exactly 30 min
  assert.equal(r.employees[0].resolution_sample, 1);
});

test("a reopened conversation produces a SECOND valid completed cycle", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-10T09:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-10T09:20:00Z" }, // 1200s
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-10T12:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-10T12:10:00Z" }, // 600s
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  assert.equal(r.employees[0].resolution_sample, 2);
  assert.equal(r.employees[0].avg_resolution_sec, 900); // mean(1200, 600)
});

test("first response = first HUMAN outbound after accepted, within the cycle window", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-10T09:00:00Z" },
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-10T10:00:00Z" },
    ],
    messages: [
      { client_id: "A", conversation_id: "c1", direction: "inbound", reply_source: null, created_at: "2026-06-10T08:59:00Z", sent_by_user_id: null },
      { client_id: "A", conversation_id: "c1", direction: "outbound", reply_source: "ai", created_at: "2026-06-10T09:00:30Z", sent_by_user_id: null }, // AI, ignored
      { client_id: "A", conversation_id: "c1", direction: "outbound", reply_source: "human", created_at: "2026-06-10T09:02:00Z", sent_by_user_id: "empA" }, // <- first human, +120s
      { client_id: "A", conversation_id: "c1", direction: "outbound", reply_source: "human", created_at: "2026-06-10T09:05:00Z", sent_by_user_id: "empA" },
    ],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  assert.equal(r.employees[0].avg_first_response_sec, 120);
});

test("human messages count uses sent_by_user_id; NULL rows are NEVER attributed", async () => {
  const db = makeDb({
    conversation_events: [],
    messages: [
      { client_id: "A", conversation_id: "c1", direction: "outbound", reply_source: "human", created_at: "2026-06-10T09:00:00Z", sent_by_user_id: "empA" },
      { client_id: "A", conversation_id: "c1", direction: "outbound", reply_source: "human", created_at: "2026-06-10T09:05:00Z", sent_by_user_id: "empA" },
      { client_id: "A", conversation_id: "c1", direction: "outbound", reply_source: "human", created_at: "2026-05-20T09:00:00Z", sent_by_user_id: null }, // historical, unattributed
      { client_id: "A", conversation_id: "c1", direction: "outbound", reply_source: "human", created_at: "2026-06-10T09:10:00Z", sent_by_user_id: null }, // in-range but NULL
    ],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A, EMP_B] }));
  const byId = Object.fromEntries(r.employees.map((e) => [e.user_id, e]));
  assert.equal(byId.empA.human_messages_sent, 2); // only the two with sent_by_user_id
  assert.equal(byId.empB.human_messages_sent, 0);
});

test("current workload uses waiting_human + assigned_user_id (point-in-time)", async () => {
  const db = makeDb({
    conversation_events: [],
    messages: [],
    conversations: [
      { client_id: "A", conversation_status: "waiting_human", assigned_user_id: "empA" },
      { client_id: "A", conversation_status: "waiting_human", assigned_user_id: "empA" },
      { client_id: "A", conversation_status: "waiting_human", assigned_user_id: "empB" },
    ],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A, EMP_B] }));
  const byId = Object.fromEntries(r.employees.map((e) => [e.user_id, e]));
  assert.equal(byId.empA.current_workload, 2);
  assert.equal(byId.empB.current_workload, 1);
  assert.equal(r.team.current_workload, 3);
});

test("solved today counts solved events inside today's UTC+3 window, independent of range", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-15T02:00:00Z" }, // today (UTC+3)
      { client_id: "A", conversation_id: "c2", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-10T02:00:00Z" }, // earlier this month
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  assert.equal(r.employees[0].solved_today, 1);
  assert.equal(r.employees[0].conversations_solved, 2); // both are in the June range
});

test("out-of-tenant events are ignored (actor not in this client's roster)", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "outsider", created_at: "2026-06-10T09:00:00Z" },
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  assert.equal(r.employees[0].conversations_handled, 0);
  assert.equal(r.team.conversations_handled, 0);
});

test("zero-data employee -> valid zeros and NULL averages (not misleading 0s)", async () => {
  const db = makeDb({ conversation_events: [], messages: [], conversations: [] });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A] }));
  const a = r.employees[0];
  assert.equal(a.conversations_handled, 0);
  assert.equal(a.conversations_solved, 0);
  assert.equal(a.human_messages_sent, 0);
  assert.equal(a.avg_first_response_sec, null);
  assert.equal(a.avg_resolution_sec, null);
  assert.equal(a.current_workload, 0);
  assert.equal(a.first_response_sample, 0);
  assert.equal(a.resolution_sample, 0);
});

test("drill-down detail is only produced for the requested employee, with a gap-free trend", async () => {
  const db = makeDb({
    conversation_events: [
      { client_id: "A", conversation_id: "c1", event_type: "accepted", actor_user_id: "empA", created_at: "2026-06-14T22:00:00Z" }, // 2026-06-15 UTC+3
      { client_id: "A", conversation_id: "c1", event_type: "solved", actor_user_id: "empA", created_at: "2026-06-14T23:00:00Z" },
    ],
    messages: [],
    conversations: [],
  });
  const r = await computePerformance(db, baseArgs({ roster: [EMP_A, EMP_B], drillEmployeeId: "empA", fromIso: TODAY_START }));
  assert.ok(r.detail);
  assert.equal(r.detail.employee_user_id, "empA");
  assert.ok(r.detail.trend.length >= 1);
  const day = r.detail.trend.find((d) => d.day === "2026-06-15");
  assert.equal(day.handled, 1);
  assert.equal(day.solved, 1);
});

// ---------------------------------------------------------------------
// resolvePerformanceScope — security decision
// ---------------------------------------------------------------------
const withPerm = { user: { id: "mgr" }, membership: { role: "owner", is_active: true, permissions_overrides: null } };
const noPerm = { user: { id: "agent1" }, membership: { role: "agent", is_active: true, permissions_overrides: null } };

test("scope=team requires TEAM_MANAGEMENT — denied for a plain agent", () => {
  const d = resolvePerformanceScope(noPerm, { scope: "team", rosterIds: new Set(["agent1"]) });
  assert.equal(d.ok, false);
  assert.equal(d.status, 403);
});

test("scope=team allowed for TEAM_MANAGEMENT (owner)", () => {
  const d = resolvePerformanceScope(withPerm, { scope: "team", rosterIds: new Set(["mgr", "x"]) });
  assert.equal(d.ok, true);
  assert.equal(d.scope, "team");
  assert.equal(d.drillEmployeeId, null);
});

test("scope=me ALWAYS forces employee = actor.user.id (any member, ignores requested id)", () => {
  const d = resolvePerformanceScope(noPerm, { scope: "me", requestedEmployeeId: "someone-else", rosterIds: new Set() });
  assert.equal(d.ok, true);
  assert.equal(d.scope, "me");
  assert.equal(d.drillEmployeeId, "agent1"); // the actor, not "someone-else"
});

test("team drill-down: requested employee MUST belong to the acting user's roster", () => {
  const ok = resolvePerformanceScope(withPerm, { scope: "team", requestedEmployeeId: "x", rosterIds: new Set(["mgr", "x"]) });
  assert.equal(ok.ok, true);
  assert.equal(ok.drillEmployeeId, "x");

  const bad = resolvePerformanceScope(withPerm, { scope: "team", requestedEmployeeId: "client-B-employee", rosterIds: new Set(["mgr", "x"]) });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 404);
});

// ---------------------------------------------------------------------
// Handler source contract — tenant scope + no browser trust
// ---------------------------------------------------------------------
test("handler: tenant scope is actor.membership.client_id and no client_id/role is read from the request", () => {
  const src = readFileSync(fileURLToPath(new URL("../teamPerformance.js", import.meta.url)), "utf8");
  assert.match(src, /const clientId = actor\.membership\.client_id;/);
  assert.doesNotMatch(src, /req\.(query|body)\??\.\s*client_id/);
  assert.doesNotMatch(src, /req\.(query|body)\??\.\s*role/);
  assert.doesNotMatch(src, /req\.(query|body)\??\.\s*permission/);
  // me-scope drill id comes from the decision (forced), team roster is the
  // client's own client_users
  assert.match(src, /resolveActingMembership\(supabase, req\.query\?\.actor_user_id\)/);
  assert.match(src, /\.from\("client_users"\)[\s\S]{0,120}\.eq\("client_id", clientId\)/);
  assert.match(src, /PERMISSIONS\.TEAM_MANAGEMENT/);
  // conversation_state is NOT a data source for metrics; system_assigned
  // is never queried (only 'accepted'|'solved'|'reopened' are fetched)
  assert.doesNotMatch(src, /\.from\("conversation_state"\)/);
  assert.match(src, /CYCLE_EVENT_TYPES = \["accepted", "solved", "reopened"\]/);
  assert.doesNotMatch(src, /"system_assigned"/);
});
