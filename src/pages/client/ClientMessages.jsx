import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftIcon, PhotoIcon, DocumentIcon, MicrophoneIcon, XMarkIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import ChannelIcon from "../../lib/channelIcons.jsx";
import {
  MESSAGE_TYPES,
  isMediaMessageType,
  getAcceptAttribute,
  formatFileSize,
  validateMediaFile,
  canSendMediaOnChannel,
  canSendMediaTypeOnChannel,
} from "../../lib/mediaMessages.js";
import { getConversationIdentity } from "../../lib/conversationIdentity.js";

// Media controls — WhatsApp Media & Attachment Support v1. `type` maps each
// button to a canonical MESSAGE_TYPES value (single source of truth for
// both the composer below and the message renderer, which reuses this
// same array to resolve a media message's icon/label). Enabled per
// conversation by canSendMediaOnChannel() — see
// SUPPORTED_MEDIA_CHANNEL_VALUES in src/lib/mediaMessages.js for exactly
// which channel values are enabled (currently whatsapp/facebook/telegram)
// and always false for any other/unknown channel. WhatsApp/Evolution is
// the only channel with runtime-verified end-to-end n8n media delivery —
// Facebook/Telegram controls are enabled here for controlled testing while
// their own Human Reply MEDIA DRAFT delivery is completed.
const MEDIA_CONTROLS = [
  { key: "image", type: MESSAGE_TYPES.IMAGE, labelKey: "messagesPage.mediaImage", icon: PhotoIcon },
  { key: "document", type: MESSAGE_TYPES.DOCUMENT, labelKey: "messagesPage.mediaDocument", icon: DocumentIcon },
  { key: "voice", type: MESSAGE_TYPES.AUDIO, labelKey: "messagesPage.mediaVoice", icon: MicrophoneIcon },
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

// True when a real (server) message row is the persisted form of a pending
// optimistic echo — an outbound row, at/after the echo's own timestamp,
// with the same text (or, for a media-only send, the same type + file).
// Used both to hide the echo the instant the real row arrives and to drop
// it from pendingOutbound. A 5s slack absorbs client/server clock skew.
function outboundRowMatchesPending(row = {}, pending = {}) {
  if (!["out", "outbound"].includes(row.direction)) return false;
  const rowAt = new Date(row.created_at).getTime();
  const pendAt = new Date(pending.created_at).getTime();
  if (!Number.isFinite(rowAt) || !Number.isFinite(pendAt) || rowAt < pendAt - 5000) return false;
  const rowText = (row.message_text ?? getMessageText(row) ?? "").trim();
  const pendText = (pending.message ?? "").trim();
  if (pendText) return rowText === pendText;
  return (
    row.message_type === pending.message_type &&
    (!pending.media_file_name || row.media_file_name === pending.media_file_name)
  );
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

// Resolves and caches a short-lived signed READ url for one media message,
// then renders the actual media (image/audio) or a compact file card
// (document). Extracted as its own component so each message manages its
// own request/cache lifecycle independently — WhatsApp Media & Attachment
// Support v1 Phase B. Never invoked for message_type "text" or a
// historical/null message_type (see the isMedia guard at the call site) —
// those keep rendering exactly as before, unchanged.
//
// If Storage isn't configured/created yet (see api/media.js (action: "sign_read") —
// this is the expected state right now, since Task 1 explicitly does not
// create the bucket), the fetch below resolves to success:false and this
// simply shows the existing "unavailable" placeholder — it never throws or
// breaks the surrounding message list.
function MediaAttachment({ msg, mediaControl, isInbound, conversationId, actorUserId, t }) {
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  // Distinguishes "Storage isn't set up yet" (the expected state right now
  // — see api/media.js (action: "sign_read")'s STORAGE_NOT_CONFIGURED/STORAGE_UNAVAILABLE
  // codes) from any other failure, so the placeholder can say so instead of
  // a generic "failed to load" that would be misleading before Storage
  // exists at all.
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  // Cached in a ref, not state — updating it must never itself trigger a
  // re-render; `status` alone drives rendering, and reading the ref during
  // render for the ready case is safe because both are always set together.
  const cacheRef = useRef({ url: "", expiresAt: 0 });
  const MediaIcon = mediaControl?.icon;
  const isImage = msg.message_type === MESSAGE_TYPES.IMAGE;
  const isAudio = msg.message_type === MESSAGE_TYPES.AUDIO;

  async function resolveUrl() {
    if (!msg.media_path) return null;
    if (cacheRef.current.url && Date.now() < cacheRef.current.expiresAt) {
      return cacheRef.current.url;
    }
    setStatus("loading");
    setStorageUnavailable(false);
    try {
      const response = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign_read",
          conversation_id: conversationId,
          actor_user_id: actorUserId,
          media_path: msg.media_path,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false || !data?.url) {
        setStatus("error");
        setStorageUnavailable(data?.code === "STORAGE_NOT_CONFIGURED" || data?.code === "STORAGE_UNAVAILABLE");
        return null;
      }
      // Small safety buffer (10s) so the cached URL is never handed out
      // right as it's about to expire.
      const ttlMs = Math.max(0, (Number(data.expires_in) || 60) - 10) * 1000;
      cacheRef.current = { url: data.url, expiresAt: Date.now() + ttlMs };
      setStatus("ready");
      return data.url;
    } catch {
      setStatus("error");
      return null;
    }
  }

  // Images/audio need a src up front to render inline, so resolve as soon
  // as this message mounts (or its media_path changes — it never does in
  // practice, but this keeps the effect correct if it ever did). Documents
  // resolve lazily on click instead (see handleOpenDocument), since a file
  // card renders fine without ever fetching a URL if the user never opens
  // it — this is the "avoid unnecessary repeated requests" behavior.
  useEffect(() => {
    cacheRef.current = { url: "", expiresAt: 0 };
    if (!msg.media_path) {
      setStatus("error");
      return;
    }
    setStatus("idle");
    if (isImage || isAudio) resolveUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.media_path, msg.message_type]);

  async function handleOpenDocument() {
    const url = await resolveUrl();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  const mutedClass = isInbound ? "text-slate-400" : "text-indigo-100";
  const cardClass = isInbound ? "border-slate-200 bg-slate-50" : "border-white/20 bg-white/10";

  const errorText = storageUnavailable ? t("messagesPage.storageUnavailable") : t("messagesPage.mediaLoadFailed");

  if (isImage) {
    if (status === "ready" && cacheRef.current.url) {
      return (
        <img
          src={cacheRef.current.url}
          alt={msg.media_file_name || ""}
          className="mb-1.5 max-h-64 w-full rounded-xl border border-slate-200 object-cover"
        />
      );
    }
    return (
      <div className={`mb-1.5 flex h-28 items-center justify-center rounded-xl border p-2 text-xs font-semibold ${cardClass} ${mutedClass}`}>
        {status === "error" ? (
          <button type="button" onClick={resolveUrl} className="underline">
            {errorText} · {t("messagesPage.retry")}
          </button>
        ) : (
          t("messagesPage.mediaLoading")
        )}
      </div>
    );
  }

  if (isAudio) {
    if (status === "ready" && cacheRef.current.url) {
      return <audio controls src={cacheRef.current.url} className="mb-1.5 w-full" />;
    }
    return (
      <div className={`mb-1.5 flex items-center gap-2 rounded-xl border p-2 text-xs font-semibold ${cardClass} ${mutedClass}`}>
        {status === "error" ? (
          <button type="button" onClick={resolveUrl} className="underline">
            {errorText} · {t("messagesPage.retry")}
          </button>
        ) : (
          t("messagesPage.mediaLoading")
        )}
      </div>
    );
  }

  // document (also the safe default for any unexpected media message_type
  // — never crashes, always falls back to the same compact card)
  return (
    <div className={`mb-1.5 flex items-center gap-2 rounded-xl border p-2 ${cardClass}`}>
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isInbound ? "bg-white text-slate-400" : "bg-white/15 text-white"}`}>
        {MediaIcon && <MediaIcon className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold">{msg.media_file_name || (mediaControl ? t(mediaControl.labelKey) : "")}</p>
        <p className={`text-[11px] ${mutedClass}`}>{formatFileSize(msg.media_size_bytes) || t("messagesPage.mediaPreviewUnavailable")}</p>
      </div>
      <button
        type="button"
        onClick={handleOpenDocument}
        disabled={status === "loading"}
        className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold transition ${isInbound ? "text-indigo-600 hover:bg-indigo-100" : "text-white hover:bg-white/10"} disabled:opacity-50`}
      >
        {status === "loading" ? t("messagesPage.mediaLoading") : status === "error" ? t("messagesPage.retry") : t("messagesPage.openFile")}
      </button>
    </div>
  );
}

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

