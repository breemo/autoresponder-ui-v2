import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computeAdminOverview } from "../adminOverview.js";

// Auto Responder ADMIN Overview — platform-wide aggregates. computeAdminOverview
// is the data core; auth (users.role === "admin") lives in the
// api/system-settings.js handler and is asserted here by source contract.

// ---------------------------------------------------------------------
// Minimal chained Supabase mock (select {count,head} / eq / in / gte /
// order / limit / thenable). Rows are returned pre-shaped.
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

      const run = () => {
        let rows = src.filter((row) =>
          filters.every((f) => {
            const v = row[f.col];
            if (f.op === "eq") return v === f.val;
            if (f.op === "in") return f.val.includes(v);
            if (f.op === "gte") return v != null && new Date(v).getTime() >= new Date(f.val).getTime();
            if (f.op === "lte") return v != null && new Date(v).getTime() <= new Date(f.val).getTime();
            return true;
          })
        );
        for (let i = orders.length - 1; i >= 0; i -= 1) {
          const { col, asc } = orders[i];
          rows = rows.slice().sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (av < bv) return asc ? -1 : 1;
            if (av > bv) return asc ? 1 : -1;
            return 0;
          });
        }
        const count = rows.length;
        const data = limitN == null ? rows : rows.slice(0, limitN);
        return { data: head ? null : data, count: wantCount ? count : undefined, error: null };
      };

      const builder = {
        select(_c, opts) {
          if (opts && opts.count) wantCount = true;
          if (opts && opts.head) head = true;
          return builder;
        },
        eq(col, val) { filters.push({ op: "eq", col, val }); return builder; },
        in(col, val) { filters.push({ op: "in", col, val }); return builder; },
        gte(col, val) { filters.push({ op: "gte", col, val }); return builder; },
        lte(col, val) { filters.push({ op: "lte", col, val }); return builder; },
        order(col, opts) { orders.push({ col, asc: !(opts && opts.ascending === false) }); return builder; },
        limit(n) { limitN = n; return builder; },
        then(resolve, reject) {
          try {
            return Promise.resolve(run()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e).then(resolve, reject);
          }
        },
      };
      return builder;
    },
  };
}

const NOW = new Date("2026-06-15T12:00:00Z");

function fixtures() {
  return {
    clients: [
      { id: "c1", business_name: "Alpha Co", email: "a@x.com", is_active: true, created_at: "2026-06-14T00:00:00Z", plan_id: "pGold" },
      { id: "c2", business_name: "Beta Co", email: "b@x.com", is_active: true, created_at: "2026-06-10T00:00:00Z", plan_id: "pGold" },
      { id: "c3", business_name: "Gamma Co", email: "g@x.com", is_active: false, created_at: "2026-05-01T00:00:00Z", plan_id: "pSilver" },
      { id: "c4", business_name: "Delta Co", email: "d@x.com", is_active: true, created_at: "2026-04-01T00:00:00Z", plan_id: null },
    ],
    plans: [
      { id: "pGold", name: "Gold" },
      { id: "pSilver", name: "Silver" },
    ],
    subscriptions: [
      { id: "s1", client_id: "c1", plan_id: "pGold", status: "active", start_date: "2026-06-01T00:00:00Z", end_date: "2026-06-18T00:00:00Z", created_at: "2026-06-01T00:00:00Z" }, // expiring in ~3d
      { id: "s2", client_id: "c2", plan_id: "pGold", status: "active", start_date: "2026-05-01T00:00:00Z", end_date: "2026-06-10T00:00:00Z", created_at: "2026-05-01T00:00:00Z" }, // expired-active
      { id: "s3", client_id: "c3", plan_id: "pSilver", status: "cancelled", start_date: "2026-04-01T00:00:00Z", end_date: "2026-05-01T00:00:00Z", created_at: "2026-04-01T00:00:00Z" },
      { id: "s4", client_id: "c1", plan_id: "pGold", status: "expired", start_date: "2026-05-01T00:00:00Z", end_date: "2026-06-01T00:00:00Z", created_at: "2026-05-01T00:00:00Z" }, // older sub for c1
    ],
    conversations: [
      { id: "cv1", client_id: "c1", conversation_status: "active" },
      { id: "cv2", client_id: "c1", conversation_status: "waiting_human" },
      { id: "cv3", client_id: "c2", conversation_status: "waiting_human" },
      { id: "cv4", client_id: "c2", conversation_status: "closed" },
      { id: "cv5", client_id: "c3", conversation_status: "closed" },
    ],
    messages: [
      // last 7d window (chartFrom = 2026-06-09)
      { client_id: "c1", direction: "inbound", reply_source: null, created_at: "2026-06-15T08:00:00Z" },
      { client_id: "c1", direction: "outbound", reply_source: "ai", created_at: "2026-06-15T08:01:00Z" },
      { client_id: "c1", direction: "outbound", reply_source: "human", created_at: "2026-06-14T09:00:00Z" },
      { client_id: "c2", direction: "inbound", reply_source: null, created_at: "2026-06-13T09:00:00Z" },
      { client_id: "c2", direction: "outbound", reply_source: "ai", created_at: "2026-06-13T09:01:00Z" },
      // in last 30d but outside 7d
      { client_id: "c1", direction: "outbound", reply_source: "ai", created_at: "2026-05-30T00:00:00Z" },
      { client_id: "c3", direction: "inbound", reply_source: null, created_at: "2026-05-28T00:00:00Z" },
      // older than 30d (excluded from top clients)
      { client_id: "c2", direction: "inbound", reply_source: null, created_at: "2026-01-01T00:00:00Z" },
      // today
      { client_id: "c1", direction: "inbound", reply_source: null, created_at: "2026-06-15T01:00:00Z" },
    ],
    client_feature_integrations: [
      { id: "fi1", is_active: true, features: { slug: "facebook" } },
      { id: "fi2", is_active: true, features: { slug: "facebook_messenger" } },
      { id: "fi3", is_active: false, features: { slug: "instagram" } },
      { id: "fi4", is_active: true, features: { slug: "telegram_bot" } },
      { id: "fi5", is_active: true, features: { slug: "ai_auto_reply" } }, // not a channel
      { id: "fi6", is_active: true, features: { slug: "whatsapp" } }, // ignored here — WA comes from client_whatsapp
    ],
    client_whatsapp: [
      { id: "w1", status: "connected" },
      { id: "w2", status: "open" },
      { id: "w3", status: "pending" },
    ],
  };
}

