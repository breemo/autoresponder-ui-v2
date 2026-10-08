import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  ArrowPathIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ClockIcon,
  Cog6ToothIcon,
  InboxIcon,
  PlusIcon,
  SparklesIcon,
  Squares2X2Icon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { PERMISSIONS, hasUserPermission } from "../../lib/permissions.js";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  ProgressBar,
  Skeleton,
  StatTile,
  StatusPill,
  conversationStatusTone,
} from "../../components/app/primitives.jsx";
import { AppChannelTile } from "../../components/app/Channel.jsx";

// Client Home — every number on this page is real data:
//   - /api/conversation?resource=dashboard (server-side summary: open /
//     waiting counts, recent conversations, reply_source breakdown, 7-day
//     activity buckets, billing-period message usage, integrations list)
//   - leads count, plan, subscription (existing reads, unchanged)
// Widgets for data that does not exist (live activity feed, channel health,
// conversations fully handled by AI, exact local "today") are intentionally
// absent. See engineering/reports/claude/2026-10-07-client-portal-ui-audit-and-migration-plan.md §13.

// Reply-source order/keys are the product's real set — see AutoResponder_*
// n8n `state_payload` (ai | auto | human | quick_reply | system).
const SOURCE_KEYS = ["ai", "auto", "human", "quick_reply", "system"];

const SOURCE_BAR = {
  ai: "bg-violet-500",
  auto: "bg-indigo-500",
  human: "bg-amber-500",
  quick_reply: "bg-sky-500",
  system: "bg-slate-400",
};

function getSourceLabel(key, t) {
  return t(`home.source.${key}`, { defaultValue: key });
}

function getSubscriptionStatusLabel(status, t) {
  const map = {
    active: t("common.active"),
    trial: t("common.trial"),
    cancelled: t("common.cancelled"),
    expired: t("common.expired"),
    suspended: t("common.suspended"),
    upgraded: t("common.upgraded"),
  };
  return map[status] || status;
}

function getConversationStatusLabel(status, t) {
  if (status === "waiting_human") return t("home.statusWaiting");
  if (status === "closed") return t("home.statusClosed");
  return t("home.statusOpen");
}

