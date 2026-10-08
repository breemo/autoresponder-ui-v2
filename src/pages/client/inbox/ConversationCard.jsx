import React, { useEffect, useRef, useState } from "react";
import {
  ChatBubbleLeftRightIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ClockIcon,
  DocumentTextIcon,
  UserCircleIcon,
  UserGroupIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { getConversationIdentity } from "../../../lib/conversationIdentity.js";
import { AppChannelTile } from "../../../components/app/Channel.jsx";
import { StatusPill, cx } from "../../../components/app/primitives.jsx";
import { channelLabel, channelValue, formatDateTime, relativeTime, statusMeta } from "./inboxUi.js";

// Conversation Card — the operational details panel. Every value shown is
// real (list row, /api/conversation card data, lead lookup, notes); fields
// the system does not have (tags, editable profile, location…) are not
// rendered. Panel (desktop, collapsible) and drawer (tablet/mobile) share
// this component; the data lives in useConversationCard (one instance).

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt className="shrink-0 text-[13px] text-slate-500">{label}</dt>
      <dd className="min-w-0 text-end text-[13px] font-medium text-slate-800">{children}</dd>
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-3">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
        {Icon && <Icon className="h-4 w-4 text-slate-400" />}
        {title}
      </h3>
      <dl>{children}</dl>
    </section>
  );
}

