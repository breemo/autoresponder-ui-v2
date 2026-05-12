import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const channelStyle = {
  telegram: "bg-sky-50 text-sky-700 border-sky-100",
  whatsapp: "bg-emerald-50 text-emerald-700 border-emerald-100",
  facebook: "bg-blue-50 text-blue-700 border-blue-100",
  instagram: "bg-pink-50 text-pink-700 border-pink-100",
};

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" });
}

function relativeTime(value) {
  if (!value) return "-";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `منذ ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  return `منذ ${Math.round(hours / 24)} يوم`;
}

function initials(value = "") {
  return (value || "U").trim().slice(0, 2).toUpperCase();
}

function StatCard({ label, value, hint, icon, tone = "indigo" }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600 border-indigo-100",
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    sky: "bg-sky-50 text-sky-600 border-sky-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
  };
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-3 text-3xl font-bold text-slate-950">{value}</p>
          <p className="mt-2 text-xs text-slate-400">{hint}</p>
        </div>
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl border text-lg ${tones[tone]}`}>{icon}</div>
      </div>
    </div>
  );
}

export default function AdminMessages() {
  const [messages, setMessages] = useState([]);
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");

  useEffect(() => {
    loadClients();
    loadMessages();
  }, []);

  async function loadClients() {
    const { data, error } = await supabase.from("clients").select("id, business_name, email").order("business_name", { ascending: true });
    if (!error) setClients(data || []);
  }

  async function loadMessages() {
    try {
      setLoading(true);
      setError("");
      let query = supabase.from("messages").select("*, clients:client_id(business_name,email)").order("created_at", { ascending: false }).limit(300);
      if (clientFilter !== "all") query = query.eq("client_id", clientFilter);
      if (channelFilter !== "all") query = query.or(`channel.ilike.${channelFilter},platform.ilike.${channelFilter}`);
      if (directionFilter !== "all") query = query.eq("direction", directionFilter);
      const { data, error } = await query;
      if (error) throw error;
      const normalized = (data || []).map((msg) => ({ ...msg, channel: (msg.channel || msg.platform || "unknown").toLowerCase(), direction: msg.direction || "unknown" }));
      setMessages(normalized);
      setSelected(normalized[0] || null);
    } catch (err) {
      console.error(err);
      setError("فشل في تحميل الرسائل");
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return messages.filter((m) => !q || `${m.sender || ""} ${m.message || ""} ${m.clients?.business_name || ""}`.toLowerCase().includes(q));
  }, [messages, search]);

  const inbound = messages.filter((m) => ["in", "inbound"].includes(m.direction)).length;
  const outbound = messages.filter((m) => ["out", "outbound"].includes(m.direction)).length;
  const unread = messages.filter((m) => m.is_read === false).length;

  return (
    <div className="space-y-6" dir="ltr">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-600">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Messages</h1>
          <p className="mt-2 text-sm text-slate-500">إشراف كامل على رسائل جميع العملاء والقنوات.</p>
        </div>
        <button onClick={loadMessages} className="inline-flex h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">↻ تحديث</button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Messages" value={messages.length} hint="كل الرسائل" icon="▱" />
        <StatCard label="Inbound" value={inbound} hint="رسائل واردة" tone="sky" icon="↓" />
        <StatCard label="Outbound" value={outbound} hint="ردود صادرة" tone="emerald" icon="↑" />
        <StatCard label="Unread" value={unread} hint="غير مقروءة" tone="amber" icon="•" />
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[1.5fr_1fr_0.8fr_0.8fr_auto]">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث في الرسائل، المرسل، أو العميل..." className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50" />
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50">
            <option value="all">كل العملاء</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.business_name} ({c.email})</option>)}
          </select>
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50">
            <option value="all">كل القنوات</option><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option>
          </select>
          <select value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value)} className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50">
            <option value="all">واردة وصادرة</option><option value="in">واردة</option><option value="out">صادرة</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option>
          </select>
          <button onClick={loadMessages} className="h-12 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700">تطبيق</button>
        </div>
      </div>

      <div className="grid min-h-[620px] grid-cols-1 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm xl:grid-cols-[420px_1fr]">
        <aside className="border-r border-slate-100 bg-slate-50/40">
          <div className="border-b border-slate-100 p-5"><h2 className="font-bold text-slate-950">قائمة المحادثات</h2><p className="mt-1 text-sm text-slate-500">{filtered.length} رسالة ظاهرة</p></div>
          <div className="max-h-[560px] overflow-y-auto p-3">
            {loading ? <div className="p-8 text-center text-slate-500">جاري التحميل...</div> : filtered.length === 0 ? <div className="p-8 text-center text-slate-400">لا توجد رسائل مطابقة.</div> : filtered.slice(0, 80).map((m) => (
              <button key={m.id} onClick={() => setSelected(m)} className={`mb-2 flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition ${selected?.id === m.id ? "border-indigo-200 bg-white shadow-sm" : "border-transparent hover:bg-white"}`}>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-xs font-bold text-white">{initials(m.clients?.business_name || m.sender)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-bold text-slate-900">{m.clients?.business_name || m.sender || "Unknown"}</p><span className="shrink-0 text-[11px] text-slate-400">{relativeTime(m.created_at)}</span></div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{m.message || "—"}</p>
                  <div className="mt-2 flex items-center gap-2"><span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${channelStyle[m.channel] || "border-slate-100 bg-slate-50 text-slate-500"}`}>{m.channel}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{m.direction}</span></div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-[620px] flex-col">
          {selected ? (
            <>
              <div className="flex items-center justify-between border-b border-slate-100 p-5">
                <div className="flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 font-bold text-indigo-600">{initials(selected.clients?.business_name || selected.sender)}</div><div><h2 className="font-bold text-slate-950">{selected.clients?.business_name || selected.sender || "Unknown"}</h2><p className="text-sm text-slate-500">{selected.clients?.email || "بدون بريد"}</p></div></div>
                <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">{formatDate(selected.created_at)}</span>
              </div>
              <div className="flex-1 bg-gradient-to-b from-white to-slate-50 p-6">
                <div className={`max-w-3xl rounded-3xl p-5 shadow-sm ${["out", "outbound"].includes(selected.direction) ? "ml-auto bg-indigo-600 text-white" : "bg-white text-slate-800 border border-slate-200"}`}>
                  <div className="mb-3 flex items-center gap-2"><span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${["out", "outbound"].includes(selected.direction) ? "border-white/20 bg-white/10 text-white" : "border-slate-100 bg-slate-50 text-slate-600"}`}>{selected.direction}</span><span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${["out", "outbound"].includes(selected.direction) ? "border-white/20 bg-white/10 text-white" : channelStyle[selected.channel] || "border-slate-100 bg-slate-50 text-slate-600"}`}>{selected.channel}</span></div>
                  <p className="whitespace-pre-wrap text-sm leading-7">{selected.message || "—"}</p>
                </div>
              </div>
              <div className="border-t border-slate-100 p-5"><div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">عرض فقط حالياً — لاحقاً نضيف reply / assign / human takeover من نفس الشاشة.</div></div>
            </>
          ) : <div className="flex flex-1 items-center justify-center text-slate-400">اختر رسالة من القائمة</div>}
        </section>
      </div>
    </div>
  );
}
