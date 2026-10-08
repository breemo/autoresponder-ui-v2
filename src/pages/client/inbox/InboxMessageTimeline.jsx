import React, { useEffect, useMemo, useRef, useState } from "react";
import { BoltIcon, ChatBubbleLeftEllipsisIcon, SparklesIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import LinkifiedText from "../../../components/LinkifiedText.jsx";
import { MESSAGE_TYPES, isMediaMessageType, formatFileSize } from "../../../lib/mediaMessages.js";
import { Avatar, cx } from "../../../components/app/primitives.jsx";
import { MEDIA_CONTROLS } from "./mediaControls.js";
import { dayKey, dayLabel, formatTime, senderKind } from "./inboxUi.js";

// Orientation of the approved design: customer messages on the END side,
// business replies (AI Agent / team / automation) on the START side with a
// sender avatar. One flag so it can be flipped if ever needed.
const CUSTOMER_ON_END = true;

// Resolves and caches a short-lived signed READ url for one media message
// (moved unchanged from ClientMessages.jsx — request/cache/retry logic is
// identical; only the visual classes follow the new light bubbles).
function MediaAttachment({ msg, mediaControl, conversationId, actorUserId, t }) {
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [storageUnavailable, setStorageUnavailable] = useState(false);
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
      const ttlMs = Math.max(0, (Number(data.expires_in) || 60) - 10) * 1000;
      cacheRef.current = { url: data.url, expiresAt: Date.now() + ttlMs };
      setStatus("ready");
      return data.url;
    } catch {
      setStatus("error");
      return null;
    }
  }

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

  const errorText = storageUnavailable ? t("messagesPage.storageUnavailable") : t("messagesPage.mediaLoadFailed");
  const placeholder = "mb-1.5 flex items-center justify-center rounded-xl border border-slate-200 bg-white/70 p-2 text-xs font-medium text-slate-400";

  if (isImage) {
    if (status === "ready" && cacheRef.current.url) {
      return <img src={cacheRef.current.url} alt={msg.media_file_name || ""} className="mb-1.5 max-h-64 w-full rounded-xl border border-slate-200 object-cover" />;
    }
    return (
      <div className={cx(placeholder, "h-28")}>
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
      <div className={cx(placeholder, "justify-start gap-2")}>
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

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-slate-200 bg-white/80 p-2">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-400">{MediaIcon && <MediaIcon className="h-5 w-5" />}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-slate-800">{msg.media_file_name || (mediaControl ? t(mediaControl.labelKey) : "")}</p>
        <p className="text-[11px] text-slate-400">{formatFileSize(msg.media_size_bytes) || t("messagesPage.mediaPreviewUnavailable")}</p>
      </div>
      <button
        type="button"
        onClick={handleOpenDocument}
        disabled={status === "loading"}
        className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-50"
      >
        {status === "loading" ? t("messagesPage.mediaLoading") : status === "error" ? t("messagesPage.retry") : t("messagesPage.openFile")}
      </button>
    </div>
  );
}

const BUBBLE = {
  customer: "bg-slate-100 text-slate-800 rounded-2xl rounded-ee-md",
  ai: "bg-indigo-50/80 text-slate-800 ring-1 ring-inset ring-indigo-100 rounded-2xl rounded-es-md",
  employee: "bg-emerald-50/80 text-slate-800 ring-1 ring-inset ring-emerald-100 rounded-2xl rounded-es-md",
  automation: "bg-white text-slate-800 ring-1 ring-inset ring-slate-200 rounded-2xl rounded-es-md",
};

function SenderAvatar({ kind, name }) {
  if (kind === "ai")
    return (
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white">
        <SparklesIcon className="h-4 w-4" />
      </span>
    );
  if (kind === "employee") return <Avatar name={name} className="h-7 w-7 text-[11px]" tone="bg-emerald-100 text-emerald-700" />;
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
      {kind === "outbound" ? <ChatBubbleLeftEllipsisIcon className="h-4 w-4" /> : <BoltIcon className="h-4 w-4" />}
    </span>
  );
}

