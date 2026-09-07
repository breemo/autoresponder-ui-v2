// Auto Responder ADMIN (platform operator) Overview — server-side read
// model. Platform-wide aggregates over the AUTHORITATIVE tables
// (public.clients, public.subscriptions, public.plans,
// public.conversations, public.messages, and the per-channel account
// tables). conversation_state is NOT read.
//
// ---------------------------------------------------------------------
// Trust model
// ---------------------------------------------------------------------
// This module produces PLATFORM-WIDE data (every tenant). It must only
// ever run AFTER the caller has been verified as a platform admin
// (users.role === "admin", re-derived server-side by resolveActingAdmin
// in the api/system-settings.js handler). There is no client_id / tenant
// parameter anywhere here — a browser cannot obtain these aggregates by
// passing a client_id or a role. computeAdminOverview takes only the
// (already admin-scoped) supabase client.
//
// ---------------------------------------------------------------------
// What each widget is derived from
// ---------------------------------------------------------------------
//  Total Clients        : COUNT(public.clients), split by clients.is_active
//  Active Subscriptions : COUNT(public.subscriptions WHERE status='active');
//                         "expiring soon" = active + end_date within 7 days
//  Open Conversations   : COUNT(public.conversations
//                             WHERE conversation_status IN ('active','waiting_human'))
//  Messages             : COUNT(public.messages) today (UTC) + last 7 days
//  Message Activity     : inbound/outbound per day, last 7 UTC days, from messages
//  Top Clients by Usage : messages grouped by client_id (last 30 days),
//                         joined to clients.business_name; AI count from
//                         reply_source='ai'
//  Plan Distribution    : public.clients grouped by clients.plan_id -> plans.name
//  Channel Distribution : CUSTOMER channel accounts —
//                         facebook/instagram/telegram = active
//                         client_feature_integrations rows for that feature
//                         slug; whatsapp = client_whatsapp rows
//  Recent Clients       : public.clients ORDER BY created_at DESC LIMIT 8,
//                         + plan name + latest subscription status
//  Attention Required   : active subscriptions expiring within 7 days;
//                         active subscriptions already past end_date
//                         (nothing auto-transitions status to 'expired' —
//                         see 20260814_client_subscription_status_view.sql)
//
// Deliberately OMITTED (data not reliable from the current schema) — see
// the task report:
//  - "clients near a message / AI limit": subscriptions.messages_used /
//    ai_replies_used are stale running counters (the same reason the
//    Client Dashboard stopped trusting them); a real per-client
//    billing-period count for every tenant is too heavy for one request.
//  - "disconnected / paused channel account" as an alert:
//    client_feature_integrations.is_active=false does not distinguish a
//    real disconnect from a client deliberately pausing a channel, so it
//    is not a clear platform-operator signal.

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_CLIENTS_MESSAGE_CAP = 100000; // one bounded fetch; flagged if hit
const WA_CONNECTED_STATUSES = new Set(["connected", "open"]);

async function countRows(query) {
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

function channelOfSlug(slug) {
  const s = String(slug || "").toLowerCase();
  if (s.includes("whatsapp")) return "whatsapp";
  if (s.includes("facebook") || s.includes("messenger")) return "facebook";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("telegram")) return "telegram";
  return null;
}

