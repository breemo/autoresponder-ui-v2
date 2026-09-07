import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computeDashboardSummary } from "../dashboardSummary.js";
import { resolveConversationRoute } from "../../conversation.js";

// Client Dashboard — server-side aggregates over the AUTHORITATIVE tables
// (public.conversations, public.messages). Covers the dashboard contract
// and multi-tenant isolation. computeDashboardSummary is the data core;
// the handler wrapper only adds auth + env + res.

// ---------------------------------------------------------------------
// Minimal chained Supabase mock — supports exactly the query shapes
// computeDashboardSummary uses: select({count,head}) / eq / in / gte /
// lte / order (stable multi-key) / limit / maybeSingle / thenable.
// ---------------------------------------------------------------------
function makeDb(tables) {
  return {
    from(table) {
      const src = tables[table] || [];
      const filters = [];
      const orders = [];
      let limitN = null;
      let wantCount = false;
      let head = false;

      const applyFilters = (rows) =>
        rows.filter((row) =>
          filters.every((f) => {
            const v = row[f.col];
            if (f.op === "eq") return v === f.val;
            if (f.op === "in") return f.val.includes(v);
            if (f.op === "gte") return v != null && new Date(v).getTime() >= new Date(f.val).getTime();
            if (f.op === "lte") return v != null && new Date(v).getTime() <= new Date(f.val).getTime();
            return true;
          })
        );

      const applyOrders = (rows) => {
        const out = rows.slice();
        // apply in reverse so orders[0] is the primary key (stable sort)
        for (let i = orders.length - 1; i >= 0; i -= 1) {
          const { col, asc } = orders[i];
          out.sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av == null && bv == null) return 0;
            if (av == null) return 1; // nulls last
            if (bv == null) return -1;
            if (av < bv) return asc ? -1 : 1;
            if (av > bv) return asc ? 1 : -1;
            return 0;
          });
        }
        return out;
      };

      const builder = {
        select(_cols, opts) {
          if (opts && opts.count) wantCount = true;
          if (opts && opts.head) head = true;
          return builder;
        },
        eq(col, val) {
          filters.push({ op: "eq", col, val });
          return builder;
        },
        in(col, val) {
          filters.push({ op: "in", col, val });
          return builder;
        },
        gte(col, val) {
          filters.push({ op: "gte", col, val });
          return builder;
        },
        lte(col, val) {
          filters.push({ op: "lte", col, val });
          return builder;
        },
        order(col, opts) {
          orders.push({ col, asc: !(opts && opts.ascending === false) });
          return builder;
        },
        limit(n) {
          limitN = n;
          return builder;
        },
        maybeSingle() {
          const rows = applyOrders(applyFilters(src));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve, reject) {
          try {
            const filtered = applyFilters(src);
            const ordered = applyOrders(filtered);
            const limited = limitN == null ? ordered : ordered.slice(0, limitN);
            const result = { error: null };
            if (wantCount) result.count = filtered.length; // count ignores limit
            result.data = head ? null : limited;
            return Promise.resolve(result).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e).then(resolve, reject);
          }
        },
      };
      return builder;
    },
  };
}

// ---------------------------------------------------------------------
// Fixtures: client A has real data; client B's data must never leak.
// ---------------------------------------------------------------------
const NOW = new Date("2026-06-15T12:00:00Z");

