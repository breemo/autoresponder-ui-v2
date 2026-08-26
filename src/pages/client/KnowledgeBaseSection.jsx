import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpTrayIcon,
  ArrowPathIcon,
  DocumentTextIcon,
  EyeIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

// AI Engine V1 — Phase 3 prep (Part C). UI SHELL ONLY.
//
// No backend exists yet for this: no client_knowledge_documents API, no
// storage bucket, no ingestion worker (all deliberately deferred — see
// the Knowledge Base Backend Next-Step Plan in the accompanying report).
// Every document "added" here lives only in this component's local React
// state and is gone on reload — never persisted, never uploaded anywhere.
// The previewNotice banner below says exactly that, in-product, so this
// is never presented to a real client as working functionality.
//
// Built ready to connect: once /api/knowledge-documents /
// /api/knowledge-upload exist (a later phase), loadDocuments()/
// handleAddDocument()/handleReprocess()/handleReplace()/handleDelete()
// below are the exact, only, functions that need their local-state
// mutation replaced with a real fetch() call — same shape client-
// facebook.js's callApi() pattern already uses elsewhere in this app.
// The rendered UI itself does not need to change.
//
// Category values are the same fixed set requested in the product spec
// (Menu / Price List / Brochure / Services Catalog / FAQ / Policy /
// Other) — translated for display via categoryLabelFor(), stored as a
// stable lowercase key so a later real API can use the same values
// without a UI-side remap.
const CATEGORIES = ["menu", "price_list", "brochure", "services_catalog", "faq", "policy", "other"];

function categoryLabelFor(category, t) {
  const map = {
    menu: t("knowledgeBase.categoryMenu"),
    price_list: t("knowledgeBase.categoryPriceList"),
    brochure: t("knowledgeBase.categoryBrochure"),
    services_catalog: t("knowledgeBase.categoryServicesCatalog"),
    faq: t("knowledgeBase.categoryFaq"),
    policy: t("knowledgeBase.categoryPolicy"),
    other: t("knowledgeBase.categoryOther"),
  };
  return map[category] || category;
}

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

function extensionOf(fileName) {
  const parts = String(fileName || "").split(".");
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "—";
}

const STATUS_STYLES = {
  uploaded: "bg-slate-100 text-slate-600 ring-slate-200",
  processing: "bg-amber-50 text-amber-700 ring-amber-100",
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  failed: "bg-rose-50 text-rose-700 ring-rose-100",
};