// ---------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------

test("Total Clients + active/inactive from clients.is_active", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  assert.equal(o.clients.total, 4);
  assert.equal(o.clients.active, 3);
  assert.equal(o.clients.inactive, 1);
});

test("Active Subscriptions = status='active'; expiring_soon within 7 days", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  assert.equal(o.subscriptions.active, 2); // s1, s2 (s3 cancelled, s4 expired)
  assert.equal(o.subscriptions.expiring_soon, 1); // s1 (end 06-18)
});

test("Open Conversations = active + waiting_human (closed excluded)", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  assert.equal(o.conversations.open, 3); // cv1 active, cv2 + cv3 waiting_human
  assert.equal(o.conversations.waiting_human, 2);
});

test("Messages today counts every message dated today (UTC)", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  // 2026-06-15: 08:00, 08:01, 01:00 -> 3
  assert.equal(o.messages.today, 3);
  // last 7 days (>= 2026-06-09): all of the 06-13/06-14/06-15 rows = 6
  assert.equal(o.messages.last_7_days, 6);
});

test("Message activity chart: 7 UTC day buckets, real inbound/outbound", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  assert.equal(o.message_activity.days.length, 7);
  const byDay = Object.fromEntries(o.message_activity.days.map((d) => [d.day, d]));
  assert.deepEqual(byDay["2026-06-15"], { day: "2026-06-15", inbound: 2, outbound: 1 });
  assert.deepEqual(byDay["2026-06-14"], { day: "2026-06-14", inbound: 0, outbound: 1 });
  assert.deepEqual(byDay["2026-06-13"], { day: "2026-06-13", inbound: 1, outbound: 1 });
  assert.deepEqual(byDay["2026-06-11"], { day: "2026-06-11", inbound: 0, outbound: 0 });
});

test("Top Clients by Usage: grouped per client_id (last 30d), names joined, AI counted", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  assert.equal(o.top_clients.window_days, 30);
  const byId = Object.fromEntries(o.top_clients.clients.map((c) => [c.client_id, c]));
  // c1 in last 30d: 5 msgs (2 ai). c2: 2 msgs (1 ai). c3: 1 msg. (Jan msg excluded.)
  assert.equal(byId.c1.messages, 5);
  assert.equal(byId.c1.ai_messages, 2);
  assert.equal(byId.c1.client_name, "Alpha Co");
  assert.equal(byId.c2.messages, 2);
  assert.equal(byId.c3.messages, 1);
  // ranked desc by messages
  assert.deepEqual(o.top_clients.clients.map((c) => c.client_id), ["c1", "c2", "c3"]);
});

test("Plan Distribution: clients grouped by their plan (incl. 'no plan')", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  const byPlan = Object.fromEntries(o.plan_distribution.map((p) => [p.plan || "__none__", p.clients]));
  assert.equal(byPlan.Gold, 2); // c1, c2
  assert.equal(byPlan.Silver, 1); // c3
  assert.equal(byPlan.__none__, 1); // c4
});