export default function InboxMessageTimeline({
  messages,
  events,
  timelineEventLabel,
  loadingMessages,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  hoveringTop,
  setHoveringTop,
  nearTopScroll,
  messagesScrollRef,
  onMessagesScroll,
  conversationId,
  actorUserId,
  actorUserName,
  assignedUserId,
  assignedUserName,
  t,
  lang,
}) {
  // Merge lifecycle events (from the conversation card data, when loaded)
  // into the message stream by time. Messages keep their server order.
  const items = useMemo(() => {
    const evs = [...(events || [])]
      .filter((e) => e?.created_at)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const out = [];
    let ei = 0;
    for (const m of messages) {
      const at = new Date(m.created_at).getTime();
      while (ei < evs.length && Number.isFinite(at) && new Date(evs[ei].created_at).getTime() <= at) out.push({ type: "event", e: evs[ei++] });
      out.push({ type: "msg", m });
    }
    while (ei < evs.length) out.push({ type: "event", e: evs[ei++] });
    return out;
  }, [messages, events]);

  function employeeName(msg) {
    if (msg._pending || (msg.sent_by_user_id && msg.sent_by_user_id === actorUserId)) return t("common.you");
    if (msg.sent_by_user_id && msg.sent_by_user_id === assignedUserId && assignedUserName) return assignedUserName;
    return t("roles.agent");
  }

  // Avatar initial uses the real person name where known ("You" → own name).
  function avatarName(msg) {
    if ((msg._pending || (msg.sent_by_user_id && msg.sent_by_user_id === actorUserId)) && actorUserName) return actorUserName;
    return employeeName(msg);
  }

  function senderLabel(kind, msg) {
    switch (kind) {
      case "ai":
        return t("inbox.senderAi");
      case "employee": {
        const name = employeeName(msg);
        return name === t("roles.agent") || name === t("common.you") ? name : `${name} · ${t("roles.agent")}`;
      }
      case "auto":
        return t("inbox.senderAuto");
      case "quick":
        return t("inbox.senderQuick");
      case "system":
        return t("inbox.senderSystem");
      default:
        return t("common.outbound");
    }
  }

  let lastDay = "";

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={messagesScrollRef} onScroll={onMessagesScroll} className="h-full overflow-y-auto bg-slate-50/50 px-3 py-4 sm:px-5">
        {loadingMessages ? (
          <div className="p-8 text-center text-sm text-slate-500">{t("messagesPage.loadingMessages")}</div>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-md rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">{t("messagesPage.noMessagesForConversation")}</div>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-3">
            {items.map((item, idx) => {
              const at = item.type === "msg" ? item.m.created_at : item.e.created_at;
              const dk = dayKey(at);
              const showDay = dk && dk !== lastDay;
              if (dk) lastDay = dk;
              const daySep = showDay ? (
                <div key={`day-${dk}-${idx}`} className="flex justify-center py-1">
                  <span className="rounded-full bg-white px-3 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">{dayLabel(at, t, lang)}</span>
                </div>
              ) : null;

              if (item.type === "event") {
                return (
                  <React.Fragment key={`ev-${item.e.id || idx}`}>
                    {daySep}
                    <div className="flex justify-center">
                      <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200">
                        <UserGroupIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{timelineEventLabel(item.e)}</span>
                        <span className="shrink-0 text-slate-400">{formatTime(item.e.created_at, lang)}</span>
                      </span>
                    </div>
                  </React.Fragment>
                );
              }

              const msg = item.m;
              const kind = senderKind(msg);
              const isCustomer = kind === "customer";
              const style = isCustomer ? "customer" : kind === "ai" ? "ai" : kind === "employee" ? "employee" : "automation";
              const isMedia = isMediaMessageType(msg.message_type);
              const captionText = msg.message_text || "";
              const mediaControl = isMedia ? MEDIA_CONTROLS.find((c) => c.type === msg.message_type) : null;
              const onEnd = isCustomer === CUSTOMER_ON_END;

              return (
                <React.Fragment key={msg.id}>
                  {daySep}
                  <div className={cx("flex items-end gap-2", onEnd && "flex-row-reverse")} data-sender={kind}>
                    {!isCustomer && <SenderAvatar kind={kind} name={avatarName(msg)} />}
                    <div className={cx("flex min-w-0 max-w-[min(80%,620px)] flex-col", onEnd ? "items-end" : "items-start")}>
                      {!isCustomer && (
                        <span className={cx("mb-0.5 px-1 text-[11px] font-semibold", kind === "ai" ? "text-indigo-600" : kind === "employee" ? "text-emerald-700" : "text-slate-500")}>
                          {senderLabel(kind, msg)}
                        </span>
                      )}
                      <div className={cx("max-w-full px-3.5 py-2", BUBBLE[style], msg._pending && "opacity-70")}>
                        {isMedia && !msg._pending && (
                          <MediaAttachment msg={msg} mediaControl={mediaControl} conversationId={conversationId} actorUserId={actorUserId} t={t} />
                        )}
                        {(!isMedia || captionText || msg._pending) && (
                          <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed" dir="auto">
                            {captionText ? <LinkifiedText text={captionText} /> : isMedia ? msg.media_file_name || "" : "—"}
                          </div>
                        )}
                      </div>
                      <span className="mt-0.5 px-1 text-[10px] text-slate-400">{msg._pending ? t("messagesPage.sending") : formatTime(msg.created_at, lang)}</span>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

      {/* Load-older floating control (Message Pagination v1) — overlays the
          top of the viewport, never part of the message layout. */}
      {hasMoreOlder && !loadingMessages && (
        <div className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex h-16 justify-center" onMouseEnter={() => setHoveringTop(true)} onMouseLeave={() => setHoveringTop(false)}>
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loadingOlder}
            className={cx(
              "mt-2 h-fit rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-md backdrop-blur transition-opacity duration-150 disabled:cursor-wait",
              hoveringTop || nearTopScroll ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            {loadingOlder ? t("messagesPage.loadingOlderMessages", "⟳ جاري التحميل...") : t("messagesPage.loadOlderMessages", "↑ رسائل أقدم")}
          </button>
        </div>
      )}
    </div>
  );
}