function StatusBadge({ status, t }) {
  const label = t(`knowledgeBase.status${status.charAt(0).toUpperCase()}${status.slice(1)}`);
  const isProcessing = status === "processing";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${STATUS_STYLES[status] || STATUS_STYLES.uploaded}`}>
      {isProcessing && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />}
      {label}
    </span>
  );
}

export default function KnowledgeBaseSection({ readOnly = false }) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // { file, title, category } — awaiting "Add Document"
  const [viewingDocument, setViewingDocument] = useState(null);
  const fileInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const replaceTargetId = useRef(null);

  const hasDocuments = documents.length > 0;

  function openPendingFile(file) {
    if (!file) return;
    const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
    setPendingFile({ file, title: nameWithoutExt, category: "other" });
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (readOnly) return;
    const file = e.dataTransfer.files?.[0];
    openPendingFile(file);
  }

  function handleBrowseChange(e) {
    const file = e.target.files?.[0];
    openPendingFile(file);
    e.target.value = "";
  }

  // TODO Phase 6: replace this local-state push with
  //   POST /api/knowledge-upload (signed URL) -> upload -> POST
  //   /api/knowledge-documents { action: "create", ... }
  // and reload from GET /api/knowledge-documents instead of appending
  // directly — the rest of this component reads only `documents` state,
  // so that swap is fully contained to this one function.
  function handleAddDocument() {
    if (!pendingFile) return;
    const { file, title, category } = pendingFile;
    setDocuments((prev) => [
      {
        id: `local-${Date.now()}`,
        title: title.trim() || file.name,
        category,
        file_name: file.name,
        file_type: extensionOf(file.name),
        size: file.size,
        status: "uploaded",
        updated_at: new Date().toISOString(),
      },
      ...prev,
    ]);
    setPendingFile(null);
  }

  // TODO Phase 6: replace with POST /api/knowledge-documents
  //   { action: "reprocess", id }, then reflect the returned row's real
  // status instead of this simulated timeout.
  function handleReprocess(id) {
    setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, status: "processing", updated_at: new Date().toISOString() } : doc)));
    setTimeout(() => {
      setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, status: "ready", updated_at: new Date().toISOString() } : doc)));
    }, 1200);
  }

  function handleReplaceClick(id) {
    replaceTargetId.current = id;
    replaceInputRef.current?.click();
  }

  // TODO Phase 6: replace with a real upload + POST
  //   /api/knowledge-documents { action: "update", id, ... }.
  function handleReplaceChange(e) {
    const file = e.target.files?.[0];
    const id = replaceTargetId.current;
    if (file && id) {
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === id
            ? { ...doc, file_name: file.name, file_type: extensionOf(file.name), size: file.size, status: "uploaded", updated_at: new Date().toISOString() }
            : doc
        )
      );
    }
    e.target.value = "";
    replaceTargetId.current = null;
  }

  // TODO Phase 6: replace with POST /api/knowledge-documents
  //   { action: "delete", id } (which also removes the Storage object and
  // its chunks server-side).
  function handleDelete(id) {
    if (!window.confirm(t("knowledgeBase.confirmDelete"))) return;
    setDocuments((prev) => prev.filter((doc) => doc.id !== id));
  }

  const rows = useMemo(
    () =>
      documents.map((doc) => ({
        ...doc,
        categoryLabel: categoryLabelFor(doc.category, t),
        sizeLabel: formatFileSize(doc.size),
        updatedLabel: formatDate(doc.updated_at),
      })),
    [documents, t]
  );

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-xl">📚</div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-black text-slate-950">{t("knowledgeBase.title")}</h3>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-100">
                {t("knowledgeBase.previewBadge")}
              </span>
            </div>
            <p className="text-xs text-slate-500">{t("knowledgeBase.subtitle")}</p>
          </div>
        </div>
      </div>

      <div className="mb-5 rounded-2xl border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
        {t("knowledgeBase.previewNotice")}
      </div>

      {!readOnly && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`mb-6 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition ${
            dragOver ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-slate-50"
          }`}
        >
          <ArrowUpTrayIcon className="h-8 w-8 text-slate-400" />
          <p className="text-sm font-semibold text-slate-700">{t("knowledgeBase.dropzoneTitle")}</p>
          <p className="text-xs text-slate-400">{t("knowledgeBase.dropzoneOr")}</p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-2xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            {t("knowledgeBase.browseButton")}
          </button>
          <p className="text-[11px] text-slate-400">{t("knowledgeBase.dropzoneHint")}</p>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleBrowseChange} accept=".pdf,.doc,.docx,.txt" />
        </div>
      )}

      <input ref={replaceInputRef} type="file" className="hidden" onChange={handleReplaceChange} accept=".pdf,.doc,.docx,.txt" />

      {!hasDocuments ? (
        <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center">
          <DocumentTextIcon className="mx-auto mb-3 h-9 w-9 text-slate-300" />
          <p className="font-semibold text-slate-700">{t("knowledgeBase.emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{t("knowledgeBase.emptyDescription")}</p>
        </div>
      ) : (
        <>
          {/* Desktop / tablet: table */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-start text-xs text-slate-500">
                  <th className="py-2 pe-3 font-semibold">{t("knowledgeBase.columnName")}</th>
                  <th className="py-2 pe-3 font-semibold">{t("knowledgeBase.columnType")}</th>
                  <th className="py-2 pe-3 font-semibold">{t("knowledgeBase.columnFileType")}</th>
                  <th className="py-2 pe-3 font-semibold">{t("knowledgeBase.columnSize")}</th>
                  <th className="py-2 pe-3 font-semibold">{t("knowledgeBase.columnStatus")}</th>
                  <th className="py-2 pe-3 font-semibold">{t("knowledgeBase.columnUpdated")}</th>
                  <th className="py-2 font-semibold">{t("knowledgeBase.columnActions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((doc) => (
                  <tr key={doc.id} className="border-b border-slate-50">
                    <td className="max-w-[220px] truncate py-3 pe-3 font-semibold text-slate-800">{doc.title}</td>
                    <td className="py-3 pe-3 text-slate-600">{doc.categoryLabel}</td>
                    <td className="py-3 pe-3 text-slate-600">{doc.file_type}</td>
                    <td className="py-3 pe-3 text-slate-600">{doc.sizeLabel}</td>
                    <td className="py-3 pe-3"><StatusBadge status={doc.status} t={t} /></td>
                    <td className="py-3 pe-3 text-slate-500">{doc.updatedLabel}</td>
                    <td className="py-3">
                      <DocumentRowActions doc={doc} readOnly={readOnly} t={t} onView={setViewingDocument} onReprocess={handleReprocess} onReplace={handleReplaceClick} onDelete={handleDelete} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="space-y-3 sm:hidden">
            {rows.map((doc) => (
              <div key={doc.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-800">{doc.title}</p>
                    <p className="text-xs text-slate-500">{doc.categoryLabel} · {doc.file_type} · {doc.sizeLabel}</p>
                  </div>
                  <StatusBadge status={doc.status} t={t} />
                </div>
                <p className="mt-2 text-xs text-slate-400">{doc.updatedLabel}</p>
                <div className="mt-3">
                  <DocumentRowActions doc={doc} readOnly={readOnly} t={t} onView={setViewingDocument} onReprocess={handleReprocess} onReplace={handleReplaceClick} onDelete={handleDelete} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h4 className="font-bold text-slate-900">{pendingFile.file.name}</h4>
              <button type="button" onClick={() => setPendingFile(null)}><XMarkIcon className="h-5 w-5 text-slate-400" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">{t("knowledgeBase.titleFieldLabel")}</label>
                <input
                  type="text"
                  value={pendingFile.title}
                  onChange={(e) => setPendingFile((prev) => ({ ...prev, title: e.target.value }))}
                  placeholder={t("knowledgeBase.titleFieldPlaceholder")}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">{t("knowledgeBase.categoryLabel")}</label>
                <select
                  value={pendingFile.category}
                  onChange={(e) => setPendingFile((prev) => ({ ...prev, category: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{categoryLabelFor(cat, t)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={handleAddDocument} className="flex-1 rounded-2xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">
                {t("knowledgeBase.addDocument")}
              </button>
              <button type="button" onClick={() => setPendingFile(null)} className="rounded-2xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">
                {t("knowledgeBase.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewingDocument && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h4 className="font-bold text-slate-900">{t("knowledgeBase.viewDetailsTitle")}</h4>
              <button type="button" onClick={() => setViewingDocument(null)}><XMarkIcon className="h-5 w-5 text-slate-400" /></button>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-slate-500">{t("knowledgeBase.columnName")}</dt><dd className="truncate font-semibold text-slate-800">{viewingDocument.title}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">{t("knowledgeBase.columnType")}</dt><dd className="font-semibold text-slate-800">{categoryLabelFor(viewingDocument.category, t)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">{t("knowledgeBase.columnFileType")}</dt><dd className="font-semibold text-slate-800">{viewingDocument.file_type}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">{t("knowledgeBase.columnSize")}</dt><dd className="font-semibold text-slate-800">{formatFileSize(viewingDocument.size)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">{t("knowledgeBase.columnStatus")}</dt><dd><StatusBadge status={viewingDocument.status} t={t} /></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">{t("knowledgeBase.columnUpdated")}</dt><dd className="font-semibold text-slate-800">{formatDate(viewingDocument.updated_at)}</dd></div>
            </dl>
            <button type="button" onClick={() => setViewingDocument(null)} className="mt-5 w-full rounded-2xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">
              {t("knowledgeBase.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentRowActions({ doc, readOnly, t, onView, onReprocess, onReplace, onDelete }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => onView(doc)} title={t("knowledgeBase.actionView")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
        <EyeIcon className="h-4 w-4" />
      </button>
      {!readOnly && (
        <>
          <button type="button" onClick={() => onReprocess(doc.id)} title={t("knowledgeBase.actionReprocess")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
            <ArrowPathIcon className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => onReplace(doc.id)} title={t("knowledgeBase.actionReplace")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
            <ArrowUpTrayIcon className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => onDelete(doc.id)} title={t("knowledgeBase.actionDelete")} className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50">
            <TrashIcon className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