test("Channel Distribution counts CUSTOMER channel accounts, not admin integrations", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  const byCh = Object.fromEntries(o.channel_distribution.map((c) => [c.channel, c]));
  assert.equal(byCh.facebook.active, 2); // fi1 + fi2 (messenger), both active
  assert.equal(byCh.instagram.active, 0); // fi3 inactive
  assert.equal(byCh.instagram.total, 1);
  assert.equal(byCh.telegram.active, 1); // fi4
  // whatsapp from client_whatsapp, connected statuses only
  assert.equal(byCh.whatsapp.active, 2); // w1 connected + w2 open
  assert.equal(byCh.whatsapp.total, 3);
  assert.equal(byCh.whatsapp.active_is_connected, true);
  // ai_auto_reply feature row must NOT appear as a channel
  assert.ok(!o.channel_distribution.some((c) => c.channel === "ai_auto_reply"));
});

test("Recent Clients: newest first, with plan + latest subscription status", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  assert.deepEqual(o.recent_clients.map((c) => c.client_id), ["c1", "c2", "c3", "c4"]);
  const c1 = o.recent_clients[0];
  assert.equal(c1.plan, "Gold");
  assert.equal(c1.subscription_status, "active"); // s1 is newer than s4
  assert.equal(c1.is_active, true);
});

test("Attention Required: expiring-soon + expired-still-active, from subscriptions only", async () => {
  const o = await computeAdminOverview(makeDb(fixtures()), NOW);
  assert.equal(o.attention.expiring_soon.length, 1);
  assert.equal(o.attention.expiring_soon[0].client_id, "c1");
  assert.equal(o.attention.expired_active.length, 1);
  assert.equal(o.attention.expired_active[0].client_id, "c2"); // s2 active + end_date past
  assert.ok(o.attention.expired_active[0].days_overdue >= 4);
});

test("zero-data platform returns valid zeros / empty arrays, never an error", async () => {
  const o = await computeAdminOverview(
    makeDb({ clients: [], plans: [], subscriptions: [], conversations: [], messages: [], client_feature_integrations: [], client_whatsapp: [] }),
    NOW
  );
  assert.equal(o.clients.total, 0);
  assert.equal(o.subscriptions.active, 0);
  assert.equal(o.conversations.open, 0);
  assert.equal(o.messages.today, 0);
  assert.deepEqual(o.top_clients.clients, []);
  assert.deepEqual(o.plan_distribution, []);
  assert.deepEqual(o.recent_clients, []);
  assert.equal(o.attention.expiring_soon.length, 0);
  assert.equal(o.attention.expired_active.length, 0);
  assert.equal(o.message_activity.days.length, 7);
});

test("whatsapp falls back to configured-count when the status column is absent", async () => {
  const f = fixtures();
  f.client_whatsapp = [{ id: "w1" }, { id: "w2" }]; // no status key
  const o = await computeAdminOverview(makeDb(f), NOW);
  const wa = o.channel_distribution.find((c) => c.channel === "whatsapp");
  assert.equal(wa.total, 2);
  assert.equal(wa.active, 2); // mirrors total
  assert.equal(wa.active_is_connected, false);
});

// ---------------------------------------------------------------------
// Auth contract (handler-level)
// ---------------------------------------------------------------------

test("computeAdminOverview takes NO tenant/client_id argument — it is platform-wide by design", () => {
  // (supabase, nowOverride) only
  assert.equal(computeAdminOverview.length, 2);
});

test("system-settings handler: admin-only, and the overview branch reads no client_id/role from the request", () => {
  const src = readFileSync(fileURLToPath(new URL("../../system-settings.js", import.meta.url)), "utf8");
  // admin is resolved server-side and a non-admin is rejected BEFORE the overview branch
  const adminCheckIdx = src.indexOf("resolveActingAdmin");
  const notAdmin401Idx = src.indexOf('if (!admin)');
  const overviewIdx = src.indexOf('resource === "overview"');
  assert.ok(adminCheckIdx > -1 && notAdmin401Idx > -1 && overviewIdx > -1);
  assert.ok(notAdmin401Idx < overviewIdx, "the !admin 401 must come before the overview branch");
  // no client_id / role trusted from the request anywhere in the file
  assert.doesNotMatch(src, /req\.(query|body)\??\.\s*client_id/);
  assert.doesNotMatch(src, /req\.(query|body)\??\.\s*role/);
  // only actor_user_id is read from the request
  assert.match(src, /req\.query\?\.actor_user_id/);
});
