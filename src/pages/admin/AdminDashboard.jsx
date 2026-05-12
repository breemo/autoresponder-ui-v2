import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth } from "../../context/AuthContext.jsx";
import { supabase } from "../../lib/supabaseClient";

const platformColors = {
  telegram: "bg-sky-50 text-sky-600 border-sky-100",
  whatsapp: "bg-emerald-50 text-emerald-600 border-emerald-100",
  instagram: "bg-pink-50 text-pink-600 border-pink-100",
  facebook: "bg-blue-50 text-blue-600 border-blue-100",
};

const iconMap = {
  telegram: "✈️",
  whatsapp: "☘",
  instagram: "◎",
  facebook: "f",
};

function StatCard({ title, value, subtitle, tone = "indigo", icon = "•", trend = "+0%" }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600 border-indigo-100",
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    sky: "bg-sky-50 text-sky-600 border-sky-100",
    rose: "bg-rose-50 text-rose-600 border-rose-100",
  };
  const positive = !String(trend).startsWith("-");

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl border text-xl ${tones[tone]}`}>{icon}</div>
        <span className={`rounded-full px-2 py-1 text-xs font-bold ${positive ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}>{trend}</span>
      </div>
      <p className="mt-5 text-sm font-medium text-slate-500">{title}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
      <div className="mt-4 h-8 overflow-hidden">
        <svg viewBox="0 0 160 32" className="h-full w-full">
          <path d="M0 24 C18 22, 25 21, 38 22 C48 23, 55 10, 70 15 C88 21, 92 13, 106 18 C124 24, 128 8, 160 10" fill="none" stroke="currentColor" strokeWidth="2" className={positive ? "text-indigo-500" : "text-rose-500"} />
        </svg>
      </div>
    </div>
  );
}

