import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  ChatBubbleLeftRightIcon,
  BoltIcon,
  CpuChipIcon,
  UserPlusIcon,
  ArrowPathIcon,
  SparklesIcon,
  ClockIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
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

const SOURCE_LABELS = {
  ai: "AI",
  auto: "Auto",
  system: "System",
  quick_reply: "Quick",
  human: "Human",
};

const SOURCE_COLORS = {
  ai: "bg-violet-50 text-violet-700 border-violet-100",
  auto: "bg-emerald-50 text-emerald-700 border-emerald-100",
  system: "bg-slate-50 text-slate-700 border-slate-100",
  quick_reply: "bg-blue-50 text-blue-700 border-blue-100",
  human: "bg-amber-50 text-amber-700 border-amber-100",
};

const PLATFORM_STYLES = {
  facebook: "bg-blue-50 text-blue-700 border-blue-100",
  telegram: "bg-sky-50 text-sky-700 border-sky-100",
  whatsapp: "bg-emerald-50 text-emerald-700 border-emerald-100",
  instagram: "bg-pink-50 text-pink-700 border-pink-100",
};

function safeDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("ar-EG", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function relativeTime(value) {
  if (!value) return "-";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return "الآن";
  if (minutes < 60) return `منذ ${minutes} د`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `منذ ${hours} س`;
  const days = Math.round(hours / 24);
  return `منذ ${days} يوم`;
}

function getInitials(name = "") {
  const clean = String(name || "").trim();
  if (!clean) return "--";
  return clean
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

function StatCard({ title, value, subtitle, icon: Icon, tone = "violet", hint }) {
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
          <div className="mt-2 flex items-end gap-2">
            <p className="text-3xl font-black tracking-tight text-slate-950">{value}</p>
            {hint && (
              <span className="mb-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700">
                {hint}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs font-medium text-slate-400">{subtitle}</p>
        </div>
        <div className={`rounded-2xl border p-3 ${toneClass}`}>
          <Icon className="h-6 w-6" />
        </div>
      </div>
    </div>
  );
}

export default function ClientDashboard() {
  const { user } = useAuth();
  // client_id is resolved once at login via client_users (see Login.jsx) —
  // every user of this client (Owner/Agent/IT) shares the same client_id,
  // so they all resolve the same business data below. Previously this page
  // re-derived it by matching clients.email === user.email, which only
  // worked for the original owner account and silently broke for any other
  // team member.
  const realClientId = user?.client_id || null;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([]);
  const [autoRepliesCount, setAutoRepliesCount] = useState(0);
  const [quickRepliesCount, setQuickRepliesCount] = useState(0);
  const [leadsCount, setLeadsCount] = useState(0);
  const [conversationStates, setConversationStates] = useState([]);
  const [integrations, setIntegrations] = useState([]);

  useEffect(() => {
    if (!realClientId) {
      setError("⚠️ لم يتم العثور على حسابك كعميل");
      setLoading(false);
      return;
    }
    loadDashboard();
  }, [realClientId]);

  async function loadDashboard() {
    try {
      setLoading(true);
      setRefreshing(true);
      setError("");

      const [messagesRes, repliesRes, quickRes, leadsRes, statesRes, integrationsRes] =
        await Promise.all([
          supabase
            .from("messages")
            .select("id, message, channel, sender, direction, reply_source, conversation_id, created_at")
            .eq("client_id", realClientId)
            .order("created_at", { ascending: false })
            .limit(500),
          supabase
            .from("auto_replies")
            .select("id, is_active")
            .eq("client_id", realClientId),
          supabase
            .from("quick_reply_templates")
            .select("id, is_active")
            .eq("client_id", realClientId),
          supabase
            .from("leads")
            .select("id", { count: "exact", head: true })
            .eq("client_id", realClientId),
          supabase
            .from("conversation_state")
            .select("conversation_id, sender_id, platform, conversation_status, current_step, updated_at")
            .eq("client_id", realClientId)
            .order("updated_at", { ascending: false })
            .limit(200),
          supabase
            .from("client_feature_integrations")
            .select("id, is_active, config, features(slug, name)")
            .eq("client_id", realClientId),
        ]);

      if (messagesRes.error) throw messagesRes.error;
      if (repliesRes.error) throw repliesRes.error;
      if (quickRes.error) throw quickRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (statesRes.error) console.warn("conversation_state error", statesRes.error);
      if (integrationsRes.error) console.warn("integrations error", integrationsRes.error);

      setMessages(messagesRes.data || []);
      setAutoRepliesCount((repliesRes.data || []).filter((r) => r.is_active).length);
      setQuickRepliesCount((quickRes.data || []).filter((r) => r.is_active).length);
      setLeadsCount(leadsRes.count || 0);
      setConversationStates(statesRes.data || []);
      setIntegrations(integrationsRes.data || []);
    } catch (err) {
      console.error(err);
      setError(err.message || "حدث خطأ أثناء تحميل بيانات الداشبورد");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const dashboard = useMemo(() => {
    const inbound = messages.filter((m) => m.direction === "inbound");
    const outbound = messages.filter((m) => m.direction === "outbound");
    const aiReplies = outbound.filter((m) => m.reply_source === "ai").length;
    const autoReplies = outbound.filter((m) => m.reply_source === "auto").length;
    const systemReplies = outbound.filter((m) => m.reply_source === "system").length;
    const quickReplies = outbound.filter((m) => m.reply_source === "quick_reply").length;
    const humanReplies = outbound.filter((m) => m.reply_source === "human").length;

    const conversationMap = new Map();
    messages.forEach((msg) => {
      const key = msg.conversation_id || `${msg.channel || "unknown"}:${msg.sender || msg.id}`;
      const existing = conversationMap.get(key) || {
        id: key,
        sender: msg.sender || "Unknown",
        channel: msg.channel || "unknown",
        lastMessage: "",
        lastAt: msg.created_at,
        count: 0,
        inbound: 0,
        outbound: 0,
        status: "active",
      };

      existing.count += 1;
      existing.inbound += msg.direction === "inbound" ? 1 : 0;
      existing.outbound += msg.direction === "outbound" ? 1 : 0;

      if (new Date(msg.created_at) >= new Date(existing.lastAt || 0)) {
        existing.lastAt = msg.created_at;
        existing.lastMessage = msg.message || "";
        existing.sender = msg.sender || existing.sender;
        existing.channel = msg.channel || existing.channel;
      }

      conversationMap.set(key, existing);
    });

    const statesByConversation = new Map(
      conversationStates.map((s) => [s.conversation_id, s])
    );

    const conversations = Array.from(conversationMap.values())
      .map((conversation) => {
        const state = statesByConversation.get(conversation.id);
        return {
          ...conversation,
          status: state?.conversation_status || conversation.status,
          step: state?.current_step || null,
          updatedAt: state?.updated_at || conversation.lastAt,
        };
      })
      .sort((a, b) => new Date(b.updatedAt || b.lastAt) - new Date(a.updatedAt || a.lastAt));

    // Derived directly from conversation_state (the real conversation model)
    // rather than from the last-500-messages-derived `conversations` list
    // above, so it isn't skewed by conversations with no recent messages.
    const openConversations = conversationStates.filter(
      (s) => !["closed", "done"].includes(s.conversation_status)
    ).length;

    const days = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString("ar-EG", { weekday: "short" });
      days[key] = { day: key, inbound: 0, outbound: 0 };
    }

    messages.forEach((msg) => {
      const day = new Date(msg.created_at).toLocaleDateString("ar-EG", { weekday: "short" });
      if (!days[day]) return;
      if (msg.direction === "inbound") days[day].inbound += 1;
      if (msg.direction === "outbound") days[day].outbound += 1;
    });

    const sourceTotal = Math.max(outbound.length, 1);
    const sourceStats = [
      { key: "ai", label: "AI replies", value: aiReplies, percentage: Math.round((aiReplies / sourceTotal) * 100) },
      { key: "auto", label: "Auto replies", value: autoReplies, percentage: Math.round((autoReplies / sourceTotal) * 100) },
      { key: "quick_reply", label: "Quick replies", value: quickReplies, percentage: Math.round((quickReplies / sourceTotal) * 100) },
      { key: "human", label: "Human replies", value: humanReplies, percentage: Math.round((humanReplies / sourceTotal) * 100) },
      { key: "system", label: "System replies", value: systemReplies, percentage: Math.round((systemReplies / sourceTotal) * 100) },
    ];

    const connectedIntegrations = integrations.filter((i) => i.is_active).length;

    return {
      inbound,
      outbound,
      totalMessages: messages.length,
      conversations,
      openConversations,
      aiReplies,
      autoReplies,
      systemReplies,
      quickReplies,
      sourceStats,
      chartData: Object.values(days),
      connectedIntegrations,
    };
  }, [messages, conversationStates, integrations]);

  const displayName = user?.business_name || user?.name || user?.email || "عميلنا";
  const topConversations = dashboard.conversations.slice(0, 6);
  const activeIntegrations = integrations.slice(0, 5);

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-slate-950">
            مرحباً {displayName} 👋
          </h1>
          <p className="mt-1 text-sm font-medium text-slate-500">
            مركز تحكم سريع لمراقبة المحادثات، أداء الردود، والربط مع المنصات.
          </p>
        </div>
        <button
          type="button"
          onClick={loadDashboard}
          disabled={refreshing || !realClientId}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
        >
          <ArrowPathIcon className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          تحديث
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="المحادثات المفتوحة"
          value={loading ? "..." : dashboard.openConversations}
          subtitle="تحتاج متابعة أو رد"
          icon={ChatBubbleLeftRightIcon}
          tone="violet"
        />
        <StatCard
          title="Leads Captured"
          value={loading ? "..." : leadsCount}
          subtitle="أرقام وبيانات تم التقاطها"
          icon={UserPlusIcon}
          tone="emerald"
        />
        <StatCard
          title="AI Replies"
          value={loading ? "..." : dashboard.aiReplies}
          subtitle="ردود خرجت من الذكاء الاصطناعي"
          icon={CpuChipIcon}
          tone="blue"
        />
        <StatCard
          title="Active Channels"
          value={loading ? "..." : dashboard.connectedIntegrations}
          subtitle="منصات ربط مفعلة"
          icon={BoltIcon}
          tone="amber"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-slate-950">Live Conversations</h2>
              <p className="text-xs font-medium text-slate-400">آخر المحادثات النشطة بدل جدول آخر الرسائل</p>
            </div>
            <Link
              to="/client/messages"
              className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
            >
              فتح Inbox
            </Link>
          </div>

          {topConversations.length === 0 ? (
            <div className="flex min-h-[280px] items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm font-semibold text-slate-400">
              لا توجد محادثات بعد.
            </div>
          ) : (
            <div className="space-y-3">
              {topConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 transition hover:border-violet-200 hover:bg-white"
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-sm font-black text-white">
                    {getInitials(conversation.sender)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-black text-slate-950">
                        {conversation.sender || "مستخدم"}
                      </p>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${PLATFORM_STYLES[conversation.channel] || "bg-slate-50 text-slate-600 border-slate-100"}`}>
                        {conversation.channel || "unknown"}
                      </span>
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
                        {conversation.status || "active"}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium text-slate-500">
                      {conversation.lastMessage || "لا توجد رسالة"}
                    </p>
                  </div>
                  <div className="text-left">
                    <p className="text-xs font-bold text-slate-400">{relativeTime(conversation.updatedAt)}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      {conversation.count} رسالة
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-5">
            <h2 className="text-lg font-black text-slate-950">AI Performance</h2>
            <p className="text-xs font-medium text-slate-400">توزيع الردود الصادرة حسب المصدر</p>
          </div>
          <div className="space-y-4">
            {dashboard.sourceStats.map((source) => (
              <div key={source.key}>
                <div className="mb-2 flex items-center justify-between">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${SOURCE_COLORS[source.key]}`}>
                    {SOURCE_LABELS[source.key]}
                  </span>
                  <span className="text-sm font-black text-slate-950">{source.value}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-violet-600"
                    style={{ width: `${source.percentage}%` }}
                  />
                </div>
                <p className="mt-1 text-left text-[11px] font-bold text-slate-400">{source.percentage}%</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-black text-slate-950">Message Activity</h2>
              <p className="text-xs font-medium text-slate-400">الوارد والصادر خلال آخر 7 أيام</p>
            </div>
            <span className="rounded-full border border-slate-200 px-3 py-1 text-xs font-bold text-slate-500">
              Last 7 days
            </span>
          </div>
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
                <Area type="monotone" dataKey="inbound" stroke="#4f46e5" strokeWidth={3} fill="url(#inboundGradient)" name="وارد" />
                <Area type="monotone" dataKey="outbound" stroke="#10b981" strokeWidth={3} fill="url(#outboundGradient)" name="صادر" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-black text-slate-950">Active Integrations</h2>
                <p className="text-xs font-medium text-slate-400">حالة القنوات المرتبطة</p>
              </div>
              <Link to="/client/integrations" className="text-xs font-black text-violet-700">
                إدارة
              </Link>
            </div>
            <div className="space-y-3">
              {activeIntegrations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-center text-sm font-semibold text-slate-400">
                  لا توجد قنوات مفعلة بعد.
                </div>
              ) : (
                activeIntegrations.map((item) => {
                  const slug = item.features?.slug || item.config?.platform || "integration";
                  return (
                    <div key={item.id} className="flex items-center justify-between rounded-2xl border border-slate-200 p-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-700">
                          <SparklesIcon className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="text-sm font-black text-slate-900">{item.features?.name || slug}</p>
                          <p className="text-xs font-semibold text-slate-400">{item.is_active ? "Active & running" : "Disabled"}</p>
                        </div>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${item.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {item.is_active ? "Connected" : "Off"}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-black text-slate-950">Quick Actions</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {hasUserPermission(user, PERMISSIONS.INBOX) && (
                <Link to="/client/messages" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <InboxIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">فتح Inbox</p>
                </Link>
              )}
              {hasUserPermission(user, PERMISSIONS.AUTO_REPLIES) && (
                <Link to="/client/auto-replies" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <PlusIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">Auto Reply</p>
                </Link>
              )}
              {hasUserPermission(user, PERMISSIONS.AUTO_REPLIES) && (
                <Link to="/client/quick-replies" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <CheckCircleIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">Quick Replies</p>
                </Link>
              )}
              {hasUserPermission(user, PERMISSIONS.SETTINGS) && (
                <Link to="/client/settings" className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:bg-violet-50/40">
                  <Cog6ToothIcon className="mb-3 h-5 w-5 text-violet-700" />
                  <p className="text-sm font-black text-slate-900">Settings</p>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
