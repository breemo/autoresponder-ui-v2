import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return value;
  }
}

function relativeTime(value) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return `منذ ${minutes} د`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours} س`;
  return `منذ ${Math.floor(hours / 24)} يوم`;
}

function initials(text = "") {
  const clean = String(text).trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function directionLabel(direction) {
  if (["in", "inbound"].includes(direction)) return "واردة";
  if (["out", "outbound"].includes(direction)) return "صادرة";
  return direction || "—";
}

const platformStyles = {
  facebook: "border-blue-100 bg-blue-50 text-blue-700",
  telegram: "border-sky-100 bg-sky-50 text-sky-700",
  whatsapp: "border-emerald-100 bg-emerald-50 text-emerald-700",
  instagram: "border-pink-100 bg-pink-50 text-pink-700",
};

const statusStyles = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-100",
  open: "bg-emerald-50 text-emerald-700 border-emerald-100",
  closed: "bg-slate-100 text-slate-600 border-slate-200",
  lead_captured: "bg-indigo-50 text-indigo-700 border-indigo-100",
  waiting_human: "bg-amber-50 text-amber-700 border-amber-100",
};

function StatCard({ label, value, hint, icon, tone = "indigo" }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600 border-indigo-100",
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    sky: "bg-sky-50 text-sky-600 border-sky-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
  };
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">{value}</p>
          <p className="mt-1 text-xs text-slate-400">{hint}</p>
        </div>
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl border text-xl ${tones[tone]}`}>{icon}</div>
      </div>
    </div>
  );
}

