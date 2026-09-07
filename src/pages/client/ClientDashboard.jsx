import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import ChannelIcon from "../../lib/channelIcons.jsx";
import {
  ChatBubbleLeftRightIcon,
  UserGroupIcon,
  UserPlusIcon,
  ArrowPathIcon,
  ClockIcon,
  CheckCircleIcon,
  PlusIcon,
  Cog6ToothIcon,
  InboxIcon,
} from "@heroicons/react/24/outline";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { PERMISSIONS, hasUserPermission } from "../../lib/permissions.js";

// "auto"/"system"/"quick_reply" are internal reply-source labels that read
// the same in Arabic and English (developer-facing shorthand, not a
// translated sentence) — only "ai" and "human" have real approved
// terminology, resolved via t() below.
function getSourceLabel(key, t) {
  if (key === "ai") return t("replyMode.ai");
  if (key === "human") return t("roles.agent");
  return { auto: "Auto", system: "System", quick_reply: "Quick" }[key] || key;
}

// Reply-source order/keys are the product's real set — see AutoResponder_*
// n8n `state_payload` (ai | auto | human | quick_reply | system). Not
// invented, not derived from conversation_state.
const SOURCE_KEYS = ["ai", "auto", "human", "quick_reply", "system"];

const SOURCE_COLORS = {
  ai: "bg-violet-50 text-violet-700 border-violet-100",
  auto: "bg-emerald-50 text-emerald-700 border-emerald-100",
  system: "bg-slate-50 text-slate-700 border-slate-100",
  quick_reply: "bg-blue-50 text-blue-700 border-blue-100",
  human: "bg-amber-50 text-amber-700 border-amber-100",
};

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

