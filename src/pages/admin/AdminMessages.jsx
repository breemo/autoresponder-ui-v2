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

function getChannel(row = {}) {
  return String(row.platform || row.channel || "unknown").toLowerCase();
}

function getSender(row = {}) {
  return String(row.sender_id || row.sender || row.customer_id || row.from || row.psid || "").trim();
}

function buildThreadKey({ msg, state }) {
  const clientId = msg.client_id || state?.client_id || "no-client";
  const channel = getChannel(state || msg);
  const direction = normalizeDirection(msg.direction || msg.channel_direction);
  const sender = state?.sender_id || (direction === "inbound" ? getSender(msg) : "") || getSender(msg);

  // Messenger-like grouping: one thread per customer/page channel.
  // If sender is known, this intentionally groups multiple conversation_id sessions under the same contact.
  if (sender) return `thread:${clientId}:${channel}:${sender}`;

  // Last fallback only when we really cannot know the sender/contact.
  return msg.conversation_id ? `conv:${msg.conversation_id}` : `row:${msg.id}`;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      setError("");

      const [clientsRes, statesRes, messagesRes, leadsRes] = await Promise.all([
        supabase.from("clients").select("id, business_name, email").order("business_name", { ascending: true }),
        supabase.from("conversation_state").select("*").order("updated_at", { ascending: false }).limit(2000),
        supabase
          .from("messages")
          .select("*, clients:client_id(business_name,email)")
          .order("created_at", { ascending: false })
          .limit(3000),
        supabase.from("leads").select("*").order("created_at", { ascending: false }).limit(2000),
      ]);

      if (clientsRes.error) throw clientsRes.error;
      if (statesRes.error) throw statesRes.error;
      if (messagesRes.error) throw messagesRes.error;
      if (leadsRes.error) throw leadsRes.error;

      const clientRows = clientsRes.data || [];
      const stateRows = statesRes.data || [];
      const leadRows = leadsRes.data || [];
      const messageRows = (messagesRes.data || []).map((m) => ({
        ...m,
        channel: getChannel(m),
        direction: normalizeDirection(m.direction || m.channel_direction),
        message_text: getMessageText(m),
      }));

      setClients(clientRows);

      const clientMap = new Map(clientRows.map((c) => [c.id, c]));
      const stateByConversation = new Map();
      for (const state of stateRows) {
        if (state.conversation_id) stateByConversation.set(state.conversation_id, state);
      }

      const leadByConversation = new Map();
      for (const lead of leadRows) {
        if (lead.conversation_id && !leadByConversation.has(lead.conversation_id)) {
          leadByConversation.set(lead.conversation_id, lead);
        }
      }

      const threadMap = new Map();

      for (const msg of messageRows) {
        const state = msg.conversation_id ? stateByConversation.get(msg.conversation_id) : null;
        const lead = msg.conversation_id ? leadByConversation.get(msg.conversation_id) : null;
        const key = buildThreadKey({ msg, state });
        const client = msg.clients || clientMap.get(msg.client_id) || {};
        const channel = getChannel(state || msg);
        const customerId = state?.sender_id || (msg.direction === "inbound" ? getSender(msg) : "") || getSender(msg);

        if (!threadMap.has(key)) {
          threadMap.set(key, {
            key,
            client_id: msg.client_id || state?.client_id,
            clientName: client.business_name || "Unknown client",
            clientEmail: client.email || "",
            sender: leadName(lead) || customerId || "بدون مرسل",
            sender_id: customerId || "",
            channel,
            conversation_status: state?.conversation_status || "active",
            updated_at: state?.updated_at || msg.created_at,
            last_message: msg.message_text || "",
            last_message_at: msg.created_at,
            messages_count: 0,
            inbound: 0,
            outbound: 0,
            unread: 0,
            lead,
            conversation_ids: new Set(),
            messages: [],
          });
        }

        const thread = threadMap.get(key);
        thread.messages.push(msg);
        thread.messages_count += 1;
        if (msg.conversation_id) thread.conversation_ids.add(msg.conversation_id);
        if (msg.direction === "inbound") thread.inbound += 1;
        if (msg.direction === "outbound") thread.outbound += 1;
        if (msg.is_read === false) thread.unread += 1;
        if (!thread.lead && lead) thread.lead = lead;
        if ((!thread.sender || thread.sender === "بدون مرسل") && (leadName(lead) || customerId)) thread.sender = leadName(lead) || customerId;
        if (msg.created_at && new Date(msg.created_at) >= new Date(thread.last_message_at || 0)) {
          thread.last_message = msg.message_text || thread.last_message;
          thread.last_message_at = msg.created_at;
        }
      }

      // Include state-only threads only when no messages exist yet.
      for (const state of stateRows) {
        const fakeMsg = { client_id: state.client_id, conversation_id: state.conversation_id, channel: state.platform, sender: state.sender_id, direction: "inbound", id: state.conversation_id };
        const key = buildThreadKey({ msg: fakeMsg, state });
        if (threadMap.has(key)) continue;
        const client = clientMap.get(state.client_id) || {};
        const lead = state.conversation_id ? leadByConversation.get(state.conversation_id) : null;
        threadMap.set(key, {
          key,
          client_id: state.client_id,
          clientName: client.business_name || "Unknown client",
          clientEmail: client.email || "",
          sender: leadName(lead) || state.sender_id || "بدون مرسل",
          sender_id: state.sender_id || "",
          channel: getChannel(state),
          conversation_status: state.conversation_status || "active",
          updated_at: state.updated_at,
          last_message: "",
          last_message_at: state.updated_at,
          messages_count: 0,
          inbound: 0,
          outbound: 0,
          unread: 0,
          lead,
          conversation_ids: new Set(state.conversation_id ? [state.conversation_id] : []),
          messages: [],
        });
      }

      const merged = Array.from(threadMap.values())
        .map((thread) => ({
          ...thread,
          conversation_ids: Array.from(thread.conversation_ids),
          messages: thread.messages.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)),
        }))
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

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (clientFilter !== "all" && c.client_id !== clientFilter) return false;
      if (channelFilter !== "all" && (c.channel || "").toLowerCase() !== channelFilter) return false;
      if (directionFilter === "inbound" && c.inbound === 0) return false;
      if (directionFilter === "outbound" && c.outbound === 0) return false;

      const haystack = `${c.clientName || ""} ${c.clientEmail || ""} ${c.sender || ""} ${c.sender_id || ""} ${c.last_message || ""} ${(c.conversation_ids || []).join(" ")}`.toLowerCase();
      return !q || haystack.includes(q);
    });
  }, [conversations, search, clientFilter, channelFilter, directionFilter]);

  const selectedConversation = filteredConversations.find((c) => c.key === selectedKey) || filteredConversations[0] || null;
  const conversationMessages = selectedConversation?.messages || [];
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
        <StatCard label="Conversations" value={conversations.length} hint="محادثات مجمعة حسب العميل/القناة/المرسل" icon="💬" />
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
                    {conv.conversation_ids?.length > 1 && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">{conv.conversation_ids.length} sessions</span>}
                  </div>
                  {conv.conversation_ids?.[0] && <p className="mt-2 truncate font-mono text-[10px] text-slate-400">ID: {conv.conversation_ids[0]}</p>}
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
                  {selectedConversation.conversation_ids?.length > 0 && <span className="max-w-[420px] truncate rounded-xl bg-indigo-50 px-3 py-1 font-mono text-[11px] font-bold text-indigo-600">{selectedConversation.conversation_ids.join(" • ")}</span>}
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
                {conversationMessages.length === 0 ? (
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