export default function ClientMessages() {
  const { user } = useAuth();
  const clientId = user?.client_id || user?.id;

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [conversationMessages, setConversationMessages] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);

  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [leadsOnly, setLeadsOnly] = useState(false);

  async function fetchConversations() {
    if (!clientId) return;

    try {
      setLoadingConversations(true);
      setError("");

      const [{ data: stateRows, error: stateError }, { data: messageRows, error: messageError }, { data: leadRows, error: leadError }] = await Promise.all([
        supabase
          .from("conversation_state")
          .select("*")
          .eq("client_id", clientId)
          .order("updated_at", { ascending: false }),
        supabase
          .from("messages")
          .select("id, client_id, conversation_id, message, created_at, direction, channel, sender")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        supabase
          .from("leads")
          .select("conversation_id, name, phone, created_at")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
      ]);

      if (stateError) throw stateError;
      if (messageError) throw messageError;
      if (leadError) throw leadError;

      const stateMap = new Map();
      for (const state of stateRows || []) {
        if (state.conversation_id) stateMap.set(state.conversation_id, state);
      }

      const leadMap = new Map();
      for (const lead of leadRows || []) {
        if (lead.conversation_id && !leadMap.has(lead.conversation_id)) leadMap.set(lead.conversation_id, lead);
      }

      const conversationMap = new Map();
      for (const msg of messageRows || []) {
        if (!msg.conversation_id) continue;
        const state = stateMap.get(msg.conversation_id);
        const lead = leadMap.get(msg.conversation_id);
        const existing = conversationMap.get(msg.conversation_id);

        if (!existing) {
          conversationMap.set(msg.conversation_id, {
            conversation_id: msg.conversation_id,
            client_id: clientId,
            sender_id: state?.sender_id || msg.sender || "",
            platform: state?.platform || msg.channel || "",
            channel: msg.channel || state?.platform || "",
            conversation_status: state?.conversation_status || "active",
            current_step: state?.current_step || null,
            updated_at: state?.updated_at || msg.created_at,
            last_message: msg.message || "",
            last_message_at: msg.created_at,
            sender: lead?.name || msg.sender || state?.sender_id || "",
            last_direction: msg.direction || "",
            lead_name: lead?.name || null,
            lead_phone: lead?.phone || null,
            has_lead: !!lead,
            messages_count: 1,
          });
        } else {
          existing.messages_count += 1;
        }
      }

      for (const state of stateRows || []) {
        if (!state.conversation_id || conversationMap.has(state.conversation_id)) continue;
        const lead = leadMap.get(state.conversation_id);
        conversationMap.set(state.conversation_id, {
          ...state,
          last_message: "",
          last_message_at: state.updated_at,
          channel: state.platform || "",
          sender: lead?.name || state.sender_id || "",
          last_direction: "",
          lead_name: lead?.name || null,
          lead_phone: lead?.phone || null,
          has_lead: !!lead,
          messages_count: 0,
        });
      }

      const merged = Array.from(conversationMap.values()).sort((a, b) => {
        const aTime = new Date(a.last_message_at || a.updated_at || 0).getTime();
        const bTime = new Date(b.last_message_at || b.updated_at || 0).getTime();
        return bTime - aTime;
      });

      setConversations(merged);
      setSelectedConversationId((current) => current && merged.some((c) => c.conversation_id === current) ? current : merged[0]?.conversation_id || null);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في جلب المحادثات");
    } finally {
      setLoadingConversations(false);
    }
  }

  async function fetchConversationMessages(conversationId) {
    if (!conversationId || !clientId) return;

    try {
      setLoadingMessages(true);
      setError("");

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("client_id", clientId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setConversationMessages(data || []);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في جلب رسائل المحادثة");
    } finally {
      setLoadingMessages(false);
    }
  }

  async function fetchSelectedLead(conversationId) {
    if (!conversationId || !clientId) {
      setSelectedLead(null);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .eq("client_id", clientId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw error;
      setSelectedLead(data?.[0] || null);
    } catch (err) {
      console.error(err);
      setSelectedLead(null);
    }
  }

  async function updateConversationStatus(newStatus) {
    if (!selectedConversationId || !clientId) return;

    try {
      setUpdatingStatus(true);
      setError("");

      const { error } = await supabase
        .from("conversation_state")
        .update({
          conversation_status: newStatus,
          current_step: null,
          updated_at: new Date().toISOString(),
        })
        .eq("client_id", clientId)
        .eq("conversation_id", selectedConversationId);

      if (error) throw error;

      setConversations((prev) => prev.map((conv) => conv.conversation_id === selectedConversationId ? { ...conv, conversation_status: newStatus, current_step: null, updated_at: new Date().toISOString() } : conv));
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل في تحديث حالة المحادثة");
    } finally {
      setUpdatingStatus(false);
    }
  }

  useEffect(() => {
    if (clientId) fetchConversations();
  }, [clientId]);

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((conv) => {
      const haystack = `${conv.sender || ""} ${conv.last_message || ""} ${conv.sender_id || ""} ${conv.lead_name || ""} ${conv.lead_phone || ""} ${conv.conversation_id || ""}`.toLowerCase();
      const matchesSearch = !q || haystack.includes(q);
      const matchesChannel = channel === "all" || conv.channel === channel || conv.platform === channel;
      const matchesStatus = status === "all" || conv.conversation_status === status;
      const matchesLead = !leadsOnly || conv.has_lead;
      return matchesSearch && matchesChannel && matchesStatus && matchesLead;
    });
  }, [conversations, search, channel, status, leadsOnly]);

  useEffect(() => {
    if (filteredConversations.length === 0) {
      setSelectedConversationId(null);
      setConversationMessages([]);
      setSelectedLead(null);
      return;
    }
    const exists = filteredConversations.some((c) => c.conversation_id === selectedConversationId);
    if (!exists) setSelectedConversationId(filteredConversations[0].conversation_id);
  }, [filteredConversations, selectedConversationId]);

  useEffect(() => {
    if (selectedConversationId) {
      fetchConversationMessages(selectedConversationId);
      fetchSelectedLead(selectedConversationId);
    } else {
      setConversationMessages([]);
      setSelectedLead(null);
    }
  }, [selectedConversationId]);

  const selectedConversation = filteredConversations.find((c) => c.conversation_id === selectedConversationId) || null;

  const stats = useMemo(() => ({
    total: conversations.length,
    active: conversations.filter((c) => ["active", "open"].includes(c.conversation_status)).length,
    closed: conversations.filter((c) => c.conversation_status === "closed").length,
    leads: conversations.filter((c) => c.has_lead).length,
  }), [conversations]);

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-end">
        <button onClick={fetchConversations} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50">↻ تحديث</button>
      </div>

      {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="إجمالي المحادثات" value={stats.total} hint="حسب conversation_id" icon="💬" />
        <StatCard label="النشطة" value={stats.active} hint="محادثات مفتوحة" icon="●" tone="emerald" />
        <StatCard label="المغلقة" value={stats.closed} hint="تم إغلاقها" icon="✓" tone="sky" />
        <StatCard label="Leads" value={stats.leads} hint="محادثات فيها بيانات" icon="◎" tone="amber" />
      </div>

      <div className="grid min-h-[720px] grid-cols-1 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm xl:grid-cols-[390px_1fr]" dir="rtl">
        <aside className="border-l border-slate-100 bg-slate-50/50">
          <div className="border-b border-slate-100 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-slate-950">قائمة المحادثات</h2>
                <p className="mt-1 text-xs text-slate-500">{filteredConversations.length} محادثة ظاهرة</p>
              </div>
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">Live</span>
            </div>

            <div className="space-y-3">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم، الرقم، الرسالة، conversation_id..." className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50" />
              <div className="grid grid-cols-2 gap-2">
                <select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-300">
                  <option value="all">كل القنوات</option>
                  <option value="facebook">Facebook</option>
                  <option value="telegram">Telegram</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="instagram">Instagram</option>
                </select>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-300">
                  <option value="all">كل الحالات</option>
                  <option value="active">نشطة</option>
                  <option value="open">Open</option>
                  <option value="closed">مغلقة</option>
                  <option value="lead_captured">Lead</option>
                  <option value="waiting_human">بانتظار موظف</option>
                </select>
              </div>
              <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                <input type="checkbox" checked={leadsOnly} onChange={(e) => setLeadsOnly(e.target.checked)} />
                فقط المحادثات التي فيها Lead
              </label>
            </div>
          </div>

          <div className="max-h-[580px] overflow-y-auto p-3">
            {loadingConversations ? (
              <div className="p-8 text-center text-sm text-slate-500">جارِ تحميل المحادثات...</div>
            ) : filteredConversations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">لا توجد محادثات مطابقة.</div>
            ) : (
              filteredConversations.map((conv) => {
                const isActive = conv.conversation_id === selectedConversationId;
                const platformClass = platformStyles[(conv.channel || conv.platform || "").toLowerCase()] || "border-slate-200 bg-slate-50 text-slate-600";
                const statusClass = statusStyles[conv.conversation_status] || "bg-slate-100 text-slate-600 border-slate-200";

                return (
                  <button key={conv.conversation_id} onClick={() => setSelectedConversationId(conv.conversation_id)} className={`mb-2 w-full rounded-2xl border p-3 text-right transition ${isActive ? "border-indigo-200 bg-white shadow-sm ring-4 ring-indigo-50" : "border-transparent hover:border-slate-200 hover:bg-white"}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-xs font-bold text-white">{initials(conv.lead_name || conv.sender || conv.sender_id)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-bold text-slate-950">{conv.lead_name || conv.sender || conv.sender_id || "بدون اسم"}</p>
                          <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(conv.last_message_at || conv.updated_at)}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{conv.last_message || "لا توجد رسالة بعد"}</p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${platformClass}`}>{conv.channel || conv.platform || "unknown"}</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusClass}`}>{conv.conversation_status || "active"}</span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{conv.messages_count} رسائل</span>
                        </div>
                        <p className="mt-2 truncate font-mono text-[10px] text-slate-400">ID: {conv.conversation_id}</p>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="flex min-h-[720px] flex-col bg-white">
          {!selectedConversation ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">اختر محادثة من القائمة</div>
          ) : (
            <>
              <div className="border-b border-slate-100 p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 font-bold text-indigo-600">{initials(selectedLead?.name || selectedConversation.sender || selectedConversation.sender_id)}</div>
                    <div>
                      <h2 className="text-lg font-bold text-slate-950">{selectedLead?.name || selectedConversation.lead_name || selectedConversation.sender || selectedConversation.sender_id || "بدون اسم"}</h2>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">{selectedConversation.channel || selectedConversation.platform || "unknown"}</span>
                        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusStyles[selectedConversation.conversation_status] || "bg-slate-100 text-slate-600 border-slate-200"}`}>{selectedConversation.conversation_status || "active"}</span>
                        <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">{conversationMessages.length} رسائل</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-start gap-2 lg:items-end">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-500">{selectedConversation.conversation_id}</div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => updateConversationStatus("active")} disabled={updatingStatus || selectedConversation.conversation_status === "active"} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white shadow-sm disabled:opacity-50">إعادة فتح</button>
                      <button onClick={() => updateConversationStatus("closed")} disabled={updatingStatus || selectedConversation.conversation_status === "closed"} className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white shadow-sm disabled:opacity-50">إغلاق</button>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-sm font-bold text-slate-950">بيانات الـ Lead</h3>
                  {selectedLead ? (
                    <div className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                      <div><p className="text-xs text-slate-400">الاسم</p><p className="font-semibold text-slate-800">{selectedLead.name || "—"}</p></div>
                      <div><p className="text-xs text-slate-400">رقم الهاتف</p><p className="font-semibold text-slate-800">{selectedLead.phone || "—"}</p></div>
                    </div>
                  ) : <p className="mt-2 text-sm text-slate-400">لا توجد بيانات Lead لهذه المحادثة.</p>}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto bg-gradient-to-b from-white to-slate-50 p-6">
                {loadingMessages ? (
                  <div className="p-8 text-center text-sm text-slate-500">جارِ تحميل رسائل المحادثة...</div>
                ) : conversationMessages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">لا توجد رسائل لهذه المحادثة.</div>
                ) : (
                  <div className="space-y-4">
                    {conversationMessages.map((msg) => {
                      const isInbound = ["inbound", "in"].includes(msg.direction);
                      return (
                        <div key={msg.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
                          <div className={`max-w-[78%] rounded-3xl px-5 py-3 shadow-sm ${isInbound ? "rounded-tr-lg border border-slate-200 bg-white text-slate-800" : "rounded-tl-lg bg-indigo-600 text-white"}`}>
                            <div className="mb-2 flex items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isInbound ? "bg-slate-100 text-slate-500" : "bg-white/15 text-white"}`}>{directionLabel(msg.direction)}</span>
                              <span className={`text-[11px] ${isInbound ? "text-slate-400" : "text-indigo-100"}`}>{formatDate(msg.created_at)}</span>
                            </div>
                            <div className="whitespace-pre-wrap break-words text-sm leading-7">{msg.message || "—"}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