function UsageBar({ label, used, limit }) {
  const { t } = useTranslation();
  if (limit === null || limit === undefined) {
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-500">
          <span>{label}</span>
          <span>{t("common.unlimited")}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full w-full rounded-full bg-slate-200" />
        </div>
      </div>
    );
  }

  const percent = limit > 0 ? Math.min(100, Math.round(((used || 0) / limit) * 100)) : 0;
  const barColor = percent >= 100 ? "bg-rose-500" : percent >= 80 ? "bg-amber-500" : "bg-indigo-600";

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-500">
        <span>{label}</span>
        <span>{used || 0} / {limit}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function StatCard({ title, value, subtitle, icon: Icon, tone = "violet" }) {
  const toneClass = {
    violet: "bg-violet-50 text-violet-700 border-violet-100",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
    rose: "bg-rose-50 text-rose-700 border-rose-100",
  }[tone];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p className="mt-2 text-3xl font-black tracking-tight text-slate-950">{value}</p>
          <p className="mt-2 text-xs font-medium text-slate-400">{subtitle}</p>
        </div>
        <div className={`rounded-2xl border p-3 ${toneClass}`}>
          <Icon className="h-6 w-6" />
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, subtitle, action, children }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-950">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs font-medium text-slate-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
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

      const [clientRes, summaryResult, leadsRes, integrationsRes, subStatusRes] =
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
            .from("client_feature_integrations")
            .select("id, is_active, config, features(slug, name)")
            .eq("client_id", realClientId),
          supabase
            .from("client_subscription_status")
            .select("*")
            .eq("client_id", realClientId)
            .maybeSingle(),
        ]);

      if (clientRes.error) throw clientRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (integrationsRes.error) console.warn("integrations error", integrationsRes.error);
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
      setIntegrations(integrationsRes.data || []);
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

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-slate-950">{t("dashboard.greeting", { name: displayName })}</h1>
          <p className="mt-1 text-sm font-medium text-slate-500">{t("dashboard.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={loadDashboard}
          disabled={refreshing || !realClientId}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
        >
          <ArrowPathIcon className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {t("common.refresh")}
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>
      )}

      {/* 1. Conversations */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title={t("dashboard.openConversationsTitle")} value={loading ? "..." : dashboard.openConversations} subtitle={t("dashboard.openConversationsSubtitle")} icon={ChatBubbleLeftRightIcon} tone="violet" />
        <StatCard title={t("common.waitingHuman")} value={loading ? "..." : dashboard.waitingHuman} subtitle={t("dashboard.waitingHumanSubtitle")} icon={ClockIcon} tone="amber" />
        <StatCard title={t("navigation.leads")} value={loading ? "..." : leadsCount} subtitle={t("dashboard.leadsSubtitle")} icon={UserPlusIcon} tone="emerald" />
        <StatCard title={t("dashboard.channelsTitle")} value={loading ? "..." : dashboard.connectedIntegrations} subtitle={t("dashboard.channelsSubtitle")} icon={UserGroupIcon} tone="blue" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SectionCard
            title={t("dashboard.recentConversationsTitle")}
            subtitle={t("dashboard.recentConversationsSubtitle")}
            action={
              <Link to="/client/messages" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50">
                {t("dashboard.openConversationsLink")}
              </Link>
            }
          >
            {recentConversations.length === 0 ? (
              <div className="flex min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-semibold text-slate-400">
                {t("dashboard.noConversations")}
              </div>
            ) : (
              <div className="space-y-3">
                {recentConversations.map((conversation) => (
                  <div key={conversation.id} className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 transition hover:border-violet-200 hover:bg-white">
                    <ChannelIcon channel={conversation.channel} size="h-11 w-11" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-black text-slate-950">{conversation.sender || t("common.noName")}</p>
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">{conversation.status || "active"}</span>
                      </div>
                      <p className="mt-1 truncate text-sm font-medium text-slate-500">{conversation.lastMessage || t("dashboard.noMessage")}</p>
                    </div>
                    <div className="text-end">
                      <p className="text-xs font-bold text-slate-400">{relativeTime(conversation.updatedAt, t)}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">{t("dashboard.messageCount", { count: conversation.count })}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* 2. Messages / Automation */}
        <SectionCard title={t("dashboard.automationTitle")} subtitle={t("dashboard.automationSubtitle")}>
          <div className="space-y-4">
            {dashboard.sourceStats.map((source) => (
              <div key={source.key}>
                <div className="mb-2 flex items-center justify-between">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${SOURCE_COLORS[source.key]}`}>{getSourceLabel(source.key, t)}</span>
                  <span className="text-sm font-black text-slate-950">{source.value}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-violet-600" style={{ width: `${source.percentage}%` }} />
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      {/* 5/6/7. Plan, Subscription, Usage */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <SectionCard title={t("common.currentPlan")} subtitle={null}>
          {plan ? (
            <div>
              <p className="text-2xl font-black text-slate-950">{plan.name}</p>
              {plan.description && <p className="mt-2 text-sm text-slate-500">{plan.description}</p>}
              {plan.price != null && (
                <p className="mt-3 inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">{plan.price}</p>
              )}
            </div>
          ) : (
            <div className="flex min-h-[100px] items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-semibold text-slate-400">
              {t("dashboard.noPlan")}
            </div>
          )}
        </SectionCard>

        <SectionCard title={t("common.subscriptionDetails")} subtitle={null}>
          {subscription ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t("common.type")}</span>
                <span className="font-bold text-slate-900">{subscription.subscription_type === "trial" ? t("common.trial") : t("common.paid")}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t("common.status")}</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${subscriptionStatus?.is_active ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                  {getSubscriptionStatusLabel(subscription.status, t)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t("featureSettingsPage.startDateLabel")}</span>
                <span className="font-semibold text-slate-700">{formatDate(subscription.start_date, i18n.language)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t("featureSettingsPage.endDateLabel")}</span>
                <span className="font-semibold text-slate-700">{formatDate(subscription.end_date, i18n.language)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-slate-500">{t("common.daysRemaining")}</span>
                <span className={`font-black ${daysRemaining !== null && daysRemaining < 0 ? "text-rose-600" : "text-indigo-600"}`}>
                  {daysRemaining === null ? "—" : daysRemaining < 0 ? t("common.expired") : t("featureSettingsPage.remainingDaysValue", { days: daysRemaining })}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[100px] items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-semibold text-slate-400">
              {t("dashboard.noSubscription")}
            </div>
          )}
        </SectionCard>

        <SectionCard title={t("common.usage")} subtitle={null}>
          {subscription && plan ? (
            <div className="space-y-4">
              {/* Messages Usage = actual public.messages rows counted
                  server-side over the CURRENT subscription billing period
                  ([start_date .. min(end_date, now)]); limit is that
                  period's plan.messages_limit (null => unlimited). Not the
                  stale subscriptions.messages_used counter. */}
              <UsageBar
                label={t("common.messagesLabel")}
                used={messagesUsage?.used ?? subscription.messages_used ?? 0}
                limit={messagesUsage?.plan_known ? messagesUsage.limit : (plan.messages_limit ?? null)}
              />
              <UsageBar label={t("dashboard.usageAiReplies")} used={subscription.ai_replies_used} limit={plan.ai_replies_limit} />
              <UsageBar label={t("dashboard.usageAutoReplies")} used={subscription.auto_replies_used} limit={plan.auto_replies_limit} />
            </div>
          ) : (
            <div className="flex min-h-[100px] items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-semibold text-slate-400">
              {t("dashboard.usageUnavailable")}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SectionCard title={t("dashboard.messageActivityTitle")} subtitle={t("dashboard.messageActivitySubtitle")}>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dashboard.chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="inboundGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="outboundGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Area type="monotone" dataKey="inbound" stroke="#4f46e5" strokeWidth={3} fill="url(#inboundGradient)" name={t("dashboard.chartInbound")} />
                  <Area type="monotone" dataKey="outbound" stroke="#10b981" strokeWidth={3} fill="url(#outboundGradient)" name={t("dashboard.chartOutbound")} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </SectionCard>
        </div>

        <div className="space-y-5">
          {/* 4. Integrations */}
          <SectionCard
            title={t("navigation.integrations")}
            subtitle={t("dashboard.integrationsSubtitle")}
            action={<Link to="/client/integrations" className="text-xs font-black text-violet-700">{t("dashboard.manage")}</Link>}
          >
            <div className="space-y-3">
              {integrations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-center text-sm font-semibold text-slate-400">{t("dashboard.noChannels")}</div>
              ) : (
                integrations.slice(0, 5).map((item) => {
                  const slug = item.features?.slug || item.config?.platform || "integration";
                  return (
                    <div key={item.id} className="flex items-center justify-between rounded-2xl border border-slate-200 p-3">
                      <div className="flex items-center gap-3">
                        <ChannelIcon channel={slug} size="h-10 w-10" />
                        <div>
                          <p className="text-sm font-black text-slate-900">{item.features?.name || slug}</p>
                          <p className="text-xs font-semibold text-slate-400">{item.is_active ? t("common.active") : t("common.inactive")}</p>
                        </div>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${item.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {item.is_active ? t("common.active") : t("common.inactive")}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </SectionCard>

          <SectionCard title={t("dashboard.quickActionsTitle")} subtitle={null}>
            <div className="grid grid-cols-2 gap-3">
              {hasUserPermission(user, PERMISSIONS.INBOX) && (
                <Link to="/client/messages" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <InboxIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">{t("dashboard.openConversationsLink")}</p>
                </Link>
              )}
              {hasUserPermission(user, PERMISSIONS.AUTO_REPLIES) && (
                <Link to="/client/auto-replies" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <PlusIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">{t("navigation.autoReplies")}</p>
                </Link>
              )}
              {hasUserPermission(user, PERMISSIONS.AUTO_REPLIES) && (
                <Link to="/client/quick-replies" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <CheckCircleIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">{t("navigation.quickReplies")}</p>
                </Link>
              )}
              {hasUserPermission(user, PERMISSIONS.SETTINGS) && (
                <Link to="/client/settings" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <Cog6ToothIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">{t("navigation.settings")}</p>
                </Link>
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