function fixtures() {
  return {
    subscriptions: [
      { id: "subA", client_id: "A", plan_id: "planA", status: "active", start_date: "2026-06-01T00:00:00Z", end_date: "2026-07-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
      { id: "subB", client_id: "B", plan_id: "planA", status: "active", start_date: "2026-06-01T00:00:00Z", end_date: "2026-07-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
    ],
    plans: [
      { id: "planA", messages_limit: 20000 },
      { id: "planUnlimited", messages_limit: null },
    ],
    conversations: [
      { id: "cA1", client_id: "A", platform: "facebook", conversation_status: "active", channel_identity_id: "iA1", contact_id: "ctA1", last_message_at: "2026-06-14T10:01:00Z", started_at: "2026-06-10T00:00:00Z", created_at: "2026-06-10T00:00:00Z" },
      { id: "cA2", client_id: "A", platform: "whatsapp", conversation_status: "waiting_human", channel_identity_id: "iA2", contact_id: "ctA2", last_message_at: "2026-06-10T09:01:00Z", started_at: "2026-06-09T00:00:00Z", created_at: "2026-06-09T00:00:00Z" },
      { id: "cA3", client_id: "A", platform: "telegram", conversation_status: "closed", channel_identity_id: "iA3", contact_id: "ctA3", last_message_at: "2026-06-12T00:00:00Z", started_at: "2026-06-08T00:00:00Z", created_at: "2026-06-08T00:00:00Z" },
      { id: "cB1", client_id: "B", platform: "facebook", conversation_status: "active", channel_identity_id: "iB1", contact_id: "ctB1", last_message_at: "2026-06-14T00:00:00Z", started_at: "2026-06-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
      { id: "cB2", client_id: "B", platform: "facebook", conversation_status: "waiting_human", channel_identity_id: "iB2", contact_id: "ctB2", last_message_at: "2026-06-14T00:00:00Z", started_at: "2026-06-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
    ],
    contact_channel_identities: [
      { id: "iA1", display_name: "Alice", sender_id: "psid-a1", platform: "facebook" },
      { id: "iA2", display_name: null, sender_id: "9705551234", platform: "whatsapp" },
      { id: "iA3", display_name: "Charlie", sender_id: "tg-a3", platform: "telegram" },
      { id: "iB1", display_name: "SHOULD-NOT-APPEAR", sender_id: "psid-b1", platform: "facebook" },
    ],
    contacts: [
      { id: "ctA2", display_name: "Bob (contact)" },
    ],
    messages: [
      // client A — before the billing period (excluded from usage)
      { id: "mA0", client_id: "A", conversation_id: "cA1", direction: "inbound", reply_source: null, message: "old", created_at: "2026-05-20T00:00:00Z" },
      // client A — in period
      { id: "mA1", client_id: "A", conversation_id: "cA1", direction: "inbound", reply_source: null, message: "hi there", created_at: "2026-06-10T09:00:00Z" },
      { id: "mA2", client_id: "A", conversation_id: "cA1", direction: "outbound", reply_source: "ai", message: "AI reply", created_at: "2026-06-10T09:01:00Z" },
      { id: "mA3", client_id: "A", conversation_id: "cA1", direction: "outbound", reply_source: "bogus_source", message: "weird", created_at: "2026-06-13T00:00:00Z" },
      { id: "mA4", client_id: "A", conversation_id: "cA1", direction: "inbound", reply_source: null, message: "second", created_at: "2026-06-14T10:00:00Z" },
      { id: "mA5", client_id: "A", conversation_id: "cA1", direction: "outbound", reply_source: "human", message: "agent here", created_at: "2026-06-14T10:01:00Z" },
      // client A — cA2 has one inbound in period
      { id: "mA6", client_id: "A", conversation_id: "cA2", direction: "inbound", reply_source: null, message: "need help", created_at: "2026-06-10T09:01:00Z" },
      // client B — must never be counted for A
      { id: "mB1", client_id: "B", conversation_id: "cB1", direction: "inbound", reply_source: null, message: "b msg", created_at: "2026-06-12T00:00:00Z" },
      { id: "mB2", client_id: "B", conversation_id: "cB1", direction: "outbound", reply_source: "ai", message: "b ai", created_at: "2026-06-12T00:00:00Z" },
      { id: "mB3", client_id: "B", conversation_id: "cB1", direction: "outbound", reply_source: "auto", message: "b auto", created_at: "2026-06-12T00:00:00Z" },
    ],
  };
}

// ---------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------

test("Open Conversations = active + waiting_human (closed excluded)", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  assert.equal(s.open_conversations, 2); // cA1 active + cA2 waiting_human; cA3 closed excluded
});

test("Waiting for Human = waiting_human only", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  assert.equal(s.waiting_human, 1);
});

test("Recent Conversations: closed included, ordered by last_message_at desc", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  assert.deepEqual(
    s.recent_conversations.map((c) => c.conversation_id),
    ["cA1", "cA3", "cA2"]
  );
  const closed = s.recent_conversations.find((c) => c.conversation_id === "cA3");
  assert.equal(closed.conversation_status, "closed"); // closed allowed in Recent
});

test("Recent Conversations: name resolves contact -> identity -> sender_id", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  const byId = Object.fromEntries(s.recent_conversations.map((c) => [c.conversation_id, c]));
  assert.equal(byId.cA1.customer_name, "Alice"); // identity display_name
  assert.equal(byId.cA2.customer_name, "Bob (contact)"); // contact display_name wins
  assert.equal(byId.cA2.sender_id, "9705551234"); // id still available
  assert.equal(byId.cA1.last_message, "agent here"); // latest message
  assert.equal(byId.cA1.messages_count, 6); // real all-time count for cA1 (mA0..mA5)
});

test("Messages Usage counts real public.messages rows in the billing period", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  // in [2026-06-01, 2026-06-15T12:00]: mA1,mA2,mA3,mA4,mA5,mA6 = 6. mA0 (May) excluded.
  assert.equal(s.messages_usage.used, 6);
  assert.equal(s.messages_usage.limit, 20000);
  assert.equal(s.messages_usage.unlimited, false);
  assert.equal(s.messages_usage.plan_known, true);
  assert.equal(s.messages_usage.period_from, "2026-06-01T00:00:00.000Z");
  // period_to is clamped to now (end_date 2026-07-01 is in the future)
  assert.equal(s.messages_usage.period_to, NOW.toISOString());
});

test("Messages Usage: null plan limit -> unlimited semantics preserved", async () => {
  const f = fixtures();
  f.subscriptions[0].plan_id = "planUnlimited";
  const s = await computeDashboardSummary(makeDb(f), "A", NOW);
  assert.equal(s.messages_usage.limit, null);
  assert.equal(s.messages_usage.unlimited, true);
  assert.equal(s.messages_usage.plan_known, true);
  assert.equal(typeof s.messages_usage.used, "number"); // still counted
});