export default function ConversationCard({
  conv,
  data,
  selectedLead,
  actorUserId,
  multipleWhatsappNumbers,
  variant,
  open,
  onClose,
  isRtl,
  t,
  lang,
}) {
  const [tab, setTab] = useState("overview");
  const closeRef = useRef(null);

  const {
    card,
    cardLoading,
    cardError,
    notes,
    notesLoading,
    notesError,
    noteDraft,
    setNoteDraft,
    addingNote,
    handleAddNote,
    editingNoteId,
    editingBody,
    setEditingBody,
    startEditNote,
    cancelEditNote,
    saveEditNote,
    savingNoteId,
    deleteNote,
    deletingNoteId,
    timelineEventLabel,
  } = data;

  // Drawer: focus its close control when opened, Escape closes.
  useEffect(() => {
    if (variant !== "drawer" || !open) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [variant, open, onClose]);

  if (!conv) return null;

  const cardConv = card?.conversation || null;
  const lastEmployee = card?.last_employee || null;
  const timeline = card?.timeline || [];
  const idn = getConversationIdentity(conv, { selectedLeadName: selectedLead?.name });
  const status = statusMeta(cardConv?.conversation_status || conv.conversation_status, t);
  const ch = channelValue(conv);
  const account = multipleWhatsappNumbers && ch === "whatsapp" && conv.whatsapp_instance
    ? conv.whatsapp_instance.display_name || conv.whatsapp_instance.phone
    : null;
  const assigned = cardConv ?? conv;

  const tabs = [
    { key: "overview", label: t("inbox.tabOverview") },
    { key: "customer", label: t("inbox.tabCustomer") },
    { key: "activity", label: t("inbox.tabActivity") },
    { key: "notes", label: t("inbox.tabNotes", { count: notes.length }) },
  ];

  const CollapseIcon = isRtl ? ChevronDoubleLeftIcon : ChevronDoubleRightIcon;

  const content = (
    <div className="flex h-full min-h-0 flex-col bg-slate-50/60">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200/80 bg-white px-3 py-2.5">
        <h2 className="text-sm font-semibold text-slate-900">{t("conversationCard.title")}</h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={variant === "drawer" ? t("conversationCard.closePanel") : t("inbox.hideDetails")}
          title={variant === "drawer" ? t("conversationCard.closePanel") : t("inbox.hideDetails")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {variant === "drawer" ? <XMarkIcon className="h-5 w-5" /> : <CollapseIcon className="h-4 w-4" />}
        </button>
      </div>

      <div className="shrink-0 border-b border-slate-200/80 bg-white px-3 pb-0 pt-3">
        <div className="flex items-center gap-3">
          <AppChannelTile channel={ch} className="h-10 w-10 rounded-xl" iconClassName="h-5 w-5" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">
              <bdi>{idn.primary || t("common.noName")}</bdi>
            </p>
            {idn.secondary && (
              <p className="truncate text-xs text-slate-500" dir="ltr">
                {idn.secondary}
              </p>
            )}
          </div>
        </div>
        <div role="tablist" className="mt-3 flex gap-1 overflow-x-auto overflow-y-hidden">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              role="tab"
              aria-selected={tab === tb.key}
              onClick={() => setTab(tb.key)}
              className={cx(
                "-mb-px whitespace-nowrap border-b-2 px-2 pb-2 text-xs font-medium transition",
                tab === tb.key ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"
              )}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {cardLoading && <p className="text-xs text-slate-400">{t("common.loading")}</p>}
        {cardError && tab !== "notes" && (
          <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{cardError}</p>
        )}

        {tab === "overview" && (
          <>
            <Section icon={ChatBubbleLeftRightIcon} title={t("conversationCard.sectionConversation")}>
              <Row label={t("conversationCard.status")}>
                <StatusPill tone={status.tone}>{status.label}</StatusPill>
              </Row>
              <Row label={t("inbox.channel")}>
                <span className="inline-flex items-center gap-1.5">
                  <AppChannelTile channel={ch} className="h-4 w-4 rounded" iconClassName="h-3 w-3" />
                  {channelLabel(ch, t)}
                </span>
              </Row>
              {account && (
                <Row label={t("inbox.account")}>
                  <span dir="ltr">{account}</span>
                </Row>
              )}
              <Row label={t("inbox.started")}>{formatDateTime(conv.created_at, lang)}</Row>
              <Row label={t("conversationCard.lastActivity")}>{relativeTime(cardConv?.updated_at || conv.last_message_at || conv.updated_at, t)}</Row>
              <Row label={t("inbox.messages")}>{conv.messages_count ?? "—"}</Row>
            </Section>

            {cardConv && (
              <>
                <Section icon={UserGroupIcon} title={t("conversationCard.sectionAssignment")}>
                  <Row label={t("conversationCard.acceptedAssigned")}>
                    {assigned.assigned_user_id
                      ? assigned.assigned_user_id === actorUserId
                        ? t("common.you")
                        : assigned.assigned_user?.name || t("roles.agent")
                      : t("messagesPage.unassigned")}
                  </Row>
                  <Row label={t("conversationCard.systemSuggested")}>{cardConv.system_assigned_user?.name || "—"}</Row>
                  <Row label={t("conversationCard.lastEmployee")}>
                    {lastEmployee ? (lastEmployee.user?.id === actorUserId ? t("common.you") : lastEmployee.user?.name || t("roles.agent")) : "—"}
                    {lastEmployee && lastEmployee.source !== "event" && (
                      <span className="block text-[10px] font-normal text-slate-400">{t("conversationCard.lastEmployeeApproximate")}</span>
                    )}
                  </Row>
                </Section>

                <Section icon={ClockIcon} title={t("conversationCard.sectionLifecycle")}>
                  <Row label={t("conversationCard.solvedBy")}>
                    {cardConv.solved_by_user?.name ? `${cardConv.solved_by_user.name} · ${relativeTime(cardConv.solved_at, t)}` : "—"}
                  </Row>
                  <Row label={t("conversationCard.reopenedBy")}>
                    {cardConv.reopened_by_user?.name ? `${cardConv.reopened_by_user.name} · ${relativeTime(cardConv.reopened_at, t)}` : "—"}
                  </Row>
                </Section>
              </>
            )}
          </>
        )}

        {tab === "customer" && (
          <Section icon={UserCircleIcon} title={t("inbox.customerInfo")}>
            <Row label={t("common.name")}>
              <bdi>{selectedLead?.name || conv.customer_name || conv.lead_name || "—"}</bdi>
            </Row>
            <Row label={t("inbox.phone")}>
              <span dir="ltr">{selectedLead?.phone || conv.lead_phone || "—"}</span>
            </Row>
            <Row label={t("inbox.identifier")}>
              <span dir="ltr" className="break-all">
                {idn.senderId || "—"}
              </span>
            </Row>
            <Row label={t("inbox.leadCaptured")}>{selectedLead || conv.has_lead ? t("inbox.yes") : t("inbox.no")}</Row>
          </Section>
        )}

        {tab === "activity" && (
          <Section icon={ClockIcon} title={t("conversationCard.sectionTimeline")}>
            {timeline.length === 0 ? (
              <p className="py-1 text-xs text-slate-400">{t("conversationCard.noEvents")}</p>
            ) : (
              <ul className="space-y-1.5 py-1">
                {timeline.map((event) => (
                  <li key={event.id} className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
                    <p className="font-medium text-slate-700">{timelineEventLabel(event)}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{relativeTime(event.created_at, t)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {tab === "notes" && (
          <section className="rounded-xl border border-slate-200/80 bg-white p-3">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <DocumentTextIcon className="h-4 w-4 text-slate-400" />
              {t("conversationCard.sectionNotes")}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-400">{t("conversationCard.notesHint")}</p>

            {notesError && <p className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{notesError}</p>}

            <div className="mt-2 space-y-2">
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder={t("conversationCard.noteAddPlaceholder")}
                rows={2}
                dir="auto"
                className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
              />
              <button
                type="button"
                onClick={handleAddNote}
                disabled={!noteDraft.trim() || addingNote}
                className="inline-flex h-8 items-center rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
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
                  <li key={note.id} className="rounded-lg border border-amber-100 bg-amber-50/50 p-2.5 text-[13px]">
                    {editingNoteId === note.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={editingBody}
                          onChange={(e) => setEditingBody(e.target.value)}
                          rows={2}
                          dir="auto"
                          className="w-full resize-none rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => saveEditNote(note.id)}
                            disabled={!editingBody.trim() || savingNoteId === note.id}
                            className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                          >
                            {savingNoteId === note.id ? t("conversationCard.saving") : t("conversationCard.save")}
                          </button>
                          <button type="button" onClick={cancelEditNote} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                            {t("conversationCard.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="whitespace-pre-wrap text-slate-700" dir="auto">
                          {note.body}
                        </p>
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                          <span>
                            {note.author?.name || t("roles.agent")} · {relativeTime(note.created_at, t)}
                            {note.updated_at && ` · ${t("conversationCard.editedSuffix")}`}
                          </span>
                          {note.author_user_id === actorUserId && (
                            <span className="flex shrink-0 gap-2">
                              <button type="button" onClick={() => startEditNote(note)} className="font-semibold text-indigo-600 hover:underline">
                                {t("conversationCard.edit")}
                              </button>
                              <button type="button" onClick={() => deleteNote(note.id)} disabled={deletingNoteId === note.id} className="font-semibold text-red-600 hover:underline disabled:opacity-50">
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
        )}
      </div>
    </div>
  );

  if (variant === "drawer") {
    return (
      <div className={`fixed inset-0 z-40 xl:hidden ${open ? "flex" : "hidden"}`} role="dialog" aria-modal="true" aria-label={t("conversationCard.title")}>
        <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
        <div className="relative ms-auto flex h-full w-full max-w-sm flex-col bg-white shadow-xl">{content}</div>
      </div>
    );
  }

  return content;
}
