import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";

// Client Dashboard — server-side read model, Conversation V2 / current
// message model.
//
// ---------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------
// ClientDashboard.jsx used to assemble every operational number in the
// browser from `supabase.from("messages")` + `supabase.from("conversation_state")`.
// public.messages denies SELECT to the anon browser role (proven by
// api/_lib/conversationsList.js / handleConversationMessages), so the
// browser query returned an EMPTY ARRAY (not an error) and every
// message-derived widget silently rendered zeros: Recent Conversations
// empty, Messages Usage 0, Automation & Replies 0, the activity chart
// flat. The two working stat cards read `conversation_state` (still
// anon-readable, legacy) — a different, non-authoritative source.
//
// This endpoint replaces those broken/legacy reads with one authenticated,
// service-role, tenant-scoped call over the AUTHORITATIVE tables
// (public.conversations, public.messages). conversation_state is NOT read
// here at all.
//
// ---------------------------------------------------------------------
// Dashboard contract (definitions)
// ---------------------------------------------------------------------
//  Open Conversations : conversations.conversation_status IN ('active','waiting_human')
//  Waiting for Human  : conversations.conversation_status = 'waiting_human'
//  Recent             : conversations ordered by last_message_at (then
//                       started_at, then created_at), closed included
//  Messages Usage     : COUNT(messages) in the current subscription's
//                       billing period [start_date .. min(end_date, now)];
//                       limit = the period's plan.messages_limit
//                       (NULL = unlimited). No subscription => usage null
//                       (the card shows "unavailable", unchanged).
//  Automation&Replies : reply_source breakdown of outbound messages over
//                       the same billing period (trailing 30 days when
//                       there is no subscription). reply_source values are
//                       the product's real set: ai | auto | human |
//                       quick_reply | system (see AutoResponder_* n8n
//                       state_payload). No invented categories.
//  Chart              : inbound / outbound message counts per day for the
//                       last 7 calendar days (UTC). Real rows only.
//
// Every query is scoped to actor.membership.client_id, re-derived
// server-side — client_id is never taken from the request. Auth: an
// active client_users membership with the DASHBOARD permission (the same
// gate src/App.jsx puts on the /client route). Any client role
// (owner/agent/it) has DASHBOARD by default.
//
// Shape: GET /api/conversation?resource=dashboard&actor_user_id=<id>
//   -> { success: true, open_conversations, waiting_human,
//        recent_conversations: [...], messages_usage: {...},
//        automation: {...}, chart: {...} }

const REPLY_SOURCES = ["ai", "auto", "human", "quick_reply", "system"];
const DAY_MS = 24 * 60 * 60 * 1000;

function getMessageText(msg) {
  if (!msg || typeof msg !== "object") return "";
  return (
    msg.message ??
    msg.text ??
    msg.body ??
    msg.content ??
    msg.reply_text ??
    msg.reply ??
    ""
  );
}

// COUNT(*) helper — head:true so no rows are transferred.
async function countRows(query) {
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

export async function handleDashboardSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  // messages RLS denies the anon role; this endpoint is meaningless without
  // the service role. Fail loudly rather than silently returning zeros
  // (the exact failure mode this endpoint exists to fix).
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("dashboard: SUPABASE_SERVICE_ROLE_KEY is not set — refusing to serve dashboard aggregates (anon-key reads on public.messages return an empty set under RLS, not an error).");
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await resolveActingMembership(supabase, req.query?.actor_user_id);
  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.DASHBOARD)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  // TENANT SCOPE: always the membership's own client_id, re-derived
  // server-side. Nothing in the request body/query can change it — there
  // is no client_id parameter anywhere in this handler.
  const clientId = actor.membership.client_id;

  try {
    const summary = await computeDashboardSummary(supabase, clientId);
    return res.status(200).json({ success: true, ...summary });
  } catch (error) {
    console.error("dashboard: failed to build summary:", error);
    return res.status(500).json({ success: false, message: "فشل في تحميل لوحة المعلومات" });
  }
}