test("No subscription -> usage null, automation falls back to trailing 30 days", async () => {
  const f = fixtures();
  f.subscriptions = f.subscriptions.filter((x) => x.client_id !== "A");
  const s = await computeDashboardSummary(makeDb(f), "A", NOW);
  assert.equal(s.messages_usage.used, null);
  assert.equal(s.messages_usage.limit, null);
  assert.equal(s.messages_usage.plan_known, false);
  assert.equal(s.automation.basis, "trailing_30d");
});

test("Automation & Replies uses the real reply_source set; unknown sources not bucketed", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  assert.equal(s.automation.basis, "billing_period");
  const byKey = Object.fromEntries(s.automation.stats.map((x) => [x.key, x.value]));
  assert.deepEqual(Object.keys(byKey).sort(), ["ai", "auto", "human", "quick_reply", "system"]);
  assert.equal(byKey.ai, 1);
  assert.equal(byKey.human, 1);
  assert.equal(byKey.auto, 0);
  assert.equal(byKey.quick_reply, 0);
  assert.equal(byKey.system, 0);
  // mA3 (reply_source "bogus_source") counts toward outbound total but no bucket
  assert.equal(s.automation.outbound_total, 3);
});

test("Chart returns 7 real UTC day buckets with real inbound/outbound counts", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  assert.equal(s.chart.days.length, 7);
  assert.deepEqual(
    s.chart.days.map((d) => d.day),
    ["2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15"]
  );
  const byDay = Object.fromEntries(s.chart.days.map((d) => [d.day, d]));
  assert.deepEqual(byDay["2026-06-10"], { day: "2026-06-10", inbound: 2, outbound: 1 }); // mA1 + mA6 inbound, mA2 outbound
  assert.deepEqual(byDay["2026-06-13"], { day: "2026-06-13", inbound: 0, outbound: 1 });
  assert.deepEqual(byDay["2026-06-14"], { day: "2026-06-14", inbound: 1, outbound: 1 });
  assert.deepEqual(byDay["2026-06-11"], { day: "2026-06-11", inbound: 0, outbound: 0 });
  const totalIn = s.chart.days.reduce((a, d) => a + d.inbound, 0);
  const totalOut = s.chart.days.reduce((a, d) => a + d.outbound, 0);
  assert.equal(totalIn, 3); // mA1, mA4, mA6 (mA0 is in May, outside the 7d window)
  assert.equal(totalOut, 3); // mA2, mA3, mA5
});

test("multi-tenant isolation: client B's conversations/messages never appear for client A", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "A", NOW);
  // B has 2 open conversations + 3 messages; none must be visible to A
  assert.equal(s.open_conversations, 2);
  assert.equal(s.waiting_human, 1);
  assert.ok(!s.recent_conversations.some((c) => c.conversation_id.startsWith("cB")));
  assert.ok(!s.recent_conversations.some((c) => c.customer_name === "SHOULD-NOT-APPEAR"));
  assert.equal(s.automation.outbound_total, 3); // A's 3, not A+B's 5
});

test("zero-data client returns valid zeros / empty arrays, never an error", async () => {
  const s = await computeDashboardSummary(makeDb(fixtures()), "Z", NOW);
  assert.equal(s.open_conversations, 0);
  assert.equal(s.waiting_human, 0);
  assert.deepEqual(s.recent_conversations, []);
  assert.equal(s.messages_usage.used, null);
  assert.equal(s.automation.outbound_total, 0);
  assert.deepEqual(s.automation.stats.map((x) => x.value), [0, 0, 0, 0, 0]);
  assert.equal(s.chart.days.length, 7);
  assert.equal(s.chart.days.reduce((a, d) => a + d.inbound + d.outbound, 0), 0);
});

// ---------------------------------------------------------------------
// Routing + tenant-scope contract
// ---------------------------------------------------------------------

test("GET ?resource=dashboard routes to the dashboard handler", () => {
  assert.equal(
    resolveConversationRoute({ method: "GET", query: { resource: "dashboard", actor_user_id: "u1" } }),
    "dashboard"
  );
  // never on POST
  assert.equal(resolveConversationRoute({ method: "POST", query: { resource: "dashboard" }, body: {} }), "self");
});

test("handler derives client_id from the authenticated membership, never from the request", () => {
  const src = readFileSync(fileURLToPath(new URL("../dashboardSummary.js", import.meta.url)), "utf8");
  // clientId comes only from actor.membership.client_id
  assert.match(src, /const clientId = actor\.membership\.client_id;/);
  // no reading of a client_id from the request anywhere in the handler
  assert.doesNotMatch(src, /req\.query\??\.\s*client_id/);
  assert.doesNotMatch(src, /req\.body\??\.\s*client_id/);
  // messages RLS => service role is mandatory, fail loud (no silent zeros)
  assert.match(src, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(src, /PERMISSIONS\.DASHBOARD/);
});
