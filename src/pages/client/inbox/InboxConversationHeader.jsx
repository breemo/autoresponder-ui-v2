import React from "react";
import { ArrowLeftIcon, ViewColumnsIcon } from "@heroicons/react/24/outline";
import { getConversationIdentity } from "../../../lib/conversationIdentity.js";
import { AppChannelTile } from "../../../components/app/Channel.jsx";
import { StatusPill, cx } from "../../../components/app/primitives.jsx";
import { channelLabel, channelValue, statusMeta } from "./inboxUi.js";

const btn = "inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

// Compact conversation header. Action visibility rules are exactly the ones
// the Inbox had before (passed in from ClientMessages); no decorative or
// unimplemented actions are rendered.
export default function InboxConversationHeader({
  conv,
  selectedLead,
  multipleWhatsappNumbers,
  userId,
  conversationStatus,
  canControlConversation,
  reopenWindowExpired,
  claimingId,
  updatingStatus,
  onClaim,
  onTakeover,
  onClose,
  onReopen,
  onBack,
  onToggleDetails,
  detailsPressed,
  t,
}) {
  const ch = channelValue(conv);
  const idn = getConversationIdentity(conv, { selectedLeadName: selectedLead?.name });
  const status = statusMeta(conversationStatus, t);
  const account = multipleWhatsappNumbers && conv.platform?.toLowerCase() === "whatsapp" && conv.whatsapp_instance
    ? conv.whatsapp_instance.display_name || conv.whatsapp_instance.phone
    : null;
  const isWaiting = conversationStatus === "waiting_human";
  const isClosed = conversationStatus === "closed";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200/80 bg-white px-3 py-2.5 sm:px-4">
      {/* Mobile only: back to the list (switches mobileInboxView, keeps the selection). */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 md:hidden"
        aria-label={t("common.back")}
      >
        <ArrowLeftIcon className="h-4 w-4 rtl:rotate-180" />
        {t("common.back")}
      </button>

      <div className="flex min-w-[11rem] flex-1 items-center gap-3">
        <AppChannelTile channel={ch} className="h-9 w-9 shrink-0 rounded-xl" iconClassName="h-[18px] w-[18px]" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-slate-900">
              <bdi>{idn.primary || t("common.noName")}</bdi>
            </h2>
            <StatusPill tone={status.tone} className="shrink-0">
              {status.label}
            </StatusPill>
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-slate-500">
            <span className="shrink-0">{t("inbox.via", { channel: channelLabel(ch, t) })}</span>
            {idn.secondary && (
              <>
                <span className="text-slate-300">·</span>
                <span className="truncate" dir="ltr">
                  {idn.secondary}
                </span>
              </>
            )}
            {account && (
              <>
                <span className="text-slate-300">·</span>
                <span className="truncate text-teal-700" dir="ltr">
                  WhatsApp: {account}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {isWaiting && !conv.assigned_user_id && (
          <>
            {/* Smart Assignment V1 — a recommendation, not ownership. */}
            <span className="max-w-[200px] truncate rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
              {conv.system_assigned_user_id
                ? conv.system_assigned_user_id === userId
                  ? t("messagesPage.systemSuggestedYou")
                  : t("messagesPage.systemSuggestedPrefix", { name: conv.system_assigned_user?.name || t("roles.agent") })
                : t("messagesPage.unassigned")}
            </span>
            <button
              type="button"
              onClick={() => onClaim(conv.conversation_id)}
              disabled={claimingId === conv.conversation_id}
              className={cx(btn, "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-700")}
            >
              {claimingId === conv.conversation_id ? t("messagesPage.claiming") : t("messagesPage.claimConversation")}
            </button>
          </>
        )}
        {isWaiting && conv.assigned_user_id && (
          <span className="max-w-[220px] truncate rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-100">
            {t("messagesPage.claimedByFullPrefix", { name: conv.assigned_user?.name || t("roles.agent") })}
          </span>
        )}
        {!isWaiting && !isClosed && (
          <button type="button" onClick={onTakeover} disabled={updatingStatus} className={cx(btn, "border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100")}>
            {t("common.transferToAgent")}
          </button>
        )}
        {!isClosed && canControlConversation && (
          <button type="button" onClick={onClose} disabled={updatingStatus} className={cx(btn, "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>
            {t("common.close")}
          </button>
        )}
        {isClosed && !reopenWindowExpired && (
          <button type="button" onClick={onReopen} disabled={updatingStatus} className={cx(btn, "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700")}>
            {t("messagesPage.reopenConversation")}
          </button>
        )}
        {isClosed && reopenWindowExpired && (
          <span className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 ring-1 ring-inset ring-slate-200">
            {t("messagesPage.conversationArchivedBadge", "مؤرشفة")}
          </span>
        )}
        <button
          type="button"
          onClick={onToggleDetails}
          aria-pressed={detailsPressed}
          aria-label={t("conversationCard.openButton")}
          title={t("conversationCard.openButton")}
          className={cx(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition",
            detailsPressed ? "border-indigo-200 bg-indigo-50 text-indigo-600" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
          )}
        >
          <ViewColumnsIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
