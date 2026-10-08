import React from "react";
import { DocumentIcon, LockClosedIcon, MicrophoneIcon, PaperAirplaneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { MESSAGE_TYPES, formatFileSize, getAcceptAttribute } from "../../../lib/mediaMessages.js";
import { cx } from "../../../components/app/primitives.jsx";

// Composer with two modes:
//  - "reply": the existing human-reply composer (draft/attachment/send are
//    all owned by ClientMessages; notices, disabled rules, Enter-to-send and
//    media controls are unchanged).
//  - "note": an internal note, posted through the SAME add_note action the
//    Conversation Card uses (shared useConversationCard state) — never sent
//    to the customer.
// No quick replies / AI assist / emoji controls: none exist in the product.
export default function InboxComposer({
  mode,
  setMode,
  // reply
  draft,
  setDraft,
  onKeyDown,
  onSend,
  sending,
  sendError,
  canSendHumanReply,
  noticeText,
  attachment,
  onRemoveAttachment,
  mediaControls,
  canSendMedia,
  fileInputRefs,
  onMediaButtonClick,
  onFileSelected,
  // note
  noteDraft,
  setNoteDraft,
  addingNote,
  onAddNote,
  notesError,
  t,
}) {
  const isNote = mode === "note";

  return (
    <div className="shrink-0 border-t border-slate-200/80 bg-white px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:px-4">
      <div role="tablist" className="mb-2 flex items-center gap-1">
        {[
          { key: "reply", label: t("inbox.composerReply") },
          { key: "note", label: t("inbox.composerNote") },
        ].map((tb) => (
          <button
            key={tb.key}
            type="button"
            role="tab"
            aria-selected={mode === tb.key}
            onClick={() => setMode(tb.key)}
            className={cx(
              "inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition",
              mode === tb.key
                ? tb.key === "note"
                  ? "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200"
                  : "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-100"
                : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
            )}
          >
            {tb.key === "note" && <LockClosedIcon className="h-3.5 w-3.5" />}
            {tb.label}
          </button>
        ))}
      </div>

      {isNote ? (
        <>
          {notesError && <div className="mb-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{notesError}</div>}
          <div className="flex items-end gap-2 rounded-xl border border-amber-200 bg-amber-50/40 p-1.5 focus-within:ring-2 focus-within:ring-amber-100">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={t("conversationCard.noteAddPlaceholder")}
              rows={2}
              dir="auto"
              className="max-h-40 min-h-[40px] min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-slate-400"
            />
            <button
              type="button"
              onClick={onAddNote}
              disabled={addingNote || !noteDraft.trim()}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {addingNote ? t("conversationCard.adding") : t("conversationCard.addNote")}
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-slate-400">{t("conversationCard.notesHint")}</p>
        </>
      ) : (
        <>
          {sendError && <div className="mb-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{sendError}</div>}

          {!canSendHumanReply && noticeText && (
            <div className="mb-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">{noticeText}</div>
          )}

          {attachment && (
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2">
              {attachment.type === MESSAGE_TYPES.IMAGE && attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400">
                  {attachment.type === MESSAGE_TYPES.AUDIO ? <MicrophoneIcon className="h-5 w-5" /> : <DocumentIcon className="h-5 w-5" />}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{attachment.file.name}</p>
                <p className="text-xs text-slate-500">{formatFileSize(attachment.file.size)}</p>
              </div>
              <button
                type="button"
                onClick={onRemoveAttachment}
                className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
                aria-label={t("messagesPage.removeAttachment")}
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          )}

          <div
            className={cx(
              "rounded-xl border bg-white transition focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-50",
              canSendHumanReply ? "border-slate-200" : "border-slate-200 bg-slate-50"
            )}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={sending || !canSendHumanReply}
              placeholder={
                canSendHumanReply
                  ? attachment
                    ? t("messagesPage.captionPlaceholder")
                    : t("messagesPage.composerPlaceholderEnabled")
                  : t("messagesPage.composerPlaceholderDisabled")
              }
              rows={2}
              dir="auto"
              className="block max-h-40 min-h-[44px] w-full min-w-0 resize-none rounded-t-xl bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
            />
            <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
              <div className="flex items-center gap-0.5">
                {mediaControls.map(({ key, type, labelKey, icon: Icon }) => (
                  <React.Fragment key={key}>
                    <input
                      ref={(el) => {
                        fileInputRefs.current[key] = el;
                      }}
                      type="file"
                      accept={getAcceptAttribute(type)}
                      className="hidden"
                      onChange={(e) => onFileSelected(type, e)}
                    />
                    <button
                      type="button"
                      onClick={() => onMediaButtonClick(key)}
                      disabled={!canSendMedia || sending || !canSendHumanReply}
                      title={canSendMedia ? t(labelKey) : t("messagesPage.mediaComingSoon", { label: t(labelKey) })}
                      aria-label={t(labelKey)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <Icon className="h-[18px] w-[18px]" />
                    </button>
                  </React.Fragment>
                ))}
              </div>
              <button
                type="button"
                onClick={onSend}
                disabled={sending || (!draft.trim() && !attachment) || !canSendHumanReply}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 text-xs font-semibold text-white shadow-sm shadow-indigo-600/20 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? t("messagesPage.sending") : t("messagesPage.send")}
                <PaperAirplaneIcon className="h-4 w-4 rtl:-scale-x-100" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