// The data core — no req/res, no auth, no env. `clientId` MUST already be a
// server-derived, membership-scoped value; every query below is filtered by
// it. Exposed for unit tests (multi-tenant isolation, the dashboard
// contract definitions). Returns the response body without `success`.
export async function computeDashboardSummary(supabase, clientId, nowOverride) {
  const now = nowOverride instanceof Date ? nowOverride : new Date();
  const nowIso = now.toISOString();

    // -----------------------------------------------------------------
    // Billing period — the current subscription's own [start_date, end_date].
    // "Current" = most recent subscriptions row, matching
    // public.client_subscription_status (distinct on client_id order by
    // created_at desc). We do NOT invent a calendar month.
    // -----------------------------------------------------------------
    const { data: subRows, error: subError } = await supabase
      .from("subscriptions")
      .select("id, plan_id, status, start_date, end_date, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (subError) throw subError;
    const subscription = subRows?.[0] || null;

    let periodFrom = null;
    let periodTo = null;
    if (subscription?.start_date) {
      periodFrom = new Date(subscription.start_date).toISOString();
      const end = subscription.end_date ? new Date(subscription.end_date) : null;
      periodTo = end && end < now ? end.toISOString() : nowIso;
    }

    // messages_limit from the SUBSCRIPTION's plan (authoritative for this
    // period); fall back to the client's current plan only if the
    // subscription carries no plan_id.
    let messagesLimit = null; // null => unlimited (or unknown)
    let planKnown = false;
    const planId = subscription?.plan_id || null;
    if (planId) {
      const { data: planRow, error: planError } = await supabase
        .from("plans")
        .select("messages_limit")
        .eq("id", planId)
        .maybeSingle();
      if (planError) throw planError;
      if (planRow) {
        planKnown = true;
        messagesLimit =
          planRow.messages_limit === null || planRow.messages_limit === undefined
            ? null
            : Number(planRow.messages_limit);
      }
    }

    // -----------------------------------------------------------------
    // Open / Waiting — public.conversations (authoritative)
    // -----------------------------------------------------------------
    const openBase = () =>
      supabase.from("conversations").select("id", { count: "exact", head: true }).eq("client_id", clientId);

    // -----------------------------------------------------------------
    // Automation & Replies window: the billing period if we have one,
    // otherwise a trailing 30 days (bounded, real data — not invented).
    // -----------------------------------------------------------------
    const automationFrom = periodFrom || new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const automationTo = periodTo || nowIso;
    const automationBasis = periodFrom ? "billing_period" : "trailing_30d";

    const outboundInRange = () =>
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("direction", "outbound")
        .gte("created_at", automationFrom)
        .lte("created_at", automationTo);

    // -----------------------------------------------------------------
    // Chart: last 7 calendar days (UTC). One bounded fetch of the minimal
    // columns, bucketed here — no per-day round trips, no fake series.
    // -----------------------------------------------------------------
    const chartFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 6 * DAY_MS).toISOString();

    // -----------------------------------------------------------------
    // Recent conversations
    // -----------------------------------------------------------------
    const recentConvsQuery = supabase
      .from("conversations")
      .select("id, platform, conversation_status, channel_identity_id, contact_id, last_message_at, started_at, created_at, updated_at")
      .eq("client_id", clientId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("started_at", { ascending: false })
      .limit(8);

    const [
      openConversations,
      waitingHuman,
      messagesUsed,
      outboundTotal,
      replyCounts,
      { data: chartRows, error: chartError },
      { data: recentConvs, error: recentError },
    ] = await Promise.all([
      countRows(openBase().in("conversation_status", ["active", "waiting_human"])),
      countRows(openBase().eq("conversation_status", "waiting_human")),
      periodFrom
        ? countRows(
            supabase
              .from("messages")
              .select("id", { count: "exact", head: true })
              .eq("client_id", clientId)
              .gte("created_at", periodFrom)
              .lte("created_at", periodTo)
          )
        : Promise.resolve(null),
      countRows(outboundInRange()),
      Promise.all(
        REPLY_SOURCES.map((src) =>
          countRows(outboundInRange().eq("reply_source", src)).then((value) => [src, value])
        )
      ),
      supabase
        .from("messages")
        .select("created_at, direction")
        .eq("client_id", clientId)
        .gte("created_at", chartFrom)
        .limit(50000),
      recentConvsQuery,
    ]);

    if (chartError) throw chartError;
    if (recentError) throw recentError;

    // ---- Automation stats ------------------------------------------------
    const replyBySource = Object.fromEntries(replyCounts);
    const automationStats = REPLY_SOURCES.map((key) => ({
      key,
      value: replyBySource[key] || 0,
    }));

    // ---- Chart buckets (7 UTC days) ------------------------------------
    const days = [];
    const dayIndex = new Map();
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - i * DAY_MS);
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
      const bucket = { day: key, inbound: 0, outbound: 0 };
      days.push(bucket);
      dayIndex.set(key, bucket);
    }
    for (const row of chartRows || []) {
      if (!row.created_at) continue;
      const key = new Date(row.created_at).toISOString().slice(0, 10);
      const bucket = dayIndex.get(key);
      if (!bucket) continue;
      if (row.direction === "inbound") bucket.inbound += 1;
      else if (row.direction === "outbound") bucket.outbound += 1;
    }

    // ---- Recent conversations enrichment -----------------------------
    const convList = recentConvs || [];
    const identityIds = [...new Set(convList.map((c) => c.channel_identity_id).filter(Boolean))];
    const contactIds = [...new Set(convList.map((c) => c.contact_id).filter(Boolean))];
    const convIds = convList.map((c) => c.id);

    const [identityRows, contactRows, perConv] = await Promise.all([
      identityIds.length
        ? supabase
            .from("contact_channel_identities")
            .select("id, display_name, sender_id, platform")
            .in("id", identityIds)
        : Promise.resolve({ data: [] }),
      contactIds.length
        ? supabase.from("contacts").select("id, display_name").in("id", contactIds)
        : Promise.resolve({ data: [] }),
      Promise.all(
        convIds.map(async (id) => {
          const { data, count, error } = await supabase
            .from("messages")
            .select("message, created_at, direction", { count: "exact" })
            .eq("client_id", clientId)
            .eq("conversation_id", id)
            .order("created_at", { ascending: false })
            .limit(1);
          if (error) throw error;
          return [id, { last: data?.[0] || null, count: count || 0 }];
        })
      ),
    ]);

    const identityById = new Map((identityRows.data || []).map((r) => [r.id, r]));
    const contactNameById = new Map(
      (contactRows.data || [])
        .filter((r) => typeof r.display_name === "string" && r.display_name.trim())
        .map((r) => [r.id, r.display_name.trim()])
    );
    const perConvById = new Map(perConv);

    const recent_conversations = convList.map((c) => {
      const identity = identityById.get(c.channel_identity_id) || null;
      const identityName =
        typeof identity?.display_name === "string" ? identity.display_name.trim() : "";
      const info = perConvById.get(c.id) || { last: null, count: 0 };
      const platform = c.platform || identity?.platform || "";
      return {
        conversation_id: c.id,
        platform,
        channel: platform,
        conversation_status: c.conversation_status || "active",
        customer_name: contactNameById.get(c.contact_id) || identityName || null,
        sender_id: identity?.sender_id || null,
        last_message: getMessageText(info.last) || "",
        last_message_at:
          c.last_message_at || info.last?.created_at || c.started_at || c.created_at || null,
        messages_count: info.count,
      };
    });

    return {
      open_conversations: openConversations,
      waiting_human: waitingHuman,
      recent_conversations,
      messages_usage: {
        used: messagesUsed, // null when there is no current subscription period
        limit: messagesLimit, // null => unlimited (or plan unknown)
        unlimited: planKnown && messagesLimit === null,
        plan_known: planKnown,
        period_from: periodFrom,
        period_to: periodTo,
      },
      automation: {
        basis: automationBasis,
        range_from: automationFrom,
        range_to: automationTo,
        outbound_total: outboundTotal,
        stats: automationStats,
      },
      chart: {
        range_from: chartFrom,
        range_to: nowIso,
        days,
      },
    };
}
