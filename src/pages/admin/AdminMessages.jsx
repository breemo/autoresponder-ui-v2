import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const channelStyle = {
  telegram: "bg-sky-50 text-sky-700 border-sky-100",
  whatsapp: "bg-emerald-50 text-emerald-700 border-emerald-100",
  facebook: "bg-blue-50 text-blue-700 border-blue-100",
  instagram: "bg-pink-50 text-pink-700 border-pink-100",
};

const statusStyles = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-100",
  open: "bg-emerald-50 text-emerald-700 border-emerald-100",
  closed: "bg-slate-100 text-slate-600 border-slate-200",
  lead_captured: "bg-indigo-50 text-indigo-700 border-indigo-100",
  waiting_human: "bg-amber-50 text-amber-700 border-amber-100",
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
  const clean = String(value || "U").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] || ""}${parts[1]?.[0] || ""}`.toUpperCase();
}

function normalizeDirection(direction) {
  if (["in", "inbound"].includes(direction)) return "inbound";
  if (["out", "outbound"].includes(direction)) return "outbound";
  return direction || "unknown";
}

function directionLabel(direction) {
  const normalized = normalizeDirection(direction);
  if (normalized === "inbound") return "واردة";
  if (normalized === "outbound") return "صادرة";
  return normalized;
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
  const [selectedConversationKey, setSelectedConversationKey] = useState(null);
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
      let query = supabase
        .from("messages")
        .select("id, client_id, conversation_id, sender, message, channel, direction, created_at, is_read, clients:client_id(business_name,email)")
        .order("created_at", { ascending: false })
        .limit(500);

      if (clientFilter !== "all") query = query.eq("client_id", clientFilter);
      if (channelFilter !== "all") query = query.ilike("channel", channelFilter);
      if (directionFilter !== "all") query = query.eq("direction", directionFilter);

      const { data, error } = await query;
      if (error) throw error;

      const normalized = (data || []).map((msg) => ({
        ...msg,
        channel: (msg.channel || "unknown").toLowerCase(),
        direction: normalizeDirection(msg.direction),
        conversation_key: msg.conversation_id || `${msg.client_id || "no-client"}:${msg.channel || "unknown"}:${msg.sender || "unknown"}`,
      }));

      setMessages(normalized);
      setSelectedConversationKey((current) => current && normalized.some((m) => m.conversation_key === current) ? current : normalized[0]?.conversation_key || null);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في تحميل الرسائل");
    } finally {
      setLoading(false);
    }
  }

  const filteredMessages = useMemo(() => {
    const q = search.trim().toLowerCase();
    return messages.filter((m) => {
      const haystack = `${m.sender || ""} ${m.message || ""} ${m.clients?.business_name || ""} ${m.clients?.email || ""} ${m.conversation_id || ""}`.toLowerCase();
      return !q || haystack.includes(q);
    });
  }, [messages, search]);

  const conversations = useMemo(() => {
    const map = new Map();
    for (const msg of filteredMessages) {
      const key = msg.conversation_key;
      if (!map.has(key)) {
        map.set(key, {
          key,
          conversation_id: msg.conversation_id,
          client_id: msg.client_id,
          sender: msg.sender,
          clientName: msg.clients?.business_name,
          clientEmail: msg.clients?.email,
          channel: msg.channel,
          last_message: msg.message,
          last_message_at: msg.created_at,
          messages: [],
          inbound: 0,
          outbound: 0,
          unread: 0,
        });
      }
      const conv = map.get(key);
      conv.messages.push(msg);
      if (msg.created_at && new Date(msg.created_at) > new Date(conv.last_message_at || 0)) {
        conv.last_message = msg.message;
        conv.last_message_at = msg.created_at;
      }
      if (msg.direction === "inbound") conv.inbound += 1;
      if (msg.direction === "outbound") conv.outbound += 1;
      if (msg.is_read === false) conv.unread += 1;
    }

    return Array.from(map.values())
      .map((conv) => ({ ...conv, messages: conv.messages.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)) }))
      .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
  }, [filteredMessages]);

  useEffect(() => {
    if (conversations.length === 0) {
      setSelectedConversationKey(null);
      return;
    }
    if (!conversations.some((c) => c.key === selectedConversationKey)) {
      setSelectedConversationKey(conversations[0].key);
    }
  }, [conversations, selectedConversationKey]);

  const selectedConversation = conversations.find((c) => c.key === selectedConversationKey) || null;
  const inbound = messages.filter((m) => m.direction === "inbound").length;
  const outbound = messages.filter((m) => m.direction === "outbound").length;
  const unread = messages.filter((m) => m.is_read === false).length;

  return (
    <div className="space-y-5" dir="ltr">
      <div className="flex items-center justify-end">
        <button onClick={loadMessages} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">↻ تحديث</button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Conversations" value={conversations.length} hint="مجمعة حسب conversation_id" icon="💬" />
        <StatCard label="Inbound" value={inbound} hint="رسائل واردة" tone="sky" icon="↓" />
        <StatCard label="Outbound" value={outbound} hint="ردود صادرة" tone="emerald" icon="↑" />
        <StatCard label="Unread" value={unread} hint="غير مقروءة" tone="amber" icon="•" />
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[1.5fr_1fr_0.8fr_0.8fr_auto]">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث في الرسائل، المرسل، العميل، أو رقم المحادثة..." className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-50" />
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50">
            <option value="all">كل العملاء</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.business_name} ({c.email})</option>)}
          </select>
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50">
            <option value="all">كل القنوات</option><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option>
          </select>
          <select value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value)} className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50">
            <option value="all">واردة وصادرة</option><option value="inbound">واردة</option><option value="outbound">صادرة</option>
          </select>
          <button onClick={loadMessages} className="h-12 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700">تطبيق</button>
        </div>
      </div>

      <div className="grid min-h-[680px] grid-cols-1 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm xl:grid-cols-[420px_1fr]" dir="rtl">
        <aside className="border-l border-slate-100 bg-slate-50/40">
          <div className="border-b border-slate-100 p-5">
            <h2 className="font-bold text-slate-950">قائمة المحادثات</h2>
            <p className="mt-1 text-sm text-slate-500">{conversations.length} محادثة ظاهرة</p>
          </div>
          <div className="max-h-[610px] overflow-y-auto p-3">
            {loading ? <div className="p-8 text-center text-slate-500">جاري التحميل...</div> : conversations.length === 0 ? <div className="p-8 text-center text-slate-400">لا توجد محادثات مطابقة.</div> : conversations.map((conv) => (
              <button key={conv.key} onClick={() => setSelectedConversationKey(conv.key)} className={`mb-2 flex w-full items-start gap-3 rounded-2xl border p-3 text-right transition ${selectedConversationKey === conv.key ? "border-indigo-200 bg-white shadow-sm ring-4 ring-indigo-50" : "border-transparent hover:bg-white"}`}>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-xs font-bold text-white">{initials(conv.clientName || conv.sender)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-slate-900">{conv.clientName || conv.sender || "Unknown"}</p>
                    <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(conv.last_message_at)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{conv.last_message || "—"}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${channelStyle[conv.channel] || "border-slate-100 bg-slate-50 text-slate-500"}`}>{conv.channel}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{conv.messages.length} رسائل</span>
                    {conv.conversation_id && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">ID</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-[680px] flex-col">
          {selectedConversation ? (
            <>
              <div className="flex items-center justify-between border-b border-slate-100 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 font-bold text-indigo-600">{initials(selectedConversation.clientName || selectedConversation.sender)}</div>
                  <div>
                    <h2 className="font-bold text-slate-950">{selectedConversation.clientName || selectedConversation.sender || "Unknown"}</h2>
                    <p className="text-sm text-slate-500">{selectedConversation.clientEmail || selectedConversation.sender || "بدون بريد"}</p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">{formatDate(selectedConversation.last_message_at)}</span>
                  {selectedConversation.conversation_id && <span className="max-w-[320px] truncate rounded-xl bg-indigo-50 px-3 py-1 font-mono text-[11px] font-bold text-indigo-600">{selectedConversation.conversation_id}</span>}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto bg-gradient-to-b from-white to-slate-50 p-6">
                <div className="space-y-4">
                  {selectedConversation.messages.map((msg) => {
                    const isInbound = msg.direction === "inbound";
                    return (
                      <div key={msg.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
                        <div className={`max-w-[78%] rounded-3xl px-5 py-3 shadow-sm ${isInbound ? "rounded-tr-lg border border-slate-200 bg-white text-slate-800" : "rounded-tl-lg bg-indigo-600 text-white"}`}>
                          <div className="mb-2 flex items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isInbound ? "bg-slate-100 text-slate-500" : "bg-white/15 text-white"}`}>{directionLabel(msg.direction)}</span>
                            <span className={`text-[11px] ${isInbound ? "text-slate-400" : "text-indigo-100"}`}>{formatDate(msg.created_at)}</span>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm leading-7">{msg.message || "—"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : <div className="flex flex-1 items-center justify-center text-slate-400">اختر محادثة من القائمة</div>}
        </section>
      </div>
    </div>
  );
}