function EmptyBox({ children }) {
  return <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center text-sm text-slate-400">{children}</div>;
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stats, setStats] = useState({ clients: [], messages: [], plansCount: 0, autoRepliesCount: 0, integrations: [] });

  useEffect(() => { fetchStats(); }, []);

  async function fetchStats() {
    setLoading(true);
    setError("");
    try {
      const [{ data: clients, error: clientsError }, { data: messages, error: messagesError }, plansRes, autoRes, integrationsRes] = await Promise.all([
        supabase.from("clients").select("id, business_name, email, is_active, created_at").order("created_at", { ascending: false }),
        supabase.from("messages").select("id, client_id, sender, message, channel, platform, direction, created_at").order("created_at", { ascending: false }).limit(300),
        supabase.from("plans").select("*", { count: "exact", head: true }),
        supabase.from("auto_replies").select("*", { count: "exact", head: true }),
        supabase.from("client_feature_integrations").select("id, is_active, features:feature_id(slug, name)").limit(100),
      ]);
      if (clientsError) throw clientsError;
      if (messagesError) throw messagesError;
      setStats({
        clients: clients || [],
        messages: messages || [],
        plansCount: plansRes.count || 0,
        autoRepliesCount: autoRes.count || 0,
        integrations: integrationsRes.data || [],
      });
    } catch (err) {
      console.error(err);
      setError(err.message || "حدث خطأ أثناء جلب البيانات");
    } finally {
      setLoading(false);
    }
  }

  const chartData = useMemo(() => {
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const base = Math.max(stats.messages.length, 8);
    return labels.map((day, i) => ({ day, received: Math.round(base * (0.45 + Math.sin(i + 1) * 0.12 + i * 0.06)), replied: Math.round(base * (0.35 + Math.sin(i + 0.5) * 0.1 + i * 0.05)) }));
  }, [stats.messages.length]);

  const platformData = useMemo(() => {
    const map = {};
    stats.messages.forEach((m) => {
      const key = (m.channel || m.platform || "unknown").toLowerCase();
      map[key] = (map[key] || 0) + 1;
    });
    const fallback = stats.messages.length ? [] : [
      { name: "Telegram", value: 42 },
      { name: "WhatsApp", value: 31 },
      { name: "Instagram", value: 20 },
      { name: "Facebook", value: 14 },
    ];
    return Object.keys(map).length ? Object.entries(map).map(([name, value]) => ({ name, value })) : fallback;
  }, [stats.messages]);

  const activeClients = stats.clients.filter((c) => c.is_active).length;
  const responseRate = stats.messages.length ? Math.round((stats.messages.filter((m) => m.direction === "out" || m.direction === "outbound").length / stats.messages.length) * 100) : 0;
  const activeIntegrations = stats.integrations.filter((i) => i.is_active !== false).slice(0, 4);

  return (
    <div className="space-y-6" dir="ltr">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">Welcome back, {user?.name || "Admin"}. Here's what's happening with your AI agents.</p>
        </div>
        <button onClick={fetchStats} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">↻ Refresh</button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      {loading ? <EmptyBox>جارِ تحميل بيانات الداشبورد...</EmptyBox> : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatCard title="Total Messages" value={stats.messages.length.toLocaleString()} subtitle="All system messages" icon="▱" trend="+12.5%" />
            <StatCard title="Auto Replies Sent" value={stats.autoRepliesCount.toLocaleString()} subtitle="Configured triggers" tone="sky" icon="⚡" trend="+8.2%" />
            <StatCard title="Active Clients" value={activeClients.toLocaleString()} subtitle="Currently enabled" tone="emerald" icon="👥" trend="+4.1%" />
            <StatCard title="Response Rate" value={`${responseRate}%`} subtitle="Outbound vs total" tone="rose" icon="↗" trend={responseRate ? "+2.3%" : "-0.8%"} />
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.7fr_1fr]">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-950">Message Analytics</h2>
                  <p className="text-xs text-slate-400">Messages received and replied this week</p>
                </div>
                <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">Last 7 Days</span>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="received" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#4f46e5" stopOpacity={0.18}/><stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/></linearGradient>
                      <linearGradient id="replied" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.16}/><stop offset="95%" stopColor="#10b981" stopOpacity={0}/></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="received" stroke="#4f46e5" strokeWidth={2.5} fill="url(#received)" />
                    <Area type="monotone" dataKey="replied" stroke="#10b981" strokeWidth={2.5} fill="url(#replied)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-950">Platform Distribution</h2>
                <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">Live</span>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={platformData} layout="vertical" margin={{ left: 18, right: 20, top: 10, bottom: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} />
                    <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} width={78} tick={{ fill: "#475569", fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#4f46e5" radius={[0, 8, 8, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-bold text-slate-950">Recent Conversations</h2><Link to="/admin/messages" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">View All</Link></div>
              <div className="space-y-2">
                {stats.messages.slice(0, 5).map((m, index) => (
                  <div key={m.id || index} className="flex items-center gap-3 rounded-2xl p-3 hover:bg-slate-50">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-50 text-xs font-bold text-indigo-600">{(m.sender || "U").slice(0, 2).toUpperCase()}</div>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-900">{m.sender || "Unknown Sender"}</p><p className="truncate text-xs text-slate-500">{m.message || "—"}</p></div>
                    <span className="text-xs text-slate-400">{m.channel || m.platform || "—"}</span>
                  </div>
                ))}
                {!stats.messages.length && <EmptyBox>لا توجد رسائل حديثة.</EmptyBox>}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-bold text-slate-950">Active Integrations</h2><Link to="/admin/features" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">View All</Link></div>
              <div className="space-y-3">
                {(activeIntegrations.length ? activeIntegrations : ["telegram", "whatsapp", "instagram", "facebook"]).map((item, index) => {
                  const slug = typeof item === "string" ? item : (item.features?.slug || item.features?.name || "platform").toLowerCase();
                  return <div key={index} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-4"><div className={`flex h-11 w-11 items-center justify-center rounded-2xl border text-lg ${platformColors[slug] || "bg-slate-50 text-slate-600 border-slate-100"}`}>{iconMap[slug] || "•"}</div><div className="flex-1"><p className="font-bold text-slate-900 capitalize">{slug}</p><p className="text-xs text-slate-500">Active & Running</p></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-600">Connected</span></div>;
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