export async function computeAdminOverview(supabase, nowOverride) {
  const now = nowOverride instanceof Date ? nowOverride : new Date();
  const nowIso = now.toISOString();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const chartFrom = new Date(todayStart.getTime() - 6 * DAY_MS).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const soonCutoff = new Date(now.getTime() + 7 * DAY_MS).toISOString();

  // ---- authoritative bulk reads --------------------------------------
  const [
    { data: clients, error: clientsError },
    { data: plans, error: plansError },
    { data: subscriptions, error: subsError },
    openConversations,
    waitingHuman,
    messagesToday,
    messagesLast7d,
    { data: chartRows, error: chartError },
    { data: topRows, error: topError },
    { data: featureIntegrations, error: fiError },
    waResult,
  ] = await Promise.all([
    supabase.from("clients").select("id, business_name, email, is_active, created_at, plan_id").order("created_at", { ascending: false }).limit(5000),
    supabase.from("plans").select("id, name").limit(1000),
    supabase.from("subscriptions").select("id, client_id, plan_id, status, start_date, end_date, created_at").order("created_at", { ascending: false }).limit(10000),
    countRows(supabase.from("conversations").select("id", { count: "exact", head: true }).in("conversation_status", ["active", "waiting_human"])),
    countRows(supabase.from("conversations").select("id", { count: "exact", head: true }).eq("conversation_status", "waiting_human")),
    countRows(supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", todayStart.toISOString())),
    countRows(supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", chartFrom)),
    supabase.from("messages").select("created_at, direction").gte("created_at", chartFrom).limit(50000),
    supabase.from("messages").select("client_id, reply_source").gte("created_at", thirtyDaysAgo).limit(TOP_CLIENTS_MESSAGE_CAP),
    supabase.from("client_feature_integrations").select("id, is_active, features:feature_id(slug)").limit(20000),
    // whatsapp accounts — status column is best-effort; isolate so a
    // schema surprise never fails the whole endpoint.
    supabase.from("client_whatsapp").select("id, status").limit(20000).then(
      (r) => (r.error ? supabase.from("client_whatsapp").select("id").limit(20000) : r)
    ),
  ]);

  if (clientsError) throw clientsError;
  if (plansError) throw plansError;
  if (subsError) throw subsError;
  if (chartError) throw chartError;
  if (topError) throw topError;
  if (fiError) throw fiError;

  const clientList = clients || [];
  const planById = new Map((plans || []).map((p) => [p.id, p.name || "—"]));
  const clientById = new Map(clientList.map((c) => [c.id, c]));

  // ---- Clients -------------------------------------------------------
  const totalClients = clientList.length;
  const activeClients = clientList.filter((c) => c.is_active === true).length;
  const inactiveClients = clientList.filter((c) => c.is_active === false).length;

  // ---- Subscriptions ----------------------------------------------------
  const subs = subscriptions || [];
  const activeSubs = subs.filter((s) => s.status === "active");
  const expiringSoon = activeSubs
    .filter((s) => s.end_date && s.end_date >= nowIso && s.end_date <= soonCutoff)
    .map((s) => ({
      client_id: s.client_id,
      client_name: clientById.get(s.client_id)?.business_name || clientById.get(s.client_id)?.email || null,
      end_date: s.end_date,
      days_left: Math.max(0, Math.ceil((new Date(s.end_date).getTime() - now.getTime()) / DAY_MS)),
    }))
    .sort((a, b) => a.days_left - b.days_left);
  const expiredActive = activeSubs
    .filter((s) => s.end_date && s.end_date < nowIso)
    .map((s) => ({
      client_id: s.client_id,
      client_name: clientById.get(s.client_id)?.business_name || clientById.get(s.client_id)?.email || null,
      end_date: s.end_date,
      days_overdue: Math.max(0, Math.floor((now.getTime() - new Date(s.end_date).getTime()) / DAY_MS)),
    }))
    .sort((a, b) => b.days_overdue - a.days_overdue);

  // latest subscription status per client (subs already newest-first)
  const latestSubByClient = new Map();
  for (const s of subs) {
    if (!latestSubByClient.has(s.client_id)) latestSubByClient.set(s.client_id, s);
  }

  // ---- Message chart (7 UTC days) -----------------------------------
  const days = [];
  const dayIndex = new Map();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(todayStart.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    const bucket = { day: key, inbound: 0, outbound: 0 };
    days.push(bucket);
    dayIndex.set(key, bucket);
  }
  for (const row of chartRows || []) {
    if (!row.created_at) continue;
    const bucket = dayIndex.get(new Date(row.created_at).toISOString().slice(0, 10));
    if (!bucket) continue;
    if (row.direction === "inbound") bucket.inbound += 1;
    else if (row.direction === "outbound") bucket.outbound += 1;
  }

  // ---- Top Clients by Usage (last 30 days) -------------------------
  const usageByClient = new Map();
  for (const row of topRows || []) {
    if (!row.client_id) continue;
    const u = usageByClient.get(row.client_id) || { messages: 0, ai: 0 };
    u.messages += 1;
    if (row.reply_source === "ai") u.ai += 1;
    usageByClient.set(row.client_id, u);
  }
  const topClients = [...usageByClient.entries()]
    .map(([client_id, u]) => ({
      client_id,
      client_name: clientById.get(client_id)?.business_name || clientById.get(client_id)?.email || null,
      messages: u.messages,
      ai_messages: u.ai,
    }))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 10);
  const topClientsTruncated = (topRows || []).length >= TOP_CLIENTS_MESSAGE_CAP;

  // ---- Plan Distribution (clients grouped by their assigned plan) ---
  const planCounts = new Map();
  for (const c of clientList) {
    const name = c.plan_id ? planById.get(c.plan_id) || "—" : "__none__";
    planCounts.set(name, (planCounts.get(name) || 0) + 1);
  }
  const planDistribution = [...planCounts.entries()]
    .map(([name, count]) => ({ plan: name === "__none__" ? null : name, clients: count }))
    .sort((a, b) => b.clients - a.clients);

  // ---- Channel Distribution (customer channel accounts) ------------
  const channelActive = { whatsapp: 0, facebook: 0, instagram: 0, telegram: 0 };
  const channelTotal = { whatsapp: 0, facebook: 0, instagram: 0, telegram: 0 };
  for (const row of featureIntegrations || []) {
    const ch = channelOfSlug(row.features?.slug);
    if (!ch || ch === "whatsapp") continue; // whatsapp comes from client_whatsapp
    channelTotal[ch] += 1;
    if (row.is_active === true) channelActive[ch] += 1;
  }
  const waRows = waResult && !waResult.error ? waResult.data || [] : [];
  channelTotal.whatsapp = waRows.length;
  const waHasStatus = waRows.some((r) => Object.prototype.hasOwnProperty.call(r, "status"));
  channelActive.whatsapp = waHasStatus
    ? waRows.filter((r) => WA_CONNECTED_STATUSES.has(String(r.status || "").toLowerCase())).length
    : waRows.length; // no status column available -> report configured count
  const channelDistribution = ["whatsapp", "facebook", "instagram", "telegram"].map((ch) => ({
    channel: ch,
    active: channelActive[ch],
    total: channelTotal[ch],
    // whatsapp "active" is only a real connected-count when the status
    // column is present; otherwise it mirrors total (configured accounts).
    active_is_connected: ch !== "whatsapp" || waHasStatus,
  }));

  // ---- Recent Clients ---------------------------------------------
  const recentClients = clientList.slice(0, 8).map((c) => {
    const sub = latestSubByClient.get(c.id) || null;
    return {
      client_id: c.id,
      business_name: c.business_name || null,
      email: c.email || null,
      is_active: c.is_active === true,
      created_at: c.created_at,
      plan: c.plan_id ? planById.get(c.plan_id) || null : null,
      subscription_status: sub?.status || null,
      subscription_end_date: sub?.end_date || null,
    };
  });

  return {
    clients: {
      total: totalClients,
      active: activeClients,
      inactive: inactiveClients,
    },
    subscriptions: {
      active: activeSubs.length,
      total: subs.length,
      expiring_soon: expiringSoon.length,
    },
    conversations: {
      open: openConversations,
      waiting_human: waitingHuman,
    },
    messages: {
      today: messagesToday,
      last_7_days: messagesLast7d,
    },
    message_activity: {
      range_from: chartFrom,
      range_to: nowIso,
      days,
    },
    top_clients: {
      window_days: 30,
      truncated: topClientsTruncated,
      clients: topClients,
    },
    plan_distribution: planDistribution,
    channel_distribution: channelDistribution,
    recent_clients: recentClients,
    attention: {
      expiring_soon: expiringSoon.slice(0, 10),
      expired_active: expiredActive.slice(0, 10),
    },
  };
}