// Conversation Card V1 — lifecycle/context summary + internal notes, shown
// beside the chat (desktop) or as a drawer (tablet/mobile, see the
// `variant`/`open`/`onClose` props). Entirely self-contained: fetches its
// own data from /api/conversation (details + ?resource=notes) whenever
// `conversationId` changes, independent of the conversations list state
// ClientMessages itself already holds (that list only carries the small
// subset of fields needed for badges — this card needs the fuller
// lifecycle/notes detail those two endpoints alone provide). Conversation
// Type/category is deliberately absent — out of scope for V1, deferred to
// the future Conversation Session Model redesign.
function ConversationCard({ conversationId, actorUserId, variant, open, onClose }) {
  const { t } = useTranslation();

  const [card, setCard] = useState(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState("");

  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState("");

  const [noteDraft, setNoteDraft] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingBody, setEditingBody] = useState("");
  const [savingNoteId, setSavingNoteId] = useState(null);
  const [deletingNoteId, setDeletingNoteId] = useState(null);

  useEffect(() => {
    if (!conversationId || !actorUserId) {
      setCard(null);
      setNotes([]);
      return;
    }

    let cancelled = false;
    setCard(null);
    setCardError("");
    setCardLoading(true);
    setNotes([]);
    setNotesError("");
    setNotesLoading(true);
    setNoteDraft("");
    setEditingNoteId(null);

    const qs = `actor_user_id=${encodeURIComponent(actorUserId)}&conversation_id=${encodeURIComponent(conversationId)}`;

    fetch(`/api/conversation?${qs}`)
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (cancelled) return;
        if (!data?.success) throw new Error(data?.message || t("conversationCard.loadFailed"));
        setCard(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        setCardError(err.message || t("conversationCard.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setCardLoading(false);
      });

    fetch(`/api/conversation?resource=notes&${qs}`)
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (cancelled) return;
        if (!data?.success) throw new Error(data?.message || t("conversationCard.notesLoadFailed"));
        setNotes(data.notes || []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        setNotesError(err.message || t("conversationCard.notesLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setNotesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, actorUserId]);

  async function handleAddNote() {
    const body = noteDraft.trim();
    if (!body || addingNote) return;

    setAddingNote(true);
    setNotesError("");
    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_note", actor_user_id: actorUserId, conversation_id: conversationId, body }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw new Error(data?.message || t("conversationCard.noteAddFailed"));
      setNotes((prev) => [data.note, ...prev]);
      setNoteDraft("");
    } catch (err) {
      console.error(err);
      setNotesError(err.message || t("conversationCard.noteAddFailed"));
    } finally {
      setAddingNote(false);
    }
  }

  function startEditNote(note) {
    setEditingNoteId(note.id);
    setEditingBody(note.body);
  }

  function cancelEditNote() {
    setEditingNoteId(null);
    setEditingBody("");
  }

  async function saveEditNote(noteId) {
    const body = editingBody.trim();
    if (!body || savingNoteId) return;

    setSavingNoteId(noteId);
    setNotesError("");
    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit_note", actor_user_id: actorUserId, note_id: noteId, body }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw new Error(data?.message || t("conversationCard.noteEditFailed"));
      setNotes((prev) => prev.map((n) => (n.id === noteId ? data.note : n)));
      cancelEditNote();
    } catch (err) {
      console.error(err);
      setNotesError(err.message || t("conversationCard.noteEditFailed"));
    } finally {
      setSavingNoteId(null);
    }
  }

  async function deleteNote(noteId) {
    if (deletingNoteId || !window.confirm(t("conversationCard.confirmDeleteNote"))) return;

    setDeletingNoteId(noteId);
    setNotesError("");
    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_note", actor_user_id: actorUserId, note_id: noteId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw new Error(data?.message || t("conversationCard.noteDeleteFailed"));
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch (err) {
      console.error(err);
      setNotesError(err.message || t("conversationCard.noteDeleteFailed"));
    } finally {
      setDeletingNoteId(null);
    }
  }

  function timelineEventLabel(event) {
    const actor = event.actor_user?.name || t("roles.agent");
    const target = event.target_user?.name || t("roles.agent");
    const translated = t(`conversationCard.event.${event.event_type}`, { actor, target, defaultValue: "" });
    return translated || event.event_type;
  }

  const conv = card?.conversation || null;
  const lastEmployee = card?.last_employee || null;
  const timeline = card?.timeline || [];

  const content = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-100 p-3">
        <h2 className="font-bold text-slate-950">{t("conversationCard.title")}</h2>
        {variant === "drawer" && (
          <button type="button" onClick={onClose} aria-label={t("conversationCard.closePanel")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
            <XMarkIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {cardLoading && <p className="text-xs text-slate-400">{t("common.loading")}</p>}
        {cardError && <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{cardError}</p>}

        {conv && (
          <div className="space-y-4">
            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{t("conversationCard.sectionConversation")}</h3>
              <div className="mt-1.5 space-y-1 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{t("conversationCard.status")}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusStyles[conv.conversation_status] || "bg-slate-100 text-slate-600 border-slate-200"}`}>{conv.conversation_status || "active"}</span>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-slate-500">{t("conversationCard.lastActivity")}</span>
                  <span className="min-w-0 flex-1 break-words text-end font-semibold text-slate-700">{relativeTime(conv.updated_at, t)}</span>
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{t("conversationCard.sectionAssignment")}</h3>
              <div className="mt-1.5 space-y-1 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-slate-500">{t("conversationCard.systemSuggested")}</span>
                  <span className="min-w-0 flex-1 break-words text-end font-semibold text-slate-700">{conv.system_assigned_user?.name || "—"}</span>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-slate-500">{t("conversationCard.acceptedAssigned")}</span>
                  <span className="min-w-0 flex-1 break-words text-end font-semibold text-slate-700">
                    {conv.assigned_user_id ? (conv.assigned_user_id === actorUserId ? t("common.you") : conv.assigned_user?.name || t("roles.agent")) : t("messagesPage.unassigned")}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-slate-500">{t("conversationCard.lastEmployee")}</span>
                  <span className="min-w-0 flex-1 break-words text-end font-semibold text-slate-700">
                    {lastEmployee ? (lastEmployee.user?.id === actorUserId ? t("common.you") : lastEmployee.user?.name || t("roles.agent")) : "—"}
                    {lastEmployee && lastEmployee.source !== "event" && (
                      <span className="block text-[10px] font-normal text-slate-400">{t("conversationCard.lastEmployeeApproximate")}</span>
                    )}
                  </span>
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{t("conversationCard.sectionLifecycle")}</h3>
              <div className="mt-1.5 space-y-1 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-slate-500">{t("conversationCard.solvedBy")}</span>
                  <span className="min-w-0 flex-1 break-words text-end font-semibold text-slate-700">{conv.solved_by_user?.name ? `${conv.solved_by_user.name} · ${relativeTime(conv.solved_at, t)}` : "—"}</span>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-slate-500">{t("conversationCard.reopenedBy")}</span>
                  <span className="min-w-0 flex-1 break-words text-end font-semibold text-slate-700">{conv.reopened_by_user?.name ? `${conv.reopened_by_user.name} · ${relativeTime(conv.reopened_at, t)}` : "—"}</span>
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{t("conversationCard.sectionTimeline")}</h3>
              {timeline.length === 0 ? (
                <p className="mt-1.5 text-xs text-slate-400">{t("conversationCard.noEvents")}</p>
              ) : (
                <ul className="mt-1.5 space-y-2">
                  {timeline.map((event) => (
                    <li key={event.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-1.5 text-xs">
                      <p className="font-semibold text-slate-700">{timelineEventLabel(event)}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">{relativeTime(event.created_at, t)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <section className="mt-4 border-t border-slate-100 pt-3">
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{t("conversationCard.sectionNotes")}</h3>
          <p className="mt-1 text-[11px] text-slate-400">{t("conversationCard.notesHint")}</p>

          {notesError && <p className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{notesError}</p>}

          <div className="mt-2 space-y-2">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={t("conversationCard.noteAddPlaceholder")}
              rows={2}
              className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
            />
            <button
              type="button"
              onClick={handleAddNote}
              disabled={!noteDraft.trim() || addingNote}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm disabled:opacity-50"
            >
              {addingNote ? t("conversationCard.adding") : t("conversationCard.addNote")}
            </button>
          </div>

          {notesLoading ? (
            <p className="mt-3 text-xs text-slate-400">{t("common.loading")}</p>
          ) : notes.length === 0 ? (
            <p className="mt-3 text-xs text-slate-400">{t("conversationCard.noNotes")}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {notes.map((note) => (
                <li key={note.id} className="rounded-xl border border-slate-100 bg-white p-2.5 text-sm shadow-sm">
                  {editingNoteId === note.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={editingBody}
                        onChange={(e) => setEditingBody(e.target.value)}
                        rows={2}
                        className="w-full resize-none rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
                      />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => saveEditNote(note.id)} disabled={!editingBody.trim() || savingNoteId === note.id} className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50">
                          {savingNoteId === note.id ? t("conversationCard.saving") : t("conversationCard.save")}
                        </button>
                        <button type="button" onClick={cancelEditNote} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50">
                          {t("conversationCard.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap text-slate-700">{note.body}</p>
                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                        <span>
                          {note.author?.name || t("roles.agent")} · {relativeTime(note.created_at, t)}
                          {note.updated_at && ` · ${t("conversationCard.editedSuffix")}`}
                        </span>
                        {note.author_user_id === actorUserId && (
                          <span className="flex shrink-0 gap-2">
                            <button type="button" onClick={() => startEditNote(note)} className="font-bold text-indigo-600 hover:underline">
                              {t("conversationCard.edit")}
                            </button>
                            <button type="button" onClick={() => deleteNote(note.id)} disabled={deletingNoteId === note.id} className="font-bold text-red-600 hover:underline disabled:opacity-50">
                              {t("conversationCard.delete")}
                            </button>
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );

  if (variant === "drawer") {
    return (
      <div className={`fixed inset-0 z-40 xl:hidden ${open ? "flex" : "hidden"}`}>
        <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
        <div className="relative ms-auto flex h-full w-full max-w-sm flex-col bg-white shadow-xl">{content}</div>
      </div>
    );
  }

  return content;
}

export default function ClientMessages() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  // client_id is resolved once at login via client_users (see Login.jsx).
  const clientId = user?.client_id || null;

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [conversationMessages, setConversationMessages] = useState([]);
  // Optimistic echo of a just-sent human reply. The server (n8n) is the
  // source of truth — it delivers the message AND inserts the row — but
  // that round trip can take a few seconds, so the employee's own message
  // is shown immediately and removed again the moment the real row shows
  // up in a poll (matched by outboundRowMatchesPending). Cleared on
  // conversation switch. Never inserted into `messages`.
  const [pendingOutbound, setPendingOutbound] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);
  // True only when this client has more than one distinct WhatsApp
  // channel_key among its current conversations — see fetchConversations.
  // Drives the small "WhatsApp: <number/instance name>" identifier so a
  // single-WhatsApp-number client's UI stays exactly as it looks today.
  const [multipleWhatsappNumbers, setMultipleWhatsappNumbers] = useState(false);

  // Below md, which single Inbox pane is showing — "list" or "chat" —
  // deliberately kept separate from selectedConversationId (which is only
  // ever "which conversation's content is loaded", the same on every
  // viewport). Mixing the two caused mobile to open straight into Chat
  // whenever a conversation got auto-selected (initial load, a realtime
  // refetch, a filter change) — none of that is a user asking to see a
  // chat. Only an explicit tap on a conversation (or the Back button) may
  // change this; see the aside/section render below for how it gates
  // mobile-only visibility, and the click/back handlers for the only two
  // places it's ever set. Ignored entirely at md+ (see those same render
  // classes), where both panes are always visible regardless of this value.
  const [mobileInboxView, setMobileInboxView] = useState("list");

  // Conversation Card V1 — below the 2xl breakpoint the card is a
  // drawer/sheet rather than a persistent pane (see the grid/aside render
  // below); this only controls whether that drawer is open. At 2xl+ the
  // card is always visible as its own grid column and this is ignored
  // (the info button that toggles it is itself hidden at 2xl+).
  const [cardOpen, setCardOpen] = useState(false);

  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [leadsOnly, setLeadsOnly] = useState(false);

  // Reply composer (Phase 2B): sends via /api/conversation (action:
  // "human_reply"), never inserts
  // into Supabase directly and never touches conversation_status/current_step.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const sendingRef = useRef(false);

  // Selected media attachment (WhatsApp Media & Attachment Support v1
  // foundation — file selection only, nothing is uploaded anywhere yet).
  // Shape: { type, file, previewUrl }. previewUrl is only set for images
  // (an object URL for the thumbnail) and is revoked below whenever it
  // changes or the component unmounts, so it never leaks memory.
  const [attachment, setAttachment] = useState(null);
  const fileInputRefs = useRef({});

  // Message pane scroll behavior: jump to the latest message when a
  // conversation is opened, but don't yank the view down if the user has
  // scrolled up to read older messages.
  const messagesScrollRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const lastLoadedConversationRef = useRef(null);
  const selectedConversationIdRef = useRef(null);

  // Revokes the previous attachment's object URL (if any) whenever the
  // attachment changes or the component unmounts — avoids leaking memory
  // across repeated select/remove cycles.
  useEffect(() => {
    return () => {
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, [attachment]);

  // Conversation Model Redesign — Client Portal read-model migration,
  // server-side read path. contacts/contact_channel_identities/
  // conversations have RLS enabled with zero browser policies (this app
  // has no Supabase Auth session, so the anon-keyed browser client can
  // never read them directly — this is intentional, not a bug to route
  // around client-side). This function no longer queries conversations,
  // contact_channel_identities, or client_whatsapp directly from the
  // browser at all: /api/conversation?resource=list performs the exact same merge
  // (conversations as the source of truth, one entry per conversation
  // id, never grouped/deduplicated by sender_id — see that file for the
  // full rationale) server-side on the service-role client, scoped to
  // the authenticated actor's own membership via actor_user_id (never a
  // client_id trusted from the browser), and returns the already-merged
  // shape below unchanged. messages/leads/Storage and every other query
  // in this file are untouched — only this list-loading query moved
  // server-side.
  // `silent: true` refetches the list in the background (used by the poll
  // that stands in for browser Realtime — see the polling effect below)
  // without toggling the list spinner or the page-level error banner.
  async function fetchConversations({ silent = false } = {}) {
    if (!clientId || !user?.id) return;

    try {
      if (!silent) {
        setLoadingConversations(true);
        setError("");
      }

      const response = await fetch(`/api/conversation?resource=list&actor_user_id=${encodeURIComponent(user.id)}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorFetchConversations"));
      }

      const merged = data.conversations || [];

      // Small identifier only appears once it's actually needed to
      // disambiguate — a client with a single WhatsApp number keeps
      // exactly today's appearance.
      const distinctWhatsappChannelKeys = new Set(
        merged.filter((c) => c.platform?.toLowerCase() === "whatsapp" && c.channel_key).map((c) => c.channel_key)
      );
      setMultipleWhatsappNumbers(distinctWhatsappChannelKeys.size > 1);

      setConversations(merged);
      // Auto-selecting the first conversation here is safe on every
      // viewport, including mobile: selectedConversationId is purely
      // "which conversation's content is loaded" — it no longer also
      // decides which mobile pane is showing (see mobileInboxView below,
      // and the aside/section render below that reads it instead). A
      // previous version of this fix gated this fallback by viewport via
      // window.matchMedia to work around selectedConversationId still
      // doing double duty; that's no longer needed now that the two
      // concerns are separate state.
      setSelectedConversationId((current) => (current && merged.some((c) => c.conversation_id === current) ? current : merged[0]?.conversation_id || null));
    } catch (err) {
      console.error(err);
      if (!silent) setError(t("messagesPage.errorFetchConversations"));
    } finally {
      if (!silent) setLoadingConversations(false);
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

      // Historical messages are read through the server-side, service-role
      // endpoint (Conversation Model V2 read-path cleanup) — a direct
      // browser supabase.from("messages") query here is subject to
      // `messages` RLS on the anon key and was silently returning an empty
      // set, so the center panel showed "no messages" for conversations
      // the (service-role) list endpoint had already counted correctly.
      // client_id is derived server-side from the actor's membership;
      // conversation_id stays the V2 conversations.id.
      const response = await fetch(
        `/api/conversation?resource=messages&actor_user_id=${encodeURIComponent(user?.id)}&conversation_id=${encodeURIComponent(conversationId)}`
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.message || t("messagesPage.errorFetchMessages"));
      }

      const data = payload.messages || [];
      const rows = data.map((m) => ({ ...m, message_text: getMessageText(m) }));
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
  // /api/conversation endpoint rather than writing conversation_state
  // directly from the browser — this used to be a direct Supabase write
  // with no actor/permission/ownership check at all, which meant a
  // non-assigned teammate could bypass the UI's disabled Close button
  // entirely by calling Supabase from devtools. The server now re-derives
  // client_id/permission and, for `close`, verifies the actor is the
  // conversation's assigned employee whenever it's already waiting_human
  // (see api/_lib/conversationLifecycle.js). `currentStep`/`preserveStep`/
  // `clearAssignment`/`assignToActor` only shape the *local* optimistic
  // patch to match what the server is known to have done for each action
  // — they don't control server behavior.
  async function applyStatusChange(action, newStatus, { currentStep = null, preserveStep = false, clearAssignment = false, assignToActor = false } = {}) {
    if (!selectedConversationId || !clientId) return;

    try {
      setUpdatingStatus(true);
      setError("");

      const response = await fetch("/api/conversation", {
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
      // Manual Reopen only: the employee performing the action becomes
      // both the current designated employee and the actual owner
      // immediately — there is no Smart Assignment step and no separate
      // Claim in this scenario (see reopenConversation below and
      // apply_conversation_lifecycle_action's 'reopen' action, which the
      // server has already applied identically before this response
      // returns).
      if (assignToActor) {
        const nowIso = new Date().toISOString();
        payload.assigned_user_id = user?.id || null;
        payload.assigned_at = nowIso;
        payload.system_assigned_user_id = user?.id || null;
        payload.system_assigned_at = nowIso;
      }

      setConversations((prev) =>
        prev.map((conv) =>
          conv.conversation_id === selectedConversationId
            ? {
                ...conv,
                ...payload,
                assigned_user: clearAssignment ? null : assignToActor ? { id: user?.id, name: user?.name } : conv.assigned_user,
                system_assigned_user: assignToActor ? { id: user?.id, name: user?.name } : conv.system_assigned_user,
              }
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
  // the conversation is already waiting_human (see api/_lib/conversationLifecycle.js).
  function closeConversation() {
    return applyStatusChange("close", "closed", { currentStep: "done" });
  }

  // Explicit reopen: conversation_status = waiting_human (Human Mode),
  // current_step = null. Clicking Reopen itself means "I am reopening and
  // taking this conversation" — there is no Smart Assignment step and no
  // separate Claim afterward; the employee performing Reopen becomes both
  // system_assigned_user_id and assigned_user_id immediately (assignToActor),
  // matching apply_conversation_lifecycle_action's 'reopen' action exactly.
  // Automation stays blocked (still waiting_human, unaffected by who owns
  // it). Only ever called from a closed conversation (see the button
  // below), which has no owner-concept yet, so this stays open to any
  // Inbox-eligible teammate — whoever clicks it becomes the owner.
  function reopenConversation() {
    return applyStatusChange("reopen", "waiting_human", { currentStep: null, assignToActor: true });
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
  // /api/conversation (action: "claim"), which performs a single conditional UPDATE
  // (... WHERE assigned_user_id IS NULL) so only one concurrent caller can
  // ever win — see that file for the full race-condition explanation. This
  // handler never assumes it won; it always reconciles local state with
  // whatever the API reports, whether that's success or "already claimed".
  async function claimConversation(conversationId) {
    if (!conversationId || claimingId) return;

    setClaimingId(conversationId);
    setError("");

    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim", conversation_id: conversationId, actor_user_id: user?.id }),
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

  // Opens the hidden file input for a media control. Only reachable when
  // canSendMedia is true (see the button's own disabled state below) —
  // this function itself doesn't re-check, matching how other UI-only
  // guards in this file already work (the real enforcement, once media
  // sending exists, will live server-side).
  function handleMediaButtonClick(key) {
    fileInputRefs.current[key]?.click();
  }

  // Validates the selected file against the centralized limits (see
  // src/lib/mediaMessages.js) and stores it as the pending attachment, or
  // shows a translated error and leaves the current draft/attachment
  // untouched. Never uploads anything — there is nowhere to upload to yet.
  function handleFileSelected(type, e) {
    const file = e.target.files?.[0];
    // Reset the input's value so selecting the exact same file again later
    // (e.g. after removing it) still fires onChange.
    e.target.value = "";
    if (!file) return;

    const result = validateMediaFile(type, file);
    if (!result.valid) {
      setSendError(
        result.reason === "too_large"
          ? t("messagesPage.errorFileTooLarge", { max: formatFileSize(result.maxBytes) })
          : t("messagesPage.errorUnsupportedFileType")
      );
      return;
    }

    setSendError("");
    setAttachment({
      type,
      file,
      previewUrl: type === MESSAGE_TYPES.IMAGE ? URL.createObjectURL(file) : null,
    });
  }

  function removeAttachment() {
    setAttachment(null);
    setSendError("");
  }

  // Uploads the selected attachment directly to Supabase Storage via a
  // short-lived signed URL minted server-side (api/media.js, action: "sign_upload" —
  // this function never touches the service-role key or any Storage admin
  // credential itself). Called from sendHumanReply only when the user
  // presses Send (never on file selection), so choosing then removing an
  // attachment never leaves an orphaned object in Storage.
  //
  // Returns the attachment metadata api/_lib/humanReply.js's media payload
  // needs (media_path/media_mime_type/media_file_name/media_size_bytes —
  // same names as the messages table's media_* columns).
  async function uploadAttachmentToStorage(conversationId, pendingAttachment) {
    const { file, type } = pendingAttachment;

    const urlResponse = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "sign_upload",
        conversation_id: conversationId,
        actor_user_id: user?.id,
        message_type: type,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      }),
    });

    const urlData = await urlResponse.json().catch(() => ({}));
    if (!urlResponse.ok || urlData?.success === false) {
      throw new Error(urlData?.message || t("messagesPage.errorUploadFailed"));
    }

    const { error: uploadError } = await supabase.storage
      .from(urlData.bucket)
      .uploadToSignedUrl(urlData.path, urlData.token, file);

    if (uploadError) {
      throw new Error(t("messagesPage.errorUploadFailed"));
    }

    return {
      media_path: urlData.path,
      media_mime_type: file.type,
      media_file_name: file.name,
      media_size_bytes: file.size,
    };
  }

  // Sends a human reply via the server-side proxy only. Must never insert
  // into `messages` directly and must never touch conversation_status /
  // current_step — those are owned by the explicit action buttons above.
  async function sendHumanReply() {
    const trimmed = draft.trim();
    if ((!trimmed && !attachment) || !selectedConversationId || sendingRef.current) return;
    // Mirrors the composer's own disabled state (see canControlConversation)
    // — belt-and-suspenders against any path that could still call this
    // directly. The server (api/_lib/humanReply.js) is the authoritative check.
    if (!canControlConversation) return;
    // Belt-and-suspenders mirror of the media controls' own disabled state
    // (canSendMedia — WhatsApp/Evolution only). The attachment can only be
    // selected via those controls, but api/_lib/humanReply.js is the actual
    // authoritative gate for Facebook/Telegram/unknown channels.
    if (attachment && !canSendMedia) {
      setSendError(t("messagesPage.mediaSendingUnavailable"));
      return;
    }
    // Per-channel type support (e.g. Instagram has no outbound document).
    if (attachment && !canSendMediaTypeOnChannel(selectedChannelValue, attachment.type)) {
      setSendError(t("messagesPage.mediaSendingUnavailable"));
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setSendError("");

    const conversationId = selectedConversationId;
    const previousCount = conversationMessages.length;
    const pendingAttachment = attachment;

    // Optimistic echo — shown immediately, reconciled away by the poll when
    // the real n8n-inserted row arrives (or removed here on send failure).
    const echoId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const echo = {
      id: echoId,
      conversation_id: conversationId,
      direction: "outbound",
      message: trimmed,
      message_text: trimmed,
      message_type: pendingAttachment ? pendingAttachment.type : MESSAGE_TYPES.TEXT,
      media_file_name: pendingAttachment ? pendingAttachment.file.name : null,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setPendingOutbound((prev) => [...prev, echo]);

    try {
      // Upload-on-send only (never on selection) — see
      // uploadAttachmentToStorage. If /api/conversation (human_reply) then fails, the
      // uploaded object is not deleted: this app has no client-safe delete
      // permission against the private chat-media bucket (only signed
      // upload/read URLs are ever minted, both scoped and short-lived), and
      // inventing one would weaken Storage security. That upload becomes an
      // orphan in this failure case — documented, not silently hidden.
      const media = pendingAttachment ? await uploadAttachmentToStorage(conversationId, pendingAttachment) : null;

      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "human_reply",
          conversation_id: conversationId,
          message: trimmed,
          actor_user_id: user?.id,
          message_type: pendingAttachment ? pendingAttachment.type : MESSAGE_TYPES.TEXT,
          ...(media || {}),
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("messagesPage.errorSendReply"));
      }

      setDraft("");
      setAttachment(null);
      refreshMessagesAfterSend(conversationId, previousCount);
    } catch (err) {
      console.error(err);
      // The send failed — drop the echo so the composer's error banner is
      // the only signal, and the employee can retry.
      setPendingOutbound((prev) => prev.filter((p) => p.id !== echoId));
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

  // New messages: lightweight background polling of the same server-side
  // endpoints the rest of this page already uses.
  //
  // Why not Supabase Realtime: this app has no Supabase Auth session — it
  // uses the anon key plus its own app-level auth (see
  // src/lib/supabaseClient.js and AuthContext), so `auth.uid()` is always
  // null for the browser client. public.messages RLS denies the anon role
  // (the same reason the historical message read had to move to the
  // service-role /api/conversation?resource=messages endpoint in commit
  // c4764e3), and Supabase Realtime `postgres_changes` only delivers a row
  // to a client that could SELECT it — so the previous
  // `.channel(...).on("postgres_changes", { table: "messages" })`
  // subscription received nothing and new messages never appeared without a
  // manual refresh. Restoring true Realtime would require either weakening
  // messages RLS for anon (a tenant-isolation regression — anyone could
  // read any client's messages) or minting per-user Supabase JWTs, neither
  // of which exists in this architecture. Polling the two service-role
  // endpoints keeps the tenant boundary intact.
  //
  // Two cadences: the open thread (5s) reveals new inbound/outbound
  // messages — including media rows, which flow through the exact same
  // fetchConversationMessages mapping and MediaAttachment renderer as a
  // historical load; the list (12s) surfaces new conversations, preview
  // text, counts and lifecycle changes. Both are silent (no spinner, no
  // error banner) and pause while the tab is hidden. selectedConversationId
  // is read from its ref so the interval never appends another
  // conversation's messages into the open thread.
  useEffect(() => {
    if (!clientId || !user?.id) return;

    const pollMessages = () => {
      if (document.hidden) return;
      const convId = selectedConversationIdRef.current;
      if (convId) fetchConversationMessages(convId, { silent: true });
    };
    const pollList = () => {
      if (document.hidden) return;
      fetchConversations({ silent: true });
    };
    const onVisible = () => {
      if (document.hidden) return;
      pollMessages();
      pollList();
    };

    const messagesTimer = setInterval(pollMessages, 5000);
    const listTimer = setInterval(pollList, 12000);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(messagesTimer);
      clearInterval(listTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, user?.id]);

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((conv) => {
      const haystack = `${conv.customer_name || ""} ${conv.sender || ""} ${conv.last_message || ""} ${conv.sender_id || ""} ${conv.lead_name || ""} ${conv.lead_phone || ""} ${conv.conversation_id || ""}`.toLowerCase();
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
    // Auto-selecting here (e.g. a filter change drops the current
    // selection) is safe on every viewport — see the note on
    // fetchConversations' own fallback above; this never touches
    // mobileInboxView, so it can never silently open the mobile chat pane.
    if (!exists) setSelectedConversationId(filteredConversations[0].conversation_id);
  }, [filteredConversations, selectedConversationId]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;

    // Switching conversations abandons any in-progress draft/error/
    // attachment/optimistic echo for the previous one rather than carrying
    // it over to the newly selected chat.
    setDraft("");
    setSendError("");
    setAttachment(null);
    setCardOpen(false);
    setPendingOutbound([]);

    if (selectedConversationId) {
      fetchConversationMessages(selectedConversationId);
      fetchSelectedLead(selectedConversationId);
    } else {
      setConversationMessages([]);
      setSelectedLead(null);
    }
  }, [selectedConversationId]);

  // Reconcile optimistic echoes against what the poll actually returned:
  // drop an echo once its persisted row is in conversationMessages, and
  // expire any straggler after 45s so a silently-dropped n8n insert can
  // never leave a phantom bubble accumulating across sends.
  useEffect(() => {
    if (pendingOutbound.length === 0) return;
    const now = Date.now();
    setPendingOutbound((prev) => {
      const next = prev.filter(
        (p) =>
          !conversationMessages.some((m) => outboundRowMatchesPending(m, p)) &&
          now - new Date(p.created_at).getTime() < 45000
      );
      return next.length === prev.length ? prev : next;
    });
  }, [conversationMessages, pendingOutbound.length]);

  // What the message pane actually renders: the server rows plus any
  // still-unconfirmed echo for THIS conversation (a matched echo is hidden
  // here immediately, even in the render before the reconcile effect runs).
  const visibleMessages = useMemo(() => {
    const stillPending = pendingOutbound.filter(
      (p) =>
        p.conversation_id === selectedConversationId &&
        !conversationMessages.some((m) => outboundRowMatchesPending(m, p))
    );
    return stillPending.length ? [...conversationMessages, ...stillPending] : conversationMessages;
  }, [conversationMessages, pendingOutbound, selectedConversationId]);

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
    if (!el || visibleMessages.length === 0) return;
    const conversationChanged = lastLoadedConversationRef.current !== selectedConversationId;
    lastLoadedConversationRef.current = selectedConversationId;
    if (conversationChanged || isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      isNearBottomRef.current = true;
    }
  }, [visibleMessages, selectedConversationId]);

  const selectedConversation = filteredConversations.find((c) => c.conversation_id === selectedConversationId) || null;
  const conversationStatus = selectedConversation?.conversation_status || "active";

  // Human Takeover ownership (display/UX layer only — the authoritative
  // check is server-side in api/_lib/humanReply.js and api/_lib/conversationLifecycle.js).
  // A conversation not in the human queue has no owner concept and is
  // always controllable, matching pre-existing behavior. Once
  // waiting_human, only the assigned employee may reply/close — and if
  // nobody has claimed it yet (assigned_user_id null), that correctly
  // evaluates to "not me" for everyone, blocking the composer/Close button
  // until someone claims it. A closed conversation is always read-only for
  // everyone, regardless of who was assigned before it closed — Reopen
  // (not Send) is the only available action until an employee explicitly
  // reopens it.
  const isWaitingHuman = conversationStatus === "waiting_human";
  const isClosedConversation = conversationStatus === "closed";
  const isOwnedByMe = !!selectedConversation?.assigned_user_id && selectedConversation.assigned_user_id === user?.id;
  const canControlConversation = !isClosedConversation && (!isWaitingHuman || isOwnedByMe);

  // Media & Attachment Support — see SUPPORTED_MEDIA_CHANNEL_VALUES in
  // src/lib/mediaMessages.js for exactly which channel values this allows
  // (whatsapp/facebook/telegram today). Any other/unknown channel value
  // stays false here.
  const canSendMedia = canSendMediaOnChannel(selectedConversation?.channel || selectedConversation?.platform);
  // Per-channel media-type support: Instagram has no outbound document
  // type (Meta), so its Document control is not rendered at all. Other
  // channels keep every control.
  const selectedChannelValue = selectedConversation?.channel || selectedConversation?.platform;
  const availableMediaControls = MEDIA_CONTROLS.filter((c) =>
    canSendMediaTypeOnChannel(selectedChannelValue, c.type)
  );

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

      {/* Three-tier responsive Inbox, coordinated with
          SharedDashboardLayout's sidebar breakpoint (also xl — see that
          file):
            - Below md (mobile): single stacked column. mobileInboxView
              (see its declaration above — deliberately NOT
              selectedConversationId, which stays "which conversation's
              content is loaded" on every viewport) toggles which of the
              two panes is visible — a classic responsive master/detail
              pattern, with the back button below returning to the list.
              Conversation Card is a drawer here (see cardOpen below), never
              a permanent third pane — it would leave no room for the chat.
            - md to xl (tablet): both panes visible side by side
              (md:grid-cols-[...]) at a slightly narrower list column, while
              the dashboard sidebar is still an off-canvas drawer (< xl), so
              the Inbox gets the full width instead of losing ~288px to a
              persistent sidebar it doesn't have room for. mobileInboxView
              is ignored here — the md:flex on the aside/section below
              always wins. Conversation Card is still a drawer here too.
            - xl+ (desktop): a third grid column appears (xl:grid-cols-[...])
              for the Conversation Card as a permanent ~300px pane —
              Sidebar | Conversation List | Chat | Conversation Card, per
              the approved design. This is the same breakpoint the
              dashboard sidebar itself becomes persistent at, so both
              appear together. The drawer/info-button variant is hidden
              here (xl:hidden on both) since the card is already always
              visible. List narrowed to 320px and card to 300px (down
              from an initial 380px/320px) specifically to give the Chat
              column (minmax(0,1fr), gets whatever's left) more breathing
              room at a real ~1360px desktop viewport — it already
              scrolls/wraps its own content, never forces the row
              wider. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        <aside className={`${mobileInboxView === "chat" ? "hidden md:flex" : "flex"} h-full min-h-0 flex-col border-e border-slate-100 bg-slate-50/50`}>
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

                // Explicit selection: the only two writers of
                // mobileInboxView are this click and the Back button below
                // — never fetches/realtime/filtering.
                return (
                  <button
                    key={conv.conversation_id}
                    onClick={() => {
                      setSelectedConversationId(conv.conversation_id);
                      setMobileInboxView("chat");
                    }}
                    className={`mb-1.5 w-full rounded-xl border p-2 text-start transition ${isActive ? "border-indigo-200 bg-white shadow-sm ring-4 ring-indigo-50" : "border-transparent hover:border-slate-200 hover:bg-white"}`}
                  >
                    <div className="flex items-start gap-3">
      <ChannelIcon channel={conv.channel || conv.platform} />
                      <div className="min-w-0 flex-1">
                        {(() => {
                          const idn = getConversationIdentity(conv);
                          return (
                            <>
                              <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-sm font-bold text-slate-950">{idn.primary || t("common.noName")}</p>
                                <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(conv.last_message_at || conv.updated_at, t)}</span>
                              </div>
                              {idn.secondary && <p className="truncate text-[11px] leading-4 text-slate-400" dir="ltr">{idn.secondary}</p>}
                            </>
                          );
                        })()}
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{conv.last_message || t("messagesPage.noMessageYet")}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${platformClass}`}>{conv.channel || conv.platform || t("messagesPage.unknownChannel")}</span>
                          {/* Only shown once a client actually has more than
                              one WhatsApp number connected -- see
                              multipleWhatsappNumbers in fetchConversations.
                              Plain literal label (not a translation key):
                              this is a small, additive identifier, not new
                              page copy, and keeps this change scoped to
                              this one file. */}
                          {multipleWhatsappNumbers && conv.platform?.toLowerCase() === "whatsapp" && conv.whatsapp_instance && (
                            <span className="rounded-full border border-teal-100 bg-teal-50 px-2 py-0.5 text-[11px] font-bold text-teal-700">
                              WhatsApp: {conv.whatsapp_instance.display_name || conv.whatsapp_instance.phone}
                            </span>
                          )}
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
                          {/* Smart Assignment V1 — a system RECOMMENDATION,
                              shown only while still unclaimed AND still
                              waiting_human. Deliberately a different color
                              (indigo, not emerald) from the "claimed by"
                              badge above so it never reads as final
                              ownership. Falls back to a neutral "Unassigned"
                              label when there is no recommendation either.
                              Gated on conversation_status too (not just
                              assigned_user_id) because neither solve nor
                              reopen clears system_assigned_user_id — an
                              active/closed/reopened conversation can still
                              carry a stale recommendation from a previous
                              waiting_human cycle that must not be shown
                              here. */}
                          {conv.conversation_status === "waiting_human" && !conv.assigned_user_id && (
                            conv.system_assigned_user_id ? (
                              <span className="rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">
                                {conv.system_assigned_user_id === user?.id
                                  ? t("messagesPage.systemSuggestedYou")
                                  : t("messagesPage.systemSuggestedPrefix", { name: conv.system_assigned_user?.name || t("roles.agent") })}
                              </span>
                            ) : (
                              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-bold text-slate-500">
                                {t("messagesPage.unassigned")}
                              </span>
                            )
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

        <section className={`${mobileInboxView === "chat" ? "flex" : "hidden md:flex"} min-h-0 flex-col bg-white`}>
          {!selectedConversation ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">{t("messagesPage.selectConversationPrompt")}</div>
          ) : (
            <>
              <div className="shrink-0 border-b border-slate-100 p-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    {/* Below md the list is its own pane (see aside above)
                        — this returns to it by switching mobileInboxView
                        back to "list", NOT by clearing
                        selectedConversationId (that stays "which
                        conversation's content is loaded" regardless of
                        which pane is showing, so the chat is still there,
                        scrolled to the same place, if the user taps back
                        into it from the list). Hidden at md+ where both
                        panes are already visible side by side. Renders a
                        visible "Back" label (not just the arrow icon) so
                        it reads unambiguously as navigation rather than
                        blending in with the other small icon-only controls
                        in this header — flagged in mobile visual QA. */}
                    <button
                      type="button"
                      onClick={() => setMobileInboxView("list")}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 md:hidden"
                      aria-label={t("common.back")}
                    >
                      <ArrowLeftIcon className="h-4 w-4 rtl:rotate-180" />
                      {t("common.back")}
                    </button>
                    <ChannelIcon channel={selectedConversation.channel || selectedConversation.platform} size="h-10 w-10" />
                    {/* min-w-0 so a long sender/lead name truncates instead
                        of forcing this header row wider than its pane —
                        the same truncate pattern the conversation list
                        items already use (see filteredConversations.map
                        above). */}
                    <div className="min-w-0">
                      {(() => {
                        const idn = getConversationIdentity(selectedConversation, { selectedLeadName: selectedLead?.name });
                        return (
                          <>
                            <h2 className="truncate text-base font-bold text-slate-950">{idn.primary || t("common.noName")}</h2>
                            {idn.secondary && <p className="truncate text-xs leading-4 text-slate-400" dir="ltr">{idn.secondary}</p>}
                          </>
                        );
                      })()}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">{selectedConversation.channel || selectedConversation.platform || t("messagesPage.unknownChannel")}</span>
                        {multipleWhatsappNumbers && selectedConversation.platform?.toLowerCase() === "whatsapp" && selectedConversation.whatsapp_instance && (
                          <span className="rounded-full border border-teal-100 bg-teal-50 px-3 py-1 text-xs font-bold text-teal-700">
                            WhatsApp: {selectedConversation.whatsapp_instance.display_name || selectedConversation.whatsapp_instance.phone}
                          </span>
                        )}
                        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusStyles[selectedConversation.conversation_status] || "bg-slate-100 text-slate-600 border-slate-200"}`}>{selectedConversation.conversation_status || "active"}</span>
                        <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">{t("messagesPage.messagesCountSuffix", { count: visibleMessages.length })}</span>
                      </div>
                    </div>
                  </div>

                  {/* border-t/pt-2 (removed again at lg, where this sits
                      beside the identity block instead of stacked below
                      it) gives this control group its own visual
                      separation from the identity/badges block above
                      instead of the two running directly into each other
                      — flagged as "excessively cramped" in mobile visual
                      QA. */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 lg:justify-end lg:border-t-0 lg:pt-0">
                    {conversationStatus === "waiting_human" && !selectedConversation.assigned_user_id && (
                      <>
                        <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700">{t("common.waitingHuman")}</span>
                        {/* Smart Assignment V1 — a system RECOMMENDATION,
                            not ownership: deliberately a different color
                            from the "claimed by" pill below (and from
                            the amber "waiting" badge above), and the Take
                            Conversation button right after it stays fully
                            enabled/available regardless of who this
                            suggests — any eligible employee can still
                            accept first. Falls back to a neutral
                            "Unassigned" label when there is no
                            recommendation either. */}
                        {selectedConversation.system_assigned_user_id ? (
                          <span className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-600">
                            {selectedConversation.system_assigned_user_id === user?.id
                              ? t("messagesPage.systemSuggestedYou")
                              : t("messagesPage.systemSuggestedPrefix", { name: selectedConversation.system_assigned_user?.name || t("roles.agent") })}
                          </span>
                        ) : (
                          <span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-500">
                            {t("messagesPage.unassigned")}
                          </span>
                        )}
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
                      // max-w-full truncate: this pill embeds the assigned
                      // employee's name, which — unlike every other badge
                      // in this header — is arbitrary-length user data, not
                      // a fixed vocabulary word. Without a bound it could
                      // force real horizontal overflow instead of wrapping
                      // (flex-wrap only wraps BETWEEN items; it doesn't
                      // shrink an individual item wider than its row).
                      <span className="max-w-full truncate rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
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
                    {/* Conversation Card V1 — opens the same card as the
                        persistent xl+ panel, as a drawer/sheet. Hidden at
                        xl+ since the panel is already always visible there
                        (see the grid comment above). Available regardless
                        of conversationStatus, unlike the action buttons
                        above — the card's lifecycle/notes context is useful
                        even for a closed/active conversation. */}
                    <button
                      type="button"
                      onClick={() => setCardOpen(true)}
                      aria-label={t("conversationCard.openButton")}
                      className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 shadow-sm hover:bg-slate-50 xl:hidden"
                    >
                      <InformationCircleIcon className="h-4 w-4" />
                    </button>
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
                ) : visibleMessages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">{t("messagesPage.noMessagesForConversation")}</div>
                ) : (
                  <div className="space-y-2.5">
                    {visibleMessages.map((msg) => {
                      const isInbound = ["inbound", "in"].includes(msg.direction);
                      // isMediaMessageType(undefined/null) is false, so every
                      // historical row (message_type never set) takes the
                      // exact same path as before — no behavior change for
                      // existing/text messages.
                      const isMedia = isMediaMessageType(msg.message_type);
                      const captionText = msg.message_text || getMessageText(msg);
                      const mediaControl = isMedia ? MEDIA_CONTROLS.find((c) => c.type === msg.message_type) : null;
                      return (
                        <div key={msg.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
                          <div className={`max-w-[58%] rounded-2xl px-3.5 py-2.5 shadow-sm ${isInbound ? "rounded-tr-lg border border-slate-200 bg-white text-slate-800" : "rounded-tl-lg bg-indigo-600/95 text-white shadow-indigo-100"} ${msg._pending ? "opacity-70" : ""}`}>
                            <div className="mb-1.5 flex items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isInbound ? "bg-slate-100 text-slate-500" : "bg-white/15 text-white"}`}>{directionLabel(msg.direction, t)}</span>
                              <span className={`text-[11px] ${isInbound ? "text-slate-400" : "text-indigo-100"}`}>{msg._pending ? t("messagesPage.sending") : formatDate(msg.created_at, i18n.language)}</span>
                            </div>
                            {isMedia && !msg._pending && (
                              <MediaAttachment
                                msg={msg}
                                mediaControl={mediaControl}
                                isInbound={isInbound}
                                conversationId={selectedConversation.conversation_id}
                                actorUserId={user?.id}
                                t={t}
                              />
                            )}
                            {(!isMedia || captionText || msg._pending) && (
                              <div className="whitespace-pre-wrap break-words text-sm leading-6">{isMedia ? (captionText || msg.media_file_name || "") : captionText || "—"}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* px-3 pt-3 + a safe-area-aware pb (instead of p-3) so the
                  composer — the one piece of the Inbox that must "remain
                  fully visible above browser/device UI" — stays clear of
                  the home-indicator area on notched phones (viewport-
                  fit=cover in index.html renders this pane edge-to-edge
                  without this). max(0.75rem, ...) keeps the original
                  0.75rem/p-3 spacing wherever the inset is 0, i.e.
                  everywhere non-notched, including desktop. */}
              <div className="shrink-0 border-t border-slate-100 bg-white px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
                {sendError && (
                  <div className="mb-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                    {sendError}
                  </div>
                )}

                {!canControlConversation && (
                  <div className="mb-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                    {isClosedConversation
                      ? t("messagesPage.conversationClosedNotice")
                      : selectedConversation.assigned_user_id
                        ? t("messagesPage.claimedByNotice", { name: selectedConversation.assigned_user?.name || t("roles.agent") })
                        : t("messagesPage.mustClaimFirst")}
                  </div>
                )}

                {/* Selected-attachment preview — WhatsApp Media & Attachment
                    Support v1. Upload only happens on Send (see
                    handleFileSelected / sendHumanReply above), so this
                    preview alone never writes to Storage. */}
                {attachment && (
                  <div className="mb-2 flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                    {attachment.type === MESSAGE_TYPES.IMAGE && attachment.previewUrl ? (
                      <img src={attachment.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400">
                        {attachment.type === MESSAGE_TYPES.AUDIO ? <MicrophoneIcon className="h-5 w-5" /> : <DocumentIcon className="h-5 w-5" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-900">{attachment.file.name}</p>
                      <p className="text-xs text-slate-500">{formatFileSize(attachment.file.size)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={removeAttachment}
                      className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
                      aria-label={t("messagesPage.removeAttachment")}
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>
                )}

                <div className="flex items-end gap-2">
                  {/* Media controls — each button opens its hidden file
                      input only when canSendMedia is true, i.e. the
                      conversation's channel is in
                      SUPPORTED_MEDIA_CHANNEL_VALUES (src/lib/mediaMessages.js
                      — whatsapp/facebook/telegram today). Any other/unknown
                      channel renders the same disabled "coming soon" state
                      as before. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {availableMediaControls.map(({ key, type, labelKey, icon: Icon }) => (
                      <React.Fragment key={key}>
                        <input
                          ref={(el) => {
                            fileInputRefs.current[key] = el;
                          }}
                          type="file"
                          accept={getAcceptAttribute(type)}
                          className="hidden"
                          onChange={(e) => handleFileSelected(type, e)}
                        />
                        <button
                          type="button"
                          onClick={() => handleMediaButtonClick(key)}
                          disabled={!canSendMedia || sending || !canControlConversation}
                          title={canSendMedia ? t(labelKey) : t("messagesPage.mediaComingSoon", { label: t(labelKey) })}
                          className={`flex h-11 w-11 items-center justify-center rounded-2xl border transition ${
                            canSendMedia
                              ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              : "border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed"
                          }`}
                        >
                          <Icon className="h-5 w-5" />
                        </button>
                      </React.Fragment>
                    ))}
                  </div>

                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    disabled={sending || !canControlConversation}
                    placeholder={
                      canControlConversation
                        ? attachment
                          ? t("messagesPage.captionPlaceholder")
                          : t("messagesPage.composerPlaceholderEnabled")
                        : t("messagesPage.composerPlaceholderDisabled")
                    }
                    rows={2}
                    // min-w-0: without it, a flex item's default min-width
                    // is its content's intrinsic width — for a <textarea>
                    // that's its default `cols` sizing (~20 characters),
                    // which was wide enough to force horizontal overflow
                    // of the whole composer row on narrow phones once the
                    // 3 media buttons + send button were also on-screen.
                    className="min-h-[44px] max-h-40 min-w-0 flex-1 resize-none rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-400"
                  />

                  <button
                    type="button"
                    onClick={sendHumanReply}
                    disabled={sending || (!draft.trim() && !attachment) || !canControlConversation}
                    className="h-11 shrink-0 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {sending ? t("messagesPage.sending") : t("messagesPage.send")}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Conversation Card V1 — persistent 3rd column, xl+ only (see the
            grid comment above). Always rendered as its own grid track so
            the column width stays reserved even with no conversation
            selected; the empty-state message below matches the chat pane's
            own "select a conversation" placeholder. The drawer variant
            below (< xl) is the same component, just mounted differently. */}
        <aside className="hidden h-full min-h-0 flex-col border-s border-slate-100 bg-slate-50/50 xl:flex">
          {selectedConversation ? (
            <ConversationCard conversationId={selectedConversation.conversation_id} actorUserId={user?.id} variant="panel" />
          ) : (
            <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-slate-400">{t("messagesPage.selectConversationPrompt")}</div>
          )}
        </aside>
      </div>

      {selectedConversation && (
        <ConversationCard conversationId={selectedConversation.conversation_id} actorUserId={user?.id} variant="drawer" open={cardOpen} onClose={() => setCardOpen(false)} />
      )}
    </div>
  );
}
