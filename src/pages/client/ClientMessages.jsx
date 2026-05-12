import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";

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
    try {
      setLoadingConversations(true);
      setError("");

      const { data: stateRows, error: stateError } = await supabase
        .from("conversation_state")
        .select("*")
        .eq("client_id", clientId)
        .order("updated_at", { ascending: false });

      if (stateError) throw stateError;

      const { data: messageRows, error: messageError } = await supabase
        .from("messages")
        .select("id, conversation_id, message, created_at, direction, channel, sender")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      if (messageError) throw messageError;

      const { data: leadRows, error: leadError } = await supabase
        .from("leads")
        .select("conversation_id, name, phone, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      if (leadError) throw leadError;

      const stateMap = new Map();
      for (const state of stateRows || []) {
        if (state.conversation_id) {
          stateMap.set(state.conversation_id, state);
        }
      }

      const leadMap = new Map();
      for (const lead of leadRows || []) {
        if (lead.conversation_id && !leadMap.has(lead.conversation_id)) {
          leadMap.set(lead.conversation_id, lead);
        }
      }

      const conversationMap = new Map();

      // Build conversations from messages first, not from conversation_state only.
      // This fixes missing conversations when state rows are missing/stale.
      for (const msg of messageRows || []) {
        if (!msg.conversation_id) continue;

        if (!conversationMap.has(msg.conversation_id)) {
          const state = stateMap.get(msg.conversation_id);
          const lead = leadMap.get(msg.conversation_id);

          conversationMap.set(msg.conversation_id, {
            conversation_id: msg.conversation_id,
            client_id: clientId,
            sender_id: state?.sender_id || msg.sender || "",
            platform: state?.platform || msg.channel || "",
            conversation_status: state?.conversation_status || "active",
            current_step: state?.current_step || null,
            updated_at: state?.updated_at || msg.created_at,

            last_message: msg.message || "",
            last_message_at: msg.created_at,
            channel: msg.channel || state?.platform || "",
            sender: lead?.name || msg.sender || state?.sender_id || "",
            last_direction: msg.direction || "",

            lead_name: lead?.name || null,
            lead_phone: lead?.phone || null,
            has_lead: !!lead,
          });
        }
      }

      // Also include state-only conversations if they exist without messages.
      for (const state of stateRows || []) {
        if (!state.conversation_id) continue;
        if (conversationMap.has(state.conversation_id)) continue;

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
        });
      }

      const merged = Array.from(conversationMap.values()).sort((a, b) => {
        const aTime = new Date(a.last_message_at || a.updated_at || 0).getTime();
        const bTime = new Date(b.last_message_at || b.updated_at || 0).getTime();
        return bTime - aTime;
      });

      setConversations(merged);
    } catch (err) {
      console.error(err);
      setError("فشل في جلب المحادثات");
    } finally {
      setLoadingConversations(false);
    }
  }

  async function fetchConversationMessages(conversationId) {
    if (!conversationId) return;

    try {
      setLoadingMessages(true);

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
      setError("فشل في جلب رسائل المحادثة");
    } finally {
      setLoadingMessages(false);
    }
  }

  async function fetchSelectedLead(conversationId) {
    if (!conversationId) {
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
    if (!selectedConversationId) return;

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

      setConversations((prev) =>
        prev.map((conv) =>
          conv.conversation_id === selectedConversationId
            ? {
                ...conv,
                conversation_status: newStatus,
                current_step: null,
                updated_at: new Date().toISOString(),
              }
            : conv
        )
      );
    } catch (err) {
      console.error(err);
      setError("فشل في تحديث حالة المحادثة");
    } finally {
      setUpdatingStatus(false);
    }
  }

  useEffect(() => {
    if (clientId) {
      fetchConversations();
    }
  }, [clientId]);

  const filteredConversations = useMemo(() => {
    return conversations.filter((conv) => {
      const haystack = `${conv.sender || ""} ${conv.last_message || ""} ${conv.sender_id || ""} ${conv.lead_name || ""} ${conv.lead_phone || ""}`.toLowerCase();

      const matchesSearch = !search.trim() || haystack.includes(search.toLowerCase());
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

    const exists = filteredConversations.some(
      (c) => c.conversation_id === selectedConversationId
    );

    if (!exists) {
      setSelectedConversationId(filteredConversations[0].conversation_id);
    }
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

  const selectedConversation =
    filteredConversations.find((c) => c.conversation_id === selectedConversationId) || null;

  const stats = useMemo(() => {
    return {
      total: conversations.length,
      active: conversations.filter((c) => c.conversation_status === "active").length,
      closed: conversations.filter((c) => c.conversation_status === "closed").length,
      leads: conversations.filter((c) => c.has_lead).length,
    };
  }, [conversations]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">الرسائل</h1>
        <p className="text-gray-500">استعرض المحادثات والرسائل الخاصة بك.</p>
      </div>

      {false && (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white shadow rounded-xl p-4">
          <div className="text-sm text-gray-500 mb-1">إجمالي المحادثات</div>
          <div className="text-2xl font-bold">{stats.total}</div>
        </div>
        <div className="bg-white shadow rounded-xl p-4">
          <div className="text-sm text-gray-500 mb-1">المحادثات النشطة</div>
          <div className="text-2xl font-bold text-blue-600">{stats.active}</div>
        </div>
        <div className="bg-white shadow rounded-xl p-4">
          <div className="text-sm text-gray-500 mb-1">المحادثات المغلقة</div>
          <div className="text-2xl font-bold text-gray-700">{stats.closed}</div>
        </div>
        <div className="bg-white shadow rounded-xl p-4">
          <div className="text-sm text-gray-500 mb-1">عدد الـ Leads</div>
          <div className="text-2xl font-bold text-green-600">{stats.leads}</div>
        </div>
      </div>
      )}

      {error ? <div className="bg-red-50 text-red-600 p-4 rounded-xl">{error}</div> : null}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="bg-white shadow rounded-xl p-4 lg:col-span-3">
          <h2 className="font-bold mb-4">المحادثات</h2>

          <div className="space-y-3 mb-4">
            <input
              className="border p-2 rounded w-full"
              placeholder="بحث..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <select
              className="border p-2 rounded w-full"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              <option value="all">كل القنوات</option>
              <option value="facebook">Facebook</option>
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
            </select>

            <select
              className="border p-2 rounded w-full"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">كل الحالات</option>
              <option value="active">نشطة</option>
              <option value="closed">مغلقة</option>
              <option value="lead_captured">تم أخذ البيانات</option>
            </select>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={leadsOnly}
                onChange={(e) => setLeadsOnly(e.target.checked)}
              />
              عرض المحادثات التي فيها Lead فقط
            </label>

            <button
              onClick={fetchConversations}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 w-full"
            >
              تحديث
            </button>
          </div>

          {loadingConversations ? (
            <p className="text-gray-500 text-center">جارِ التحميل...</p>
          ) : filteredConversations.length === 0 ? (
            <p className="text-gray-400 text-sm">لا توجد نتائج.</p>
          ) : (
            <div className="space-y-2 max-h-[650px] overflow-y-auto">
              {filteredConversations.map((conv) => {
                const isActive = conv.conversation_id === selectedConversationId;

                return (
                  <button
                    key={conv.conversation_id}
                    onClick={() => setSelectedConversationId(conv.conversation_id)}
                    className={`w-full text-right border rounded-xl p-3 transition ${
                      isActive ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-semibold text-sm">
                        {conv.lead_name || conv.sender || conv.sender_id || "بدون اسم"}
                      </span>
                      <span className="text-xs text-gray-500">
                        {conv.channel || conv.platform || "-"}
                      </span>
                    </div>

                    <div className="text-sm text-gray-700 truncate mb-1">
                      {conv.last_message || "لا توجد رسالة"}
                    </div>

                    <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
                      <span>{conv.conversation_status || "active"}</span>
                      <span>
                        {conv.last_message_at
                          ? new Date(conv.last_message_at).toLocaleString("ar-EG")
                          : ""}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white shadow rounded-xl p-4 lg:col-span-9">
          {!selectedConversation ? (
            <p className="text-gray-400 text-sm">لا توجد محادثة مطابقة للفلاتر الحالية.</p>
          ) : (
            <>
              <div className="border-b pb-4 mb-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-bold text-lg">
                      {selectedLead?.name || selectedConversation.lead_name || selectedConversation.sender || selectedConversation.sender_id || "بدون اسم"}
                    </h2>
                    <p className="text-sm text-gray-500">
                      {selectedConversation.channel || selectedConversation.platform} | {selectedConversation.conversation_status}
                    </p>
                  </div>

                  <div className="text-xs text-gray-400 break-all text-left max-w-[50%]">
                    {selectedConversation.conversation_id}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => updateConversationStatus("closed")}
                    disabled={updatingStatus || selectedConversation.conversation_status === "closed"}
                    className="px-3 py-2 rounded bg-gray-800 text-white text-sm disabled:opacity-50"
                  >
                    إغلاق المحادثة
                  </button>

                  <button
                    onClick={() => updateConversationStatus("active")}
                    disabled={updatingStatus || selectedConversation.conversation_status === "active"}
                    className="px-3 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
                  >
                    إعادة فتح المحادثة
                  </button>
                </div>

                <div className="bg-gray-50 rounded-lg px-3 py-2 border mb-1">
                  <h3 className="font-semibold text-sm mb-1">بيانات الـ Lead</h3>
                  {selectedLead ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-gray-500 mb-0.5">الاسم</div>
                        <div className="font-medium">{selectedLead.name || "-"}</div>
                      </div>
                      <div>
                        <div className="text-gray-500 mb-0.5">رقم الهاتف</div>
                        <div className="font-medium">{selectedLead.phone || "-"}</div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400">لا توجد بيانات lead لهذه المحادثة.</p>
                  )}
                </div>
              </div>

              {loadingMessages ? (
                <p className="text-gray-500 text-center">جارِ تحميل الرسائل...</p>
              ) : conversationMessages.length === 0 ? (
                <p className="text-gray-400 text-sm">لا توجد رسائل في هذه المحادثة.</p>
              ) : (
                <div className="space-y-3 max-h-[650px] overflow-y-auto">
                  {conversationMessages.map((msg) => {
                    const isInbound = msg.direction === "inbound" || msg.direction === "in";

                    return (
                      <div key={msg.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
                        <div
                          className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                            isInbound ? "bg-gray-100 text-gray-800" : "bg-blue-600 text-white"
                          }`}
                        >
                          <div className="whitespace-pre-wrap break-words">{msg.message}</div>
                          <div className={`mt-1 text-[11px] ${isInbound ? "text-gray-500" : "text-blue-100"}`}>
                            {new Date(msg.created_at).toLocaleString("ar-EG")}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