function relativeTime(value, t) {
  if (!value) return "-";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return t("common.timeNow");
  if (minutes < 60) return t("common.timeMinutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("common.timeHoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  return t("common.timeDaysAgo", { count: days });
}

function formatDate(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(lang === "en" ? "en-US" : "ar-EG", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

// Calendar-day based, matching the corrected client_subscription_status
// view (a subscription stays active through the entirety of its end_date
// day) rather than an exact-timestamp comparison.
function getDaysRemaining(endDate) {
  if (!endDate) return null;
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// Same semantics as before: limit null/undefined => unlimited.
function UsageRow({ label, used, limit }) {
  const { t } = useTranslation();
  const unlimited = limit === null || limit === undefined;
  const percent = !unlimited && limit > 0 ? Math.min(100, Math.round(((used || 0) / limit) * 100)) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-slate-600">{label}</span>
        <span className="font-semibold tabular-nums text-slate-900">{unlimited ? t("common.unlimited") : `${used || 0} / ${limit}`}</span>
      </div>
      {unlimited ? <div className="h-1.5 rounded-full bg-slate-100" /> : <ProgressBar percent={percent} />}
    </div>
  );
}

export default function ClientDashboard() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  // client_id is resolved once at login via client_users (see Login.jsx) —
  // every user of this client (Owner/Agent/IT) shares the same client_id,
  // so they all resolve the same business data below.
  const realClientId = user?.client_id || null;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // Operational aggregates (open/waiting counts, recent conversations,
  // billing-period messages usage, reply_source breakdown, 7-day activity
  // chart) — computed server-side from the authoritative
  // public.conversations / public.messages. The browser cannot read
  // public.messages directly (RLS denies the anon role — it returned an
  // empty set, which is why every message-derived widget rendered zeros),
  // and conversation_state is legacy/non-authoritative. See
  // api/_lib/dashboardSummary.js.
  const [summary, setSummary] = useState(null);
  const [leadsCount, setLeadsCount] = useState(0);
  const [integrations, setIntegrations] = useState([]);
  const [plan, setPlan] = useState(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState(null); // client_subscription_status row
  const [subscription, setSubscription] = useState(null); // full subscriptions row

  useEffect(() => {
    if (!realClientId) {
      setError(t("dashboard.errorNoClient"));
      setLoading(false);
      return;
    }
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realClientId]);

  async function loadDashboard() {
    try {
      setLoading(true);
      setRefreshing(true);
      setError("");

      const [clientRes, summaryResult, leadsRes, subStatusRes] =
        await Promise.all([
          supabase.from("clients").select("id, plan_id").eq("id", realClientId).maybeSingle(),
          // Server-side, service-role, tenant-scoped operational aggregates.
          // client_id is derived from the authenticated membership server-side;
          // actor_user_id is the only value sent.
          fetch(`/api/conversation?resource=dashboard&actor_user_id=${encodeURIComponent(user?.id || "")}`)
            .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
            .catch(() => ({ ok: false, body: {} })),
          supabase
            .from("leads")
            .select("id", { count: "exact", head: true })
            .eq("client_id", realClientId),
          supabase
            .from("client_subscription_status")
            .select("*")
            .eq("client_id", realClientId)
            .maybeSingle(),
        ]);

      if (clientRes.error) throw clientRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (subStatusRes.error) console.warn("subscription status error", subStatusRes.error);

      // The operational aggregates endpoint failing must not blank the
      // whole page — the plan / subscription / leads / integrations cards
      // still render. Surface the error and leave `summary` null so the
      // operational widgets show real zeros/empty, never fabricated data.
      if (summaryResult.ok && summaryResult.body?.success) {
        setSummary(summaryResult.body);
      } else {
        setSummary(null);
        setError(t("dashboard.errorLoad"));
        console.warn("dashboard summary error", summaryResult.body);
      }

      setLeadsCount(leadsRes.count || 0);
      // Channel list (name + active flag, never `config`) comes from the
      // same server-side dashboard summary — no direct browser read of
      // client_feature_integrations (D4).
      setIntegrations(
        summaryResult.ok && Array.isArray(summaryResult.body?.integrations) ? summaryResult.body.integrations : []
      );
      setSubscriptionStatus(subStatusRes.data || null);

      // Plan and full subscription details — real data only; left null
      // (and rendered as "no plan"/"no subscription") rather than fabricated
      // when the client genuinely has neither, which is a normal state
      // (plans/subscriptions are optional at client creation).
      const planId = clientRes.data?.plan_id;
      if (planId) {
        const { data: planRow } = await supabase
          .from("plans")
          .select("id, name, price, description, messages_limit, ai_replies_limit, auto_replies_limit, integrations_limit")
          .eq("id", planId)
          .maybeSingle();
        setPlan(planRow || null);
      } else {
        setPlan(null);
      }

      const subscriptionId = subStatusRes.data?.subscription_id;
      if (subscriptionId) {
        const { data: subRow } = await supabase
          .from("subscriptions")
          .select("id, subscription_type, status, start_date, end_date, messages_used, ai_replies_used, auto_replies_used")
          .eq("id", subscriptionId)
          .maybeSingle();
        setSubscription(subRow || null);
      } else {
        setSubscription(null);
      }
    } catch (err) {
      console.error(err);
      setError(t("dashboard.errorLoad"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const dashboard = useMemo(() => {
    const s = summary;
    const dateLocale = i18n.language === "en" ? "en-US" : "ar-EG";

    // Automation & Replies — server-side reply_source breakdown over the
    // current billing period (trailing 30d when there is no subscription).
    const byKey = Object.fromEntries((s?.automation?.stats || []).map((x) => [x.key, x.value]));
    const outboundTotal = Math.max(s?.automation?.outbound_total || 0, 1);
    const sourceStats = SOURCE_KEYS.map((key) => {
      const value = byKey[key] || 0;
      return { key, value, percentage: Math.round((value / outboundTotal) * 100) };
    });

    // Chart — server returns 7 UTC day buckets (YYYY-MM-DD); localise the
    // weekday label only, keep the existing design.
    const chartData = (s?.chart?.days || []).map((d) => ({
      day: new Date(`${d.day}T00:00:00Z`).toLocaleDateString(dateLocale, { weekday: "short" }),
      inbound: d.inbound || 0,
      outbound: d.outbound || 0,
    }));

    // Recent — authoritative public.conversations, closed included,
    // ordered by real activity (last_message_at) server-side.
    const conversations = (s?.recent_conversations || []).map((c) => ({
      id: c.conversation_id,
      channel: c.channel || c.platform || "unknown",
      sender: c.customer_name || c.sender_id || "",
      status: c.conversation_status || "active",
      lastMessage: c.last_message || "",
      updatedAt: c.last_message_at,
      count: c.messages_count || 0,
    }));

    return {
      conversations,
      openConversations: s?.open_conversations ?? 0,
      waitingHuman: s?.waiting_human ?? 0,
      sourceStats,
      chartData,
      connectedIntegrations: integrations.filter((i) => i.is_active).length,
    };
  }, [summary, integrations, i18n.language]);

  const displayName = user?.business_name || user?.name || user?.email || t("dashboard.defaultClientName");
  const recentConversations = dashboard.conversations.slice(0, 5);
  const messagesUsage = summary?.messages_usage || null;
  const daysRemaining = subscription?.end_date ? getDaysRemaining(subscription.end_date) : null;

  // ---- Presentation-only derivations from the same real data ----------
  const canInbox = hasUserPermission(user, PERMISSIONS.INBOX);
  const canLeads = hasUserPermission(user, PERMISSIONS.LEADS);
  const canIntegrations = hasUserPermission(user, PERMISSIONS.INTEGRATIONS);

  // AI share of REPLIES (outbound messages with reply_source = "ai") over the
  // server's automation window. This is NOT "conversations fully handled by
  // AI" — that metric does not exist and is not shown.
  const automation = summary?.automation || null;
  const outboundTotal = automation?.outbound_total || 0;
  const aiReplies = (automation?.stats || []).find((x) => x.key === "ai")?.value || 0;
  const aiShare = outboundTotal > 0 ? Math.round((aiReplies / outboundTotal) * 100) : null;
  const periodLabel = automation?.basis === "billing_period" ? t("home.periodBilling") : t("home.periodTrailing");
  const messages7d = (summary?.chart?.days || []).reduce((sum, d) => sum + (d.inbound || 0) + (d.outbound || 0), 0);
  const activeChannels = integrations.filter((i) => i.is_active).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("home.welcome", { name: displayName })}
        description={t("home.subtitle")}
        actions={
          <Button onClick={loadDashboard} disabled={refreshing || !realClientId}>
            <ArrowPathIcon className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {t("common.refresh")}
          </Button>
        }
      />

      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {/* KPI row — real values only */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label={t("dashboard.openConversationsTitle")}
          value={dashboard.openConversations}
          loading={loading}
          icon={ChatBubbleLeftRightIcon}
          tone="indigo"
          hint={t("home.openHint")}
          href={canInbox ? "/client/messages" : undefined}
        />
        <StatTile
          label={t("common.waitingHuman")}
          value={dashboard.waitingHuman}
          loading={loading}
          icon={ClockIcon}
          tone="amber"
          hint={t("home.waitingHint")}
          href={canInbox ? "/client/messages" : undefined}
        />
        <StatTile
          label={t("home.leadsCaptured")}
          value={leadsCount}
          loading={loading}
          icon={UserPlusIcon}
          tone="emerald"
          hint={t("home.leadsHint")}
          href={canLeads ? "/client/leads" : undefined}
        />
        <StatTile
          label={t("home.activeChannels")}
          value={activeChannels}
          loading={loading}
          icon={Squares2X2Icon}
          tone="sky"
          hint={t("home.channelsHint", { total: integrations.length })}
          href={canIntegrations ? "/client/integrations" : undefined}
        />
        <StatTile
          label={t("home.aiShare")}
          value={aiShare === null ? null : `${aiShare}%`}
          loading={loading}
          icon={SparklesIcon}
          tone="violet"
          hint={aiShare === null ? t("home.aiShareEmpty") : t("home.aiShareHint", { ai: aiReplies, total: outboundTotal })}
          className="col-span-2 md:col-span-1"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Recent conversations */}
        <Card className="xl:col-span-2">
          <CardHeader
            title={t("dashboard.recentConversationsTitle")}
            subtitle={t("dashboard.recentConversationsSubtitle")}
            action={
              canInbox && (
                <Link to="/client/messages" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                  {t("home.openInbox")}
                </Link>
              )
            }
          />
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : recentConversations.length === 0 ? (
            <EmptyState icon={InboxIcon} title={t("dashboard.noConversations")} />
          ) : (
            <ul className="-mx-2 divide-y divide-slate-100">
              {recentConversations.map((conversation) => (
                <li key={conversation.id} className="flex items-center gap-3 rounded-xl px-2 py-2">
                  <AppChannelTile channel={conversation.channel} className="h-8 w-8 rounded-lg" iconClassName="h-4 w-4" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900"><bdi>{conversation.sender || t("common.noName")}</bdi></p>
                      <StatusPill tone={conversationStatusTone(conversation.status)}>{getConversationStatusLabel(conversation.status, t)}</StatusPill>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500"><bdi>{conversation.lastMessage || t("dashboard.noMessage")}</bdi></p>
                  </div>
                  <div className="shrink-0 text-end">
                    <p className="text-[11px] text-slate-400">{relativeTime(conversation.updatedAt, t)}</p>
                    <p className="mt-0.5 text-[11px] font-medium text-slate-500">{t("dashboard.messageCount", { count: conversation.count })}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Replies by source + AI share of replies */}
        <Card>
          <CardHeader title={t("home.repliesBySource")} subtitle={periodLabel} />
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : outboundTotal === 0 ? (
            <EmptyState icon={SparklesIcon} title={t("home.aiShareEmpty")} />
          ) : (
            <>
              <div className="mb-4 rounded-xl bg-violet-50/70 px-3.5 py-3">
                <p className="text-xs font-medium text-violet-700">{t("home.aiShare")}</p>
                <p className="mt-0.5 text-2xl font-bold tabular-nums text-violet-900">{aiShare}%</p>
                <p className="mt-1 text-[11px] leading-relaxed text-violet-700/80">{t("home.aiShareNote")}</p>
              </div>
              <ul className="space-y-3">
                {dashboard.sourceStats.map((source) => (
                  <li key={source.key}>
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-slate-600">{getSourceLabel(source.key, t)}</span>
                      <span className="font-semibold tabular-nums text-slate-900">
                        {source.value} <span className="font-normal text-slate-400">· {source.percentage}%</span>
                      </span>
                    </div>
                    <ProgressBar percent={source.percentage} tone={SOURCE_BAR[source.key]} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* 7-day activity */}
        <Card className="xl:col-span-2">
          <CardHeader
            title={t("dashboard.messageActivityTitle")}
            subtitle={t("home.activityRange")}
            action={!loading && <StatusPill tone="indigo">{t("home.messages7d", { count: messages7d })}</StatusPill>}
          />
          <div className="mb-2 flex items-center gap-4 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-indigo-600" />
              {t("dashboard.chartInbound")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {t("dashboard.chartOutbound")}
            </span>
          </div>
          <div className="h-52" dir="ltr">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dashboard.chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="homeInbound" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="homeOutbound" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f6" vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#94a3b8" }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#94a3b8" }} width={40} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} />
                  <Area type="monotone" dataKey="inbound" stroke="#4f46e5" strokeWidth={2.2} fill="url(#homeInbound)" name={t("dashboard.chartInbound")} />
                  <Area type="monotone" dataKey="outbound" stroke="#10b981" strokeWidth={2.2} fill="url(#homeOutbound)" name={t("dashboard.chartOutbound")} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Plan & usage — same data and rules as before */}
        <Card>
          <CardHeader
            title={t("home.planUsage")}
            action={
              hasUserPermission(user, PERMISSIONS.AI_SETTINGS) && (
                <Link to="/client/plan-billing" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                  {t("home.viewPlanBilling")}
                </Link>
              )
            }
          />
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="space-y-4">
              {plan ? (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-slate-500">{t("common.currentPlan")}</p>
                    <p className="mt-0.5 truncate text-base font-semibold text-slate-900">{plan.name}</p>
                    {plan.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{plan.description}</p>}
                  </div>
                  {plan.price != null && <StatusPill tone="indigo">{plan.price}</StatusPill>}
                </div>
              ) : (
                <EmptyState title={t("dashboard.noPlan")} className="py-5" />
              )}

              {subscription ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs">
                  <dt className="text-slate-500">{t("common.status")}</dt>
                  <dd className="text-end">
                    <StatusPill tone={subscriptionStatus?.is_active ? "emerald" : "rose"}>{getSubscriptionStatusLabel(subscription.status, t)}</StatusPill>
                  </dd>
                  <dt className="text-slate-500">{t("common.type")}</dt>
                  <dd className="text-end font-medium text-slate-800">{subscription.subscription_type === "trial" ? t("common.trial") : t("common.paid")}</dd>
                  <dt className="text-slate-500">{t("featureSettingsPage.endDateLabel")}</dt>
                  <dd className="text-end font-medium text-slate-800">{formatDate(subscription.end_date, i18n.language)}</dd>
                  <dt className="text-slate-500">{t("common.daysRemaining")}</dt>
                  <dd className={`text-end font-semibold ${daysRemaining !== null && daysRemaining < 0 ? "text-rose-600" : "text-indigo-600"}`}>
                    {daysRemaining === null ? "—" : daysRemaining < 0 ? t("common.expired") : t("featureSettingsPage.remainingDaysValue", { days: daysRemaining })}
                  </dd>
                </dl>
              ) : (
                <EmptyState title={t("dashboard.noSubscription")} className="py-5" />
              )}

              {subscription && plan ? (
                <div className="space-y-3">
                  {/* Messages Usage = actual public.messages rows counted
                      server-side over the CURRENT subscription billing period;
                      limit is that period's plan.messages_limit (null =>
                      unlimited). Not the stale subscriptions.messages_used. */}
                  <UsageRow
                    label={t("common.messagesLabel")}
                    used={messagesUsage?.used ?? subscription.messages_used ?? 0}
                    limit={messagesUsage?.plan_known ? messagesUsage.limit : (plan.messages_limit ?? null)}
                  />
                  <UsageRow label={t("dashboard.usageAiReplies")} used={subscription.ai_replies_used} limit={plan.ai_replies_limit} />
                  <UsageRow label={t("dashboard.usageAutoReplies")} used={subscription.auto_replies_used} limit={plan.auto_replies_limit} />
                </div>
              ) : (
                <p className="text-xs text-slate-400">{t("dashboard.usageUnavailable")}</p>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Channels — Active / Inactive is what the data means (enabled), not health */}
        <Card className="xl:col-span-2">
          <CardHeader
            title={t("home.channels")}
            subtitle={t("home.channelsNote")}
            action={
              canIntegrations && (
                <Link to="/client/integrations" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                  {t("dashboard.manage")}
                </Link>
              )
            }
          />
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : integrations.length === 0 ? (
            <EmptyState icon={Squares2X2Icon} title={t("dashboard.noChannels")} />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              {integrations.map((item) => {
                const slug = item.features?.slug || "integration";
                return (
                  <li key={item.id} className="flex items-center gap-3 rounded-xl border border-slate-200/80 px-3 py-2.5">
                    <AppChannelTile channel={slug} className="h-8 w-8 rounded-lg" iconClassName="h-4 w-4" />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{item.features?.name || slug}</p>
                    <StatusPill tone={item.is_active ? "emerald" : "slate"} dot>
                      {item.is_active ? t("common.active") : t("common.inactive")}
                    </StatusPill>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={t("dashboard.quickActionsTitle")} />
          <div className="grid grid-cols-2 gap-2">
            {canInbox && (
              <Link to="/client/messages" className="rounded-xl border border-slate-200/80 p-3 transition hover:border-indigo-200 hover:bg-indigo-50/40">
                <InboxIcon className="mb-2 h-5 w-5 text-indigo-600" />
                <p className="text-xs font-semibold text-slate-800">{t("home.openInbox")}</p>
              </Link>
            )}
            {hasUserPermission(user, PERMISSIONS.AUTO_REPLIES) && (
              <Link to="/client/auto-replies" className="rounded-xl border border-slate-200/80 p-3 transition hover:border-indigo-200 hover:bg-indigo-50/40">
                <PlusIcon className="mb-2 h-5 w-5 text-indigo-600" />
                <p className="text-xs font-semibold text-slate-800">{t("shell.tabs.autoReplies")}</p>
              </Link>
            )}
            {hasUserPermission(user, PERMISSIONS.AUTO_REPLIES) && (
              <Link to="/client/quick-replies" className="rounded-xl border border-slate-200/80 p-3 transition hover:border-indigo-200 hover:bg-indigo-50/40">
                <CheckCircleIcon className="mb-2 h-5 w-5 text-indigo-600" />
                <p className="text-xs font-semibold text-slate-800">{t("shell.tabs.quickReplies")}</p>
              </Link>
            )}
            {hasUserPermission(user, PERMISSIONS.SETTINGS) && (
              <Link to="/client/settings" className="rounded-xl border border-slate-200/80 p-3 transition hover:border-indigo-200 hover:bg-indigo-50/40">
                <Cog6ToothIcon className="mb-2 h-5 w-5 text-indigo-600" />
                <p className="text-xs font-semibold text-slate-800">{t("shell.nav.settings")}</p>
              </Link>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
