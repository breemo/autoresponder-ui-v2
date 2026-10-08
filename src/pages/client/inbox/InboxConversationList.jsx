import React, { useEffect, useRef, useState } from "react";
import { ArrowPathIcon, FunnelIcon, MagnifyingGlassIcon, UserIcon } from "@heroicons/react/24/outline";
import { getConversationIdentity } from "../../../lib/conversationIdentity.js";
import { AppChannelTile } from "../../../components/app/Channel.jsx";
import { cx } from "../../../components/app/primitives.jsx";
import { channelValue, relativeTime } from "./inboxUi.js";

// Status tabs map onto the EXISTING status filter values; the full status
// list (incl. open / lead_captured), channel and leads-only filters stay in
// the filter menu — nothing is removed.
const STATUS_TABS = [
  { value: "all", labelKey: "inbox.tabAll" },
  { value: "active", labelKey: "messagesPage.statusActive" },
  { value: "waiting_human", labelKey: "inbox.tabWaiting" },
  { value: "closed", labelKey: "messagesPage.statusClosed" },
];

function FilterMenu({ channel, setChannel, status, setStatus, leadsOnly, setLeadsOnly, t }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = channel !== "all" || leadsOnly || !STATUS_TABS.some((s) => s.value === status);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectClass = "h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 outline-none focus:border-indigo-300";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("inbox.filters")}
        title={t("inbox.filters")}
        className={cx(
          "relative inline-flex h-9 w-9 items-center justify-center rounded-lg border transition",
          active ? "border-indigo-200 bg-indigo-50 text-indigo-600" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
        )}
      >
        <FunnelIcon className="h-4 w-4" />
        {active && <span className="absolute -end-0.5 -top-0.5 h-2 w-2 rounded-full bg-indigo-600" />}
      </button>
      {open && (
        <div role="dialog" aria-label={t("inbox.filters")} className="absolute end-0 top-full z-30 mt-2 w-64 space-y-2.5 rounded-xl border border-slate-200 bg-white p-3 shadow-xl shadow-slate-900/10">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("inbox.channel")}</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={selectClass}>
              <option value="all">{t("messagesPage.allChannels")}</option>
              <option value="facebook">Facebook</option>
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="instagram">Instagram</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t("conversationCard.status")}</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
              <option value="all">{t("messagesPage.allStatuses")}</option>
              <option value="active">{t("messagesPage.statusActive")}</option>
              <option value="open">{t("messagesPage.statusOpen")}</option>
              <option value="closed">{t("messagesPage.statusClosed")}</option>
              <option value="lead_captured">{t("navigation.leads")}</option>
              <option value="waiting_human">{t("common.waitingHuman")}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" checked={leadsOnly} onChange={(e) => setLeadsOnly(e.target.checked)} className="rounded border-slate-300" />
            {t("messagesPage.leadsOnlyFilter")}
          </label>
        </div>
      )}
    </div>
  );
}

