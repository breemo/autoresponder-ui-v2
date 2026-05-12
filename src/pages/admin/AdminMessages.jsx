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
  if (!value) return "—";
  return new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" });
}

function relativeTime(value) {
  if (!value) return "—";
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
  const value = String(direction || "").toLowerCase();
  if (["in", "incoming", "inbound", "received"].includes(value)) return "inbound";
  if (["out", "outgoing", "outbound", "sent"].includes(value)) return "outbound";
  return value || "unknown";
}

function directionLabel(direction) {
  const normalized = normalizeDirection(direction);
  if (normalized === "inbound") return "واردة";
  if (normalized === "outbound") return "صادرة";
  return normalized || "—";
}

function getMessageText(msg = {}) {
  return (
    msg.message ??
    msg.text ??
    msg.body ??
    msg.content ??
    msg.reply_text ??
    msg.reply ??
    msg.response ??
    msg.answer ??
    ""
  );
}

function leadName(lead) {
  return lead?.name || lead?.lead_name || lead?.full_name || null;
}

function leadPhone(lead) {
  return lead?.phone || lead?.lead_phone || lead?.mobile || null;
}

function conversationKeyFromMessage(msg) {
  if (msg.conversation_id) return `conv:${msg.conversation_id}`;
  return `fallback:${msg.client_id || "no-client"}:${(msg.channel || msg.platform || "unknown").toLowerCase()}:${msg.sender || msg.sender_id || "unknown"}`;
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
  const [clients, setClients] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [conversationMessages, setConversationMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const selected = conversations.find((c) => c.key === selectedKey) || conversations[0] || null;
    if (!selected) {
      setSelectedKey(null);
      setConversationMessages([]);
      return;
    }
    if (selected.key !== selectedKey) setSelectedKey(selected.key);
    loadConversationMessages(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, conversations]);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const [clientsRes, statesRes, messagesRes, leadsRes] = await Promise.all([
        supabase.from("clients").select("id, business_name, email").order("business_name", { ascending: true }),
        supabase.from("conversation_state").select("*").order("updated_at", { ascending: false }).limit(1000),
        supabase
          .from("messages")
          .select("*, clients:client_id(business_name,email)")
          .order("created_at", { ascending: false })
          .limit(2000),
        supabase.from("leads").select("*").order("created_at", { ascending: false }).limit(1000),
      ]);

      if (clientsRes.error) throw clientsRes.error;
      if (statesRes.error) throw statesRes.error;
      if (messagesRes.error) throw messagesRes.error;
      if (leadsRes.error) throw leadsRes.error;

      const clientRows = clientsRes.data || [];
      const stateRows = statesRes.data || [];
      const messageRows = (messagesRes.data || []).map((m) => ({
        ...m,
        channel: (m.channel || m.platform || "unknown").toLowerCase(),
        direction: normalizeDirection(m.direction || m.channel_direction),
        message_text: getMessageText(m),
      }));
      const leadRows = leadsRes.data || [];

      setClients(clientRows);

      const clientMap = new Map(clientRows.map((c) => [c.id, c]));
      const leadMap = new Map();
      for (const lead of leadRows) {
        const key = `${lead.client_id || ""}:${lead.conversation_id || ""}`;
        if (lead.conversation_id && !leadMap.has(key)) leadMap.set(key, lead);
      }

      const convMap = new Map();

      for (const state of stateRows) {
        if (!state.conversation_id) continue;
        const client = clientMap.get(state.client_id);
        const lead = leadMap.get(`${state.client_id}:${state.conversation_id}`);
        const key = `conv:${state.conversation_id}`;
        convMap.set(key, {
          key,
          isFallback: false,
          conversation_id: state.conversation_id,
          client_id: state.client_id,
          clientName: client?.business_name || "Unknown client",
          clientEmail: client?.email || "",
          sender: leadName(lead) || state.sender_id || "",
          sender_id: state.sender_id || "",
          channel: (state.platform || "unknown").toLowerCase(),
          conversation_status: state.conversation_status || "active",
          updated_at: state.updated_at,
          last_message: "",
          last_message_at: state.updated_at,
          messages_count: 0,
          inbound: 0,
          outbound: 0,
          unread: 0,
          lead,
        });
      }

      for (const msg of messageRows) {
        const key = conversationKeyFromMessage(msg);
        const client = msg.clients || clientMap.get(msg.client_id) || {};
        const lead = msg.conversation_id ? leadMap.get(`${msg.client_id}:${msg.conversation_id}`) : null;

        if (!convMap.has(key)) {
          convMap.set(key, {
            key,
            isFallback: !msg.conversation_id,
            conversation_id: msg.conversation_id || null,
            client_id: msg.client_id,
            clientName: client.business_name || "Unknown client",
            clientEmail: client.email || "",
            sender: leadName(lead) || msg.sender || msg.sender_id || "",
            sender_id: msg.sender || msg.sender_id || "",
            channel: msg.channel || "unknown",
            conversation_status: "active",
            updated_at: msg.created_at,
            last_message: msg.message_text,
            last_message_at: msg.created_at,
            messages_count: 0,
            inbound: 0,
            outbound: 0,
            unread: 0,
            lead,
          });
        }

        const conv = convMap.get(key);
        conv.messages_count += 1;
        if (msg.direction === "inbound") conv.inbound += 1;
        if (msg.direction === "outbound") conv.outbound += 1;
        if (msg.is_read === false) conv.unread += 1;
        if (!conv.channel || conv.channel === "unknown") conv.channel = msg.channel || "unknown";
        if (!conv.sender) conv.sender = leadName(lead) || msg.sender || msg.sender_id || "";
        if (!conv.lead && lead) conv.lead = lead;
        if (msg.created_at && new Date(msg.created_at) >= new Date(conv.last_message_at || 0)) {
          conv.last_message = msg.message_text;
          conv.last_message_at = msg.created_at;
          conv.updated_at = msg.created_at;
        }
      }

      const merged = Array.from(convMap.values())
        .filter((c) => c.messages_count > 0 || c.conversation_id)
        .sort((a, b) => new Date(b.last_message_at || b.updated_at || 0) - new Date(a.last_message_at || a.updated_at || 0));

      setConversations(merged);
      setSelectedKey((current) => (current && merged.some((c) => c.key === current) ? current : merged[0]?.key || null));
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في تحميل المحادثات");
    } finally {
      setLoading(false);
    }
  }

  async function loadConversationMessages(conversation) {
    if (!conversation) return;
    try {
      setLoadingMessages(true);
      setError("");

      let query = supabase.from("messages").select("*").order("created_at", { ascending: true });

      if (conversation.conversation_id) {
        query = query.eq("conversation_id", conversation.conversation_id);
      } else {
        query = query.eq("client_id", conversation.client_id);
        if (conversation.channel && conversation.channel !== "unknown") query = query.eq("channel", conversation.channel);
        if (conversation.sender_id) query = query.eq("sender", conversation.sender_id);
      }

      const { data, error } = await query;
      if (error) throw error;

      const normalized = (data || []).map((m) => ({
        ...m,
        channel: (m.channel || m.platform || conversation.channel || "unknown").toLowerCase(),
        direction: normalizeDirection(m.direction || m.channel_direction),
        message_text: getMessageText(m),
      }));

      setConversationMessages(normalized);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في تحميل رسائل المحادثة");
    } finally {
      setLoadingMessages(false);
    }
  }

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (clientFilter !== "all" && c.client_id !== clientFilter) return false;
      if (channelFilter !== "all" && (c.channel || "").toLowerCase() !== channelFilter) return false;
      if (directionFilter === "inbound" && c.inbound === 0) return false;
      if (directionFilter === "outbound" && c.outbound === 0) return false;

      const haystack = `${c.clientName || ""} ${c.clientEmail || ""} ${c.sender || ""} ${c.sender_id || ""} ${c.last_message || ""} ${c.conversation_id || ""}`.toLowerCase();
      return !q || haystack.includes(q);
    });
  }, [conversations, search, clientFilter, channelFilter, directionFilter]);

  const selectedConversation = filteredConversations.find((c) => c.key === selectedKey) || filteredConversations[0] || null;
  const totalMessages = conversations.reduce((sum, c) => sum + c.messages_count, 0);
  const inbound = conversations.reduce((sum, c) => sum + c.inbound, 0);
  const outbound = conversations.reduce((sum, c) => sum + c.outbound, 0);
  const unread = conversations.reduce((sum, c) => sum + c.unread, 0);

  return (
    <div className="space-y-5" dir="ltr">
      <div className="flex items-center justify-end">
        <button onClick={loadData} className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50">↻ تحديث</button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Conversations" value={conversations.length} hint="محادثات مجمعة" icon="💬" />
        <StatCard label="Inbound" value={inbound} hint="رسائل واردة" tone="sky" icon="↓" />
        <StatCard label="Outbound" value={outbound} hint="ردود صادرة" tone="emerald" icon="↑" />
        <StatCard label="Unread" value={unread || totalMessages} hint="غير مقروءة" tone="amber" icon="•" />
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
            <option value="all">واردة وصادرة</option><option value="inbound">فيها وارد</option><option value="outbound">فيها صادر</option>
          </select>
          <button onClick={loadData} className="h-12 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700">تطبيق</button>
        </div>
      </div>

      <div className="grid min-h-[700px] grid-cols-1 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm xl:grid-cols-[420px_1fr]" dir="rtl">
        <aside className="border-l border-slate-100 bg-slate-50/40">
          <div className="border-b border-slate-100 p-5">
            <h2 className="font-bold text-slate-950">قائمة المحادثات</h2>
            <p className="mt-1 text-sm text-slate-500">{filteredConversations.length} محادثة ظاهرة</p>
          </div>
          <div className="max-h-[630px] overflow-y-auto p-3">
            {loading ? <div className="p-8 text-center text-slate-500">جاري التحميل...</div> : filteredConversations.length === 0 ? <div className="p-8 text-center text-slate-400">لا توجد محادثات مطابقة.</div> : filteredConversations.map((conv) => (
              <button key={conv.key} onClick={() => setSelectedKey(conv.key)} className={`mb-2 flex w-full items-start gap-3 rounded-2xl border p-3 text-right transition ${selectedConversation?.key === conv.key ? "border-indigo-200 bg-white shadow-sm ring-4 ring-indigo-50" : "border-transparent hover:bg-white"}`}>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-xs font-bold text-white">{initials(conv.sender || conv.clientName)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-slate-900">{conv.sender || conv.clientName || "Unknown"}</p>
                    <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(conv.last_message_at)}</span>
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">{conv.clientName}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{conv.last_message || "—"}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${channelStyle[conv.channel] || "border-slate-100 bg-slate-50 text-slate-500"}`}>{conv.channel}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusStyles[conv.conversation_status] || "bg-slate-100 text-slate-600 border-slate-200"}`}>{conv.conversation_status}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{conv.messages_count} رسائل</span>
                  </div>
                  {conv.conversation_id && <p className="mt-2 truncate font-mono text-[10px] text-slate-400">ID: {conv.conversation_id}</p>}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-[700px] flex-col">
          {selectedConversation ? (
            <>
              <div className="flex items-center justify-between border-b border-slate-100 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 font-bold text-indigo-600">{initials(selectedConversation.sender || selectedConversation.clientName)}</div>
                  <div>
                    <h2 className="font-bold text-slate-950">{selectedConversation.sender || selectedConversation.clientName || "Unknown"}</h2>
                    <p className="text-sm text-slate-500">{selectedConversation.clientName} • {selectedConversation.clientEmail || "بدون بريد"}</p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">{formatDate(selectedConversation.last_message_at)}</span>
                  {selectedConversation.conversation_id && <span className="max-w-[320px] truncate rounded-xl bg-indigo-50 px-3 py-1 font-mono text-[11px] font-bold text-indigo-600">{selectedConversation.conversation_id}</span>}
                </div>
              </div>

              {selectedConversation.lead && (
                <div className="border-b border-slate-100 bg-slate-50/60 p-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-sm font-bold text-slate-950">بيانات الـ Lead</h3>
                    <div className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                      <div><p className="text-xs text-slate-400">الاسم</p><p className="font-semibold text-slate-800">{leadName(selectedConversation.lead) || "—"}</p></div>
                      <div><p className="text-xs text-slate-400">رقم الهاتف</p><p className="font-semibold text-slate-800">{leadPhone(selectedConversation.lead) || "—"}</p></div>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto bg-gradient-to-b from-white to-slate-50 p-6">
                {loadingMessages ? (
                  <div className="p-8 text-center text-sm text-slate-500">جارِ تحميل رسائل المحادثة...</div>
                ) : conversationMessages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">لا توجد رسائل لهذه المحادثة.</div>
                ) : (
                  <div className="space-y-4">
                    {conversationMessages.map((msg) => {
                      const isInbound = msg.direction === "inbound";
                      return (
                        <div key={msg.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
                          <div className={`max-w-[78%] rounded-3xl px-5 py-3 shadow-sm ${isInbound ? "rounded-tr-lg border border-slate-200 bg-white text-slate-800" : "rounded-tl-lg bg-indigo-600 text-white"}`}>
                            <div className="mb-2 flex items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isInbound ? "bg-slate-100 text-slate-500" : "bg-white/15 text-white"}`}>{directionLabel(msg.direction)}</span>
                              <span className={`text-[11px] ${isInbound ? "text-slate-400" : "text-indigo-100"}`}>{formatDate(msg.created_at)}</span>
                            </div>
                            <div className="whitespace-pre-wrap break-words text-sm leading-7">{msg.message_text || "—"}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">اختر محادثة من القائمة</div>
          )}
        </section>
      </div>
    </div>
  );
}
