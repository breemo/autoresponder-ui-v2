import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PhotoIcon, DocumentIcon, MicrophoneIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import ChannelIcon from "../../lib/channelIcons.jsx";

// Prepared, disabled controls for future media sending. Each media type is
// its own clearly-labelled placeholder (rather than one generic "attach"
// button), so the composer's structure is ready to wire up per media type
// later without pretending any of them work today. No payload/backend
// change accompanies this — text sending (sendHumanReply) is unchanged.
const MEDIA_CONTROLS = [
  { key: "image", labelKey: "messagesPage.mediaImage", icon: PhotoIcon },
  { key: "document", labelKey: "messagesPage.mediaDocument", icon: DocumentIcon },
  { key: "voice", labelKey: "messagesPage.mediaVoice", icon: MicrophoneIcon },
];

function formatDate(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(lang === "en" ? "en-US" : "ar-EG", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return value;
  }
}

function relativeTime(value, t) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return t("common.timeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.timeHoursAgo", { count: hours });
  return t("common.timeDaysAgo", { count: Math.floor(hours / 24) });
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

function directionLabel(direction, t) {
  if (["in", "inbound"].includes(direction)) return t("common.inbound");
  if (["out", "outbound"].includes(direction)) return t("common.outbound");
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
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">{value}</p>
          <p className="mt-1 text-xs text-slate-400">{hint}</p>
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border text-xl ${tones[tone]}`}>{icon}</div>
      </div>
    </div>
  );
}

export default function ClientMessages() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  // client_id is resolved once at login via client_users (see Login.jsx).
  const clientId = user?.client_id || null;

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [conversationMessages, setConversationMessages] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);

  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [leadsOnly, setLeadsOnly] = useState(false);

  // Reply composer (Phase 2B): sends via /api/human-reply, never inserts
  // into Supabase directly and never touches conversation_status/current_step.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const sendingRef = useRef(false);

  // Message pane scroll behavior: jump to the latest message when a
  // conversation is opened, but don't yank the view down if the user has
  // scrolled up to read older messages.
  const messagesScrollRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const lastLoadedConversationRef = useRef(null);
  const selectedConversationIdRef = useRef(null);

  // Realtime support (no polling): mirrors the currently-known conversation
  // ids so the INSERT handler can tell "existing conversation, patch it" vs
  // "brand new conversation, do a single event-driven refetch" apart
  // without touching React state from inside a setState updater. Also
  // tracks message ids already processed via Realtime so a duplicate
  // delivery (e.g. a reconnect) is never applied twice to the list's
  // messages_count/unread_count.
  const conversationIdsRef = useRef(new Set());
  const seenRealtimeMessageIdsRef = useRef(new Set());

  async function fetchConversations() {
    if (!clientId) return;

    try {
      setLoadingConversations(true);
      setError("");

      const [{ data: stateRows, error: stateError }, { data: messageRows, error: messageError }, { data: leadRows, error: leadError }] = await Promise.all([
        supabase
          .from("conversation_state")
          .select("*, assigned_user:assigned_user_id(id, name)")
          .eq("client_id", clientId)
          .order("updated_at", { ascending: false }),
        supabase
          .from("messages")
          .select("id, client_id, conversation_id, message, created_at, direction, channel, sender, is_read")
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
            assigned_user_id: state?.assigned_user_id || null,
            assigned_at: state?.assigned_at || null,
            assigned_user: state?.assigned_user || null,
            updated_at: state?.updated_at || msg.created_at,
            last_message: getMessageText(msg) || "",
            last_message_at: msg.created_at,
            sender: lead?.name || msg.sender || state?.sender_id || "",
            last_direction: msg.direction || "",
            lead_name: lead?.name || null,
            lead_phone: lead?.phone || null,
            has_lead: !!lead,
            messages_count: 1,
            unread_count: msg.is_read === false ? 1 : 0,
          });
        } else {
          existing.messages_count += 1;
          if (msg.is_read === false) existing.unread_count += 1;
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
          unread_count: 0,
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
      setError(t("messagesPage.errorFetchConversations"));
    } finally {
      setLoadingConversations(false);
    }
  }

  // `silent: true` refetches in the background (used after sending a human
  // reply, to reveal the outbound message n8n stores) without toggling the
  // loading spinner or the page-level error banner. Returns the fetched rows
  // so callers can check whether a new message has appeared yet.
  async function fetchConversationMessages(conversationId, { silent = false } = {}) {
    if (!conversationId || !clientId) return null;

    try {
      if (!silent) {
        setLoadingMessages(true);
        setError("");
      }

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("client_id", clientId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      const rows = (data || []).map((m) => ({ ...m, message_text: getMessageText(m) }));
      setConversationMessages(rows);
      return rows;
    } catch (err) {
      console.error(err);
      if (!silent) setError(t("messagesPage.errorFetchMessages"));
      return null;
    } finally {
      if (!silent) setLoadingMessages(false);
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

  // Shared status-update helper. Delegates to the server-authorized
  // /api/conversation-status endpoint rather than writing conversation_state
  // directly from the browser — this used to be a direct Supabase write
  // with no actor/permission/ownership check at all, which meant a
  // non-assigned teammate could bypass the UI's disabled Close button
  // entirely by calling Supabase from devtools. The server now re-derives
  // client_id/permission and, for `close`, verifies the actor is the
  // conversation's assigned employee whenever it's already waiting_human
  // (see api/conversation-status.js). `currentStep`/`preserveStep`/
  // `clearAssignment` only shape the *local* optimistic patch to match what
  // the server is known to have done for each action — they don't control
  // server behavior.
  async function applyStatusChange(action, newStatus, { currentStep = null, preserveStep = false, clearAssignment = false } = {}) {
    if (!selectedConversationId || !clientId) return;

    try {
      setUpdatingStatus(true);
      setError("");

      const response = await fetch("/api/conversation-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, conversation_id: selectedConversationId, actor_user_id: user?.id }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorStatusUpdate"));
      }

      const payload = { conversation_status: newStatus, updated_at: data.updated_at || new Date().toISOString() };
      if (!preserveStep) payload.current_step = currentStep;
      if (clearAssignment) {
        payload.assigned_user_id = null;
        payload.assigned_at = null;
      }

      setConversations((prev) =>
        prev.map((conv) =>
          conv.conversation_id === selectedConversationId
            ? { ...conv, ...payload, assigned_user: clearAssignment ? null : conv.assigned_user }
            : conv
        )
      );
    } catch (err) {
      console.error(err);
      setError(err.message || t("messagesPage.errorStatusUpdate"));
    } finally {
      setUpdatingStatus(false);
    }
  }

  // Explicit close: conversation_status = closed, current_step = done.
  // Assignment (if any) is deliberately preserved — see applyStatusChange.
  // Server-enforced: blocked unless the actor is the assigned employee, if
  // the conversation is already waiting_human (see api/conversation-status.js).
  function closeConversation() {
    return applyStatusChange("close", "closed", { currentStep: "done" });
  }

  // Explicit reopen/reset to normal AI flow: conversation_status = active,
  // current_step = null, and any existing claim is cleared — a conversation
  // handed back to AI has no human owner until taken over again. Only ever
  // called from a closed conversation (see the button below), which has no
  // owner-concept, so this stays open to any Inbox-eligible teammate,
  // matching pre-existing behavior.
  function reopenConversation() {
    return applyStatusChange("reopen", "active", { currentStep: null, clearAssignment: true });
  }

  // Explicit human takeover: conversation_status = waiting_human only.
  // current_step must be preserved exactly, not reset. This only opens the
  // shared queue — it does not assign anyone; see claimConversation for the
  // explicit per-employee claim step. Always called from a non-waiting_human
  // state, so there's no owner yet to check against.
  function takeoverConversation() {
    return applyStatusChange("takeover", "waiting_human", { preserveStep: true });
  }

  // Explicit claim ("استلام المحادثة"): delegates the actual assignment to
  // /api/claim-conversation, which performs a single conditional UPDATE
  // (... WHERE assigned_user_id IS NULL) so only one concurrent caller can
  // ever win — see that file for the full race-condition explanation. This
  // handler never assumes it won; it always reconciles local state with
  // whatever the API reports, whether that's success or "already claimed".
  async function claimConversation(conversationId) {
    if (!conversationId || claimingId) return;

    setClaimingId(conversationId);
    setError("");

    try {
      const response = await fetch("/api/claim-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, actor_user_id: user?.id }),
      });

      const data = await response.json().catch(() => ({}));
      const assignment = data?.assignment || null;

      if (data?.claimed) {
        setConversations((prev) =>
          prev.map((conv) =>
            conv.conversation_id === conversationId
              ? {
                  ...conv,
                  assigned_user_id: assignment?.assigned_user_id || null,
                  assigned_at: assignment?.assigned_at || null,
                  assigned_user: assignment?.assigned_user || null,
                }
              : conv
          )
        );
        return;
      }

      // Lost the race, or the conversation left waiting_human in the
      // meantime — reconcile with the API's view instead of just failing,
      // so the button/badge reflects the real current owner immediately.
      setConversations((prev) =>
        prev.map((conv) =>
          conv.conversation_id === conversationId
            ? {
                ...conv,
                conversation_status: assignment?.conversation_status || conv.conversation_status,
                assigned_user_id: assignment?.assigned_user_id ?? conv.assigned_user_id,
                assigned_user: assignment?.assigned_user || conv.assigned_user,
              }
            : conv
        )
      );
      setError(data?.message || t("messagesPage.errorClaimFailed"));
    } catch (err) {
      console.error(err);
      setError(t("messagesPage.errorClaimRetry"));
    } finally {
      setClaimingId(null);
    }
  }

  // After a successful send, n8n still needs to deliver through the channel
  // and insert the outbound row — poll a few times with backoff instead of
  // inserting a local fake message. Bails out early if the user has since
  // switched conversations.
  async function refreshMessagesAfterSend(conversationId, previousCount) {
    const delaysMs = [600, 1200, 2000];

    for (const delay of delaysMs) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (selectedConversationIdRef.current !== conversationId) return;

      const rows = await fetchConversationMessages(conversationId, { silent: true });
      if (rows && rows.length > previousCount) return;
    }
  }

  // Sends a human reply via the server-side proxy only. Must never insert
  // into `messages` directly and must never touch conversation_status /
  // current_step — those are owned by the explicit action buttons above.
  async function sendHumanReply() {
    const trimmed = draft.trim();
    if (!trimmed || !selectedConversationId || sendingRef.current) return;
    // Mirrors the composer's own disabled state (see canControlConversation)
    // — belt-and-suspenders against any path that could still call this
    // directly. The server (api/human-reply.js) is the authoritative check.
    if (!canControlConversation) return;

    sendingRef.current = true;
    setSending(true);
    setSendError("");

    const conversationId = selectedConversationId;
    const previousCount = conversationMessages.length;

    try {
      const response = await fetch("/api/human-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, message: trimmed, actor_user_id: user?.id }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorSendReply"));
      }

      setDraft("");
      refreshMessagesAfterSend(conversationId, previousCount);
    } catch (err) {
      console.error(err);
      setSendError(err.message || t("messagesPage.errorSendRetry"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleComposerKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendHumanReply();
    }
  }

  useEffect(() => {
    if (clientId) fetchConversations();
  }, [clientId]);

  // Keeps a ref mirror of "which conversation ids are currently known" so
  // the Realtime handler can decide existing-vs-new synchronously, without
  // performing a side effect (a refetch) from inside a setState updater.
  useEffect(() => {
    conversationIdsRef.current = new Set(conversations.map((c) => c.conversation_id));
  }, [conversations]);

  // New inbound/outbound message arriving via Realtime (see the
  // subscription effect below). Handles the three required updates:
  // append to the open thread if it's the selected conversation, patch the
  // matching conversation's preview/counts in the list, or — for a
  // conversation not seen before — a single event-driven refetch (never
  // polling). message.id is the dedup key throughout: the open-thread
  // append checks it against the current thread before appending (also
  // covers a locally-sent reply that arrives here after
  // refreshMessagesAfterSend's own poll already pulled it in), and
  // seenRealtimeMessageIdsRef additionally guards the list's incremental
  // counters against a duplicate Realtime delivery of the same row.
  function handleRealtimeMessage(msg) {
    // Defensive: an uncaught exception thrown from inside a Realtime
    // callback would otherwise surface as an unhandled error at the point
    // React processes the resulting setState, with nothing here to explain
    // why. Guarding the whole handler keeps one malformed/unexpected event
    // payload from ever affecting anything beyond itself.
    try {
      if (!msg || !msg.conversation_id) return;

      if (msg.id != null) {
        if (seenRealtimeMessageIdsRef.current.has(msg.id)) return;
        seenRealtimeMessageIdsRef.current.add(msg.id);
      }

      const messageText = getMessageText(msg);

      if (selectedConversationIdRef.current === msg.conversation_id) {
        setConversationMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, { ...msg, message_text: messageText }];
        });
      }

      if (!conversationIdsRef.current.has(msg.conversation_id)) {
        // Brand-new conversation this session hasn't listed yet — pick it up
        // with a single refetch triggered by this real event, not a timer.
        fetchConversations();
        return;
      }

      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation_id === msg.conversation_id);
        if (idx === -1) return prev;

        const existing = prev[idx];
        const next = [...prev];
        next[idx] = {
          ...existing,
          last_message: messageText || existing.last_message,
          last_message_at: msg.created_at || existing.last_message_at,
          updated_at: msg.created_at || existing.updated_at,
          last_direction: msg.direction || existing.last_direction,
          // Same counting rule fetchConversations already uses — only
          // increment unread_count for a message explicitly marked unread.
          messages_count: (existing.messages_count || 0) + 1,
          unread_count: msg.is_read === false ? (existing.unread_count || 0) + 1 : existing.unread_count,
        };
        next.sort((a, b) => new Date(b.last_message_at || b.updated_at || 0) - new Date(a.last_message_at || a.updated_at || 0));
        return next;
      });
    } catch (err) {
      console.error("Realtime message handling failed:", err);
    }
  }

  // Realtime subscription: INSERT events on public.messages, scoped to this
  // client only (tenant isolation — the same boundary every other query in
  // this file already applies via .eq("client_id", clientId)). No polling
  // interval anywhere in this file; this channel is the only mechanism that
  // reveals new messages without a manual refresh. Torn down on unmount and
  // whenever clientId changes, so a client switch never leaves a stale
  // subscription listening for another tenant's messages.
  //
  // Wrapped defensively and given a status callback: none of this can
  // legitimately throw synchronously during render (the whole effect body
  // is gated behind `if (!clientId) return`), but if the Supabase project's
  // `messages` table isn't in the Realtime publication, or the socket
  // fails to connect, .subscribe()'s status callback is the only way to
  // find out — previously this failed completely silently, indistinguishable
  // from "no new messages happened yet".
  useEffect(() => {
    if (!clientId) return;

    let channel;
    try {
      channel = supabase
        .channel(`messages-client-${clientId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: `client_id=eq.${clientId}` },
          (payload) => handleRealtimeMessage(payload.new)
        )
        .subscribe((subStatus, err) => {
          if (subStatus === "CHANNEL_ERROR" || subStatus === "TIMED_OUT" || err) {
            console.error("Realtime messages subscription failed:", subStatus, err);
          }
        });
    } catch (err) {
      console.error("Realtime messages subscription could not be created:", err);
      return;
    }

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    selectedConversationIdRef.current = selectedConversationId;

    // Switching conversations abandons any in-progress draft/error for the
    // previous one rather than carrying it over to the newly selected chat.
    setDraft("");
    setSendError("");

    if (selectedConversationId) {
      fetchConversationMessages(selectedConversationId);
      fetchSelectedLead(selectedConversationId);
    } else {
      setConversationMessages([]);
      setSelectedLead(null);
    }
  }, [selectedConversationId]);

  function handleMessagesScroll() {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;
  }

  // Jump to the latest message whenever a (new) conversation finishes loading.
  // If the user is mid-conversation and already scrolled near the bottom,
  // keep following new messages; if they scrolled up to read older ones,
  // leave their scroll position alone.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el || conversationMessages.length === 0) return;
    const conversationChanged = lastLoadedConversationRef.current !== selectedConversationId;
    lastLoadedConversationRef.current = selectedConversationId;
    if (conversationChanged || isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      isNearBottomRef.current = true;
    }
  }, [conversationMessages, selectedConversationId]);

  const selectedConversation = filteredConversations.find((c) => c.conversation_id === selectedConversationId) || null;
  const conversationStatus = selectedConversation?.conversation_status || "active";

  // Human Takeover ownership (display/UX layer only — the authoritative
  // check is server-side in api/human-reply.js and api/conversation-status.js).
  // A conversation not in the human queue has no owner concept and is
  // always controllable, matching pre-existing behavior. Once
  // waiting_human, only the assigned employee may reply/close — and if
  // nobody has claimed it yet (assigned_user_id null), that correctly
  // evaluates to "not me" for everyone, blocking the composer/Close button
  // until someone claims it.
  const isWaitingHuman = conversationStatus === "waiting_human";
  const isOwnedByMe = !!selectedConversation?.assigned_user_id && selectedConversation.assigned_user_id === user?.id;
  const canControlConversation = !isWaitingHuman || isOwnedByMe;

  const stats = useMemo(() => ({
    total: conversations.length,
    active: conversations.filter((c) => ["active", "open"].includes(c.conversation_status)).length,
    closed: conversations.filter((c) => c.conversation_status === "closed").length,
    leads: conversations.filter((c) => c.has_lead).length,
  }), [conversations]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-end">
        <button onClick={fetchConversations} className="inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50">↻ {t("common.refresh")}</button>
      </div>

      {error && <div className="shrink-0 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="flex h-full min-h-0 flex-col border-l border-slate-100 bg-slate-50/50">
          <div className="shrink-0 border-b border-slate-100 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-slate-950">{t("messagesPage.listTitle")}</h2>
                <p className="mt-1 text-xs text-slate-500">{t("messagesPage.countSuffix", { count: filteredConversations.length })}</p>
              </div>
              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">Live</span>
            </div>

            <div className="space-y-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("messagesPage.searchPlaceholder")} className="h-9 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50" />
              <div className="grid grid-cols-2 gap-2">
                <select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-300">
                  <option value="all">{t("messagesPage.allChannels")}</option>
                  <option value="facebook">Facebook</option>
                  <option value="telegram">Telegram</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="instagram">Instagram</option>
                </select>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-indigo-300">
                  <option value="all">{t("messagesPage.allStatuses")}</option>
                  <option value="active">{t("messagesPage.statusActive")}</option>
                  <option value="open">{t("messagesPage.statusOpen")}</option>
                  <option value="closed">{t("messagesPage.statusClosed")}</option>
                  <option value="lead_captured">{t("navigation.leads")}</option>
                  <option value="waiting_human">{t("common.waitingHuman")}</option>
                </select>
              </div>
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={leadsOnly} onChange={(e) => setLeadsOnly(e.target.checked)} />
                {t("messagesPage.leadsOnlyFilter")}
              </label>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            {loadingConversations ? (
              <div className="p-8 text-center text-sm text-slate-500">{t("messagesPage.loadingConversations")}</div>
            ) : filteredConversations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">{t("messagesPage.noMatchingConversations")}</div>
            ) : (
              filteredConversations.map((conv) => {
                const isActive = conv.conversation_id === selectedConversationId;
                const platformClass = platformStyles[(conv.channel || conv.platform || "").toLowerCase()] || "border-slate-200 bg-slate-50 text-slate-600";
                const statusClass = statusStyles[conv.conversation_status] || "bg-slate-100 text-slate-600 border-slate-200";

                return (
                  <button key={conv.conversation_id} onClick={() => setSelectedConversationId(conv.conversation_id)} className={`mb-1.5 w-full rounded-xl border p-2 text-right transition ${isActive ? "border-indigo-200 bg-white shadow-sm ring-4 ring-indigo-50" : "border-transparent hover:border-slate-200 hover:bg-white"}`}>
                    <div className="flex items-start gap-3">
      <ChannelIcon channel={conv.channel || conv.platform} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-bold text-slate-950">{conv.lead_name || conv.sender || conv.sender_id || t("common.noName")}</p>
                          <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(conv.last_message_at || conv.updated_at, t)}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{conv.last_message || t("messagesPage.noMessageYet")}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${platformClass}`}>{conv.channel || conv.platform || t("messagesPage.unknownChannel")}</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusClass}`}>{conv.conversation_status || "active"}</span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{t("messagesPage.messagesCountSuffix", { count: conv.messages_count })}</span>
                          {conv.unread_count > 0 && (
                            <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-bold text-white">{t("messagesPage.unreadCountSuffix", { count: conv.unread_count })}</span>
                          )}
                          {conv.assigned_user_id && (
                            <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
                              {t("messagesPage.claimedByPrefix", { name: conv.assigned_user?.name || t("roles.agent") })}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-white">
          {!selectedConversation ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">{t("messagesPage.selectConversationPrompt")}</div>
          ) : (
            <>
              <div className="shrink-0 border-b border-slate-100 p-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex items-start gap-3">
                    <ChannelIcon channel={selectedConversation.channel || selectedConversation.platform} size="h-10 w-10" />
                    <div>
                      <h2 className="text-base font-bold text-slate-950">{selectedLead?.name || selectedConversation.lead_name || selectedConversation.sender || selectedConversation.sender_id || t("common.noName")}</h2>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">{selectedConversation.channel || selectedConversation.platform || t("messagesPage.unknownChannel")}</span>
                        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusStyles[selectedConversation.conversation_status] || "bg-slate-100 text-slate-600 border-slate-200"}`}>{selectedConversation.conversation_status || "active"}</span>
                        <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">{t("messagesPage.messagesCountSuffix", { count: conversationMessages.length })}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    {conversationStatus === "waiting_human" && !selectedConversation.assigned_user_id && (
                      <>
                        <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700">{t("common.waitingHuman")}</span>
                        <button
                          onClick={() => claimConversation(selectedConversation.conversation_id)}
                          disabled={claimingId === selectedConversation.conversation_id}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:opacity-50"
                        >
                          {claimingId === selectedConversation.conversation_id ? t("messagesPage.claiming") : t("messagesPage.claimConversation")}
                        </button>
                      </>
                    )}
                    {conversationStatus === "waiting_human" && selectedConversation.assigned_user_id && (
                      <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
                        {t("messagesPage.claimedByFullPrefix", { name: selectedConversation.assigned_user?.name || t("roles.agent") })}
                      </span>
                    )}
                    {conversationStatus !== "waiting_human" && conversationStatus !== "closed" && (
                      <button onClick={takeoverConversation} disabled={updatingStatus} className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:opacity-50">{t("common.transferToAgent")}</button>
                    )}
                    {conversationStatus !== "closed" && canControlConversation && (
                      <button onClick={closeConversation} disabled={updatingStatus} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:opacity-50">{t("common.close")}</button>
                    )}
                    {conversationStatus === "closed" && (
                      <button onClick={reopenConversation} disabled={updatingStatus} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:opacity-50">{t("messagesPage.reopenConversation")}</button>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-slate-500">{t("messagesPage.leadLabelPrefix")}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">{selectedLead?.name || t("common.noName")}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">{selectedLead?.phone || t("messagesPage.noPhone")}</span>
                </div>
              </div>

              <div ref={messagesScrollRef} onScroll={handleMessagesScroll} className="min-h-0 flex-1 overflow-y-auto bg-slate-50/40 p-3">
                {loadingMessages ? (
                  <div className="p-8 text-center text-sm text-slate-500">{t("messagesPage.loadingMessages")}</div>
                ) : conversationMessages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">{t("messagesPage.noMessagesForConversation")}</div>
                ) : (
                  <div className="space-y-2.5">
                    {conversationMessages.map((msg) => {
                      const isInbound = ["inbound", "in"].includes(msg.direction);
                      return (
                        <div key={msg.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
                          <div className={`max-w-[58%] rounded-2xl px-3.5 py-2.5 shadow-sm ${isInbound ? "rounded-tr-lg border border-slate-200 bg-white text-slate-800" : "rounded-tl-lg bg-indigo-600/95 text-white shadow-indigo-100"}`}>
                            <div className="mb-1.5 flex items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isInbound ? "bg-slate-100 text-slate-500" : "bg-white/15 text-white"}`}>{directionLabel(msg.direction, t)}</span>
                              <span className={`text-[11px] ${isInbound ? "text-slate-400" : "text-indigo-100"}`}>{formatDate(msg.created_at, i18n.language)}</span>
                            </div>
                            <div className="whitespace-pre-wrap break-words text-sm leading-6">{msg.message_text || getMessageText(msg) || "—"}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="shrink-0 border-t border-slate-100 bg-white p-3">
                {sendError && (
                  <div className="mb-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                    {sendError}
                  </div>
                )}

                {!canControlConversation && (
                  <div className="mb-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                    {selectedConversation.assigned_user_id
                      ? t("messagesPage.claimedByNotice", { name: selectedConversation.assigned_user?.name || t("roles.agent") })
                      : t("messagesPage.mustClaimFirst")}
                  </div>
                )}

                <div className="flex items-end gap-2">
                  {/* Prepared for future media sending — not wired to any send
                      path yet. Kept visibly disabled so the composer's
                      architecture is ready without faking a capability the
                      channel/n8n side doesn't support today. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {MEDIA_CONTROLS.map(({ key, labelKey, icon: Icon }) => (
                      <button
                        key={key}
                        type="button"
                        disabled
                        title={t("messagesPage.mediaComingSoon", { label: t(labelKey) })}
                        className="flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed"
                      >
                        <Icon className="h-5 w-5" />
                      </button>
                    ))}
                  </div>

                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    disabled={sending || !canControlConversation}
                    placeholder={canControlConversation ? t("messagesPage.composerPlaceholderEnabled") : t("messagesPage.composerPlaceholderDisabled")}
                    rows={2}
                    className="min-h-[44px] max-h-40 flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-400"
                  />

                  <button
                    type="button"
                    onClick={sendHumanReply}
                    disabled={sending || !draft.trim() || !canControlConversation}
                    className="h-11 shrink-0 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {sending ? t("messagesPage.sending") : t("messagesPage.send")}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