function ConversationRow({ conv, active, onSelect, multipleWhatsappNumbers, userId, t }) {
  const ch = channelValue(conv);
  const idn = getConversationIdentity(conv);
  const isWaiting = conv.conversation_status === "waiting_human";
  const isClosed = conv.conversation_status === "closed";
  const account = multipleWhatsappNumbers && conv.platform?.toLowerCase() === "whatsapp" && conv.whatsapp_instance
    ? conv.whatsapp_instance.display_name || conv.whatsapp_instance.phone
    : null;

  // Assignment context — same rules as before: "claimed by" when owned;
  // while waiting and unclaimed, the system suggestion or "Unassigned".
  let assignment = null;
  if (conv.assigned_user_id) {
    assignment = { tone: "text-emerald-700", text: t("messagesPage.claimedByPrefix", { name: conv.assigned_user?.name || t("roles.agent") }) };
  } else if (isWaiting) {
    assignment = conv.system_assigned_user_id
      ? {
          tone: "text-indigo-600",
          text:
            conv.system_assigned_user_id === userId
              ? t("messagesPage.systemSuggestedYou")
              : t("messagesPage.systemSuggestedPrefix", { name: conv.system_assigned_user?.name || t("roles.agent") }),
        }
      : { tone: "text-slate-500", text: t("messagesPage.unassigned") };
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      data-conversation-id={conv.conversation_id}
      aria-current={active ? "true" : undefined}
      className={cx(
        "relative flex w-full items-start gap-3 px-3 py-2.5 text-start transition focus:outline-none focus-visible:bg-indigo-50/70",
        active ? "bg-indigo-50/70" : "hover:bg-slate-50"
      )}
    >
      {active && <span className="absolute inset-y-1.5 start-0 w-[3px] rounded-full bg-indigo-600" aria-hidden="true" />}
      <AppChannelTile channel={ch} className="h-10 w-10 shrink-0 rounded-xl" iconClassName="h-5 w-5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className={cx("truncate text-[13px] text-slate-900", conv.unread_count > 0 ? "font-bold" : "font-semibold")}>
            <bdi>{idn.primary || t("common.noName")}</bdi>
          </p>
          <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(conv.last_message_at || conv.updated_at, t)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-slate-500" dir="auto">
            {conv.last_message || t("messagesPage.noMessageYet")}
          </p>
          {conv.unread_count > 0 ? (
            <span
              className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-bold text-white"
              title={t("messagesPage.unreadCountSuffix", { count: conv.unread_count })}
            >
              {conv.unread_count}
            </span>
          ) : isWaiting ? (
            <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-100">{t("inbox.tabWaiting")}</span>
          ) : isClosed ? (
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-semibold text-slate-500">{t("messagesPage.statusClosed")}</span>
          ) : null}
        </div>
        {(assignment || account || conv.has_lead) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
            {assignment && (
              <span className={cx("inline-flex min-w-0 items-center gap-1 truncate", assignment.tone)}>
                <UserIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{assignment.text}</span>
              </span>
            )}
            {account && (
              <span className="truncate text-teal-700" dir="ltr">
                WhatsApp: {account}
              </span>
            )}
            {conv.has_lead && <span className="font-medium text-violet-600">{t("inbox.lead")}</span>}
          </div>
        )}
      </div>
    </button>
  );
}

export default function InboxConversationList({
  conversations,
  selectedConversationId,
  onSelect,
  loading,
  loadingMore,
  totalCount,
  search,
  setSearch,
  channel,
  setChannel,
  status,
  setStatus,
  leadsOnly,
  setLeadsOnly,
  onRefresh,
  listScrollRef,
  onListScroll,
  multipleWhatsappNumbers,
  userId,
  t,
}) {
  return (
    <>
      <div className="shrink-0 border-b border-slate-200/80 px-3 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-slate-900">{t("shell.nav.inbox")}</h2>
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700" title={t("inbox.liveHint")}>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {t("inbox.live")}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              aria-label={t("common.refresh")}
              title={t("common.refresh")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
            >
              <ArrowPathIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div role="tablist" aria-label={t("conversationCard.status")} className="mt-2 flex gap-1 overflow-x-auto overflow-y-hidden">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              onClick={() => setStatus(tab.value)}
              className={cx(
                "-mb-px whitespace-nowrap border-b-2 px-2 pb-2 text-[13px] font-medium transition",
                status === tab.value ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"
              )}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0 space-y-1.5 border-b border-slate-200/80 p-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("inbox.searchPlaceholder")}
              aria-label={t("messagesPage.searchPlaceholder")}
              className="h-9 w-full rounded-lg border border-slate-200 bg-white pe-2.5 ps-8 text-[13px] outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
            />
          </div>
          <FilterMenu channel={channel} setChannel={setChannel} status={status} setStatus={setStatus} leadsOnly={leadsOnly} setLeadsOnly={setLeadsOnly} t={t} />
        </div>
        <p className="text-[11px] text-slate-400">
          {totalCount !== null && totalCount > conversations.length
            ? t("messagesPage.countSuffixOfTotal", { count: conversations.length, total: totalCount })
            : t("messagesPage.countSuffix", { count: conversations.length })}
        </p>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto" ref={listScrollRef} onScroll={onListScroll}>
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">{t("messagesPage.loadingConversations")}</div>
        ) : conversations.length === 0 ? (
          <div className="m-3 rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">{t("messagesPage.noMatchingConversations")}</div>
        ) : (
          conversations.map((conv) => (
            <ConversationRow
              key={conv.conversation_id}
              conv={conv}
              active={conv.conversation_id === selectedConversationId}
              onSelect={() => onSelect(conv.conversation_id)}
              multipleWhatsappNumbers={multipleWhatsappNumbers}
              userId={userId}
              t={t}
            />
          ))
        )}
        {loadingMore && <div className="p-2 text-center text-[11px] text-slate-400">{t("messagesPage.loadingMoreConversations", "…")}</div>}
      </div>
    </>
  );
}
