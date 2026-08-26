import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpTrayIcon,
  ArrowPathIcon,
  DocumentTextIcon,
  EyeIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient.js";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_ACCEPT_ATTRIBUTE, validateKnowledgeFileMeta } from "../../lib/knowledgeDocuments.js";

// AI Engine V1 — Phase 4A: real backend connection.
//
// client_knowledge_documents has RLS enabled with zero browser policies
// (Phase 1) — every read/write here goes through /api/knowledge-documents
// (service-role Supabase server-side), never a direct
// supabase.from("client_knowledge_documents") call. The one browser-side
// Supabase call in this file (uploadToSignedUrl below) writes bytes
// directly to Storage using a short-lived signed URL/token this endpoint
// mints — the same shape as the (not-yet-wired) chat-media upload flow
// in api/media.js. No credential of any kind is ever visible to this
// component.
//
// Category values come from the shared src/lib/knowledgeDocuments.js
// constant — the same list the API validates against and the Phase 4A
// migration's CHECK constraint enforces.
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

// Server response uses file_name/file_size_bytes/mime_type (the real
// column names) — normalized here to the same file_type/size shape this
// component's rendering already used, so the JSX below (deliberately
// unchanged/not redesigned) needs no further edits.
function normalizeDocument(row) {
  if (!row) return row;
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    file_name: row.file_name,
    file_type: extensionOf(row.file_name),
    size: row.file_size_bytes,
    status: row.status,
    status_error: row.status_error,
    updated_at: row.updated_at,
  };
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

export default function KnowledgeBaseSection({ clientId, actorUserId, readOnly = false }) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // { file, title, category } — awaiting "Add Document"
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState(null); // document id currently reprocessing/replacing/deleting
  const [viewingDocument, setViewingDocument] = useState(null);
  const [viewUrl, setViewUrl] = useState("");
  const fileInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const replaceTargetId = useRef(null);

  const hasDocuments = documents.length > 0;

  useEffect(() => {
    if (clientId) loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function loadDocuments() {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`/api/knowledge-documents?actor_user_id=${encodeURIComponent(actorUserId || "")}&client_id=${encodeURIComponent(clientId || "")}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) throw new Error(data?.message || t("knowledgeBase.errLoadFailed"));
      setDocuments((data.documents || []).map(normalizeDocument));
    } catch (err) {
      console.error(err);
      setError(t("knowledgeBase.errLoadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function callApi(action, payload = {}) {
    const response = await fetch("/api/knowledge-documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, actor_user_id: actorUserId, client_id: clientId, ...payload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) throw new Error(data?.message);
    return data;
  }

  // Two-step upload: mint a signed URL/token scoped to this exact
  // document (create_upload_intent), write the bytes directly to Storage
  // with the browser's own Supabase client (the signed token IS the
  // authorization for this one write — the bucket itself still has no
  // browser-readable policies), then finalize_upload registers/updates
  // the row and triggers ingestion server-side.
  async function uploadFile(file, existingDocumentId) {
    const intent = await callApi("create_upload_intent", {
      file_name: file.name,
      mime_type: file.type,
      file_size_bytes: file.size,
      ...(existingDocumentId ? { document_id: existingDocumentId } : {}),
    });

    const { error: uploadError } = await supabase.storage.from(intent.bucket).uploadToSignedUrl(intent.path, intent.token, file);
    if (uploadError) throw new Error(t("knowledgeBase.errUploadFailed"));

    return intent;
  }

  function openPendingFile(file) {
    if (!file) return;
    const check = validateKnowledgeFileMeta({ mimeType: file.type, sizeBytes: file.size });
    if (!check.valid) {
      setError(t("knowledgeBase.errUploadFailed"));
      return;
    }
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

  async function handleAddDocument() {
    if (!pendingFile) return;
    const { file, title, category } = pendingFile;
    setUploading(true);
    setError("");
    try {
      const intent = await uploadFile(file);
      const finalized = await callApi("finalize_upload", {
        document_id: intent.document_id,
        storage_path: intent.path,
        file_name: file.name,
        mime_type: file.type,
        file_size_bytes: file.size,
        title: title.trim() || file.name,
        category,
      });
      setDocuments((prev) => [normalizeDocument(finalized.document), ...prev]);
      setPendingFile(null);
    } catch (err) {
      console.error(err);
      setError(err.message || t("knowledgeBase.errUploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function handleReprocess(id) {
    setBusyId(id);
    setError("");
    try {
      const result = await callApi("reprocess", { document_id: id });
      setDocuments((prev) => prev.map((doc) => (doc.id === id ? normalizeDocument(result.document) : doc)));
    } catch (err) {
      console.error(err);
      setError(err.message || t("knowledgeBase.errActionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  function handleReplaceClick(id) {
    replaceTargetId.current = id;
    replaceInputRef.current?.click();
  }

  async function handleReplaceChange(e) {
    const file = e.target.files?.[0];
    const id = replaceTargetId.current;
    e.target.value = "";
    replaceTargetId.current = null;
    if (!file || !id) return;

    setBusyId(id);
    setError("");
    try {
      const intent = await uploadFile(file, id);
      const finalized = await callApi("finalize_upload", {
        document_id: id,
        storage_path: intent.path,
        file_name: file.name,
        mime_type: file.type,
        file_size_bytes: file.size,
      });
      setDocuments((prev) => prev.map((doc) => (doc.id === id ? normalizeDocument(finalized.document) : doc)));
    } catch (err) {
      console.error(err);
      setError(err.message || t("knowledgeBase.errUploadFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm(t("knowledgeBase.confirmDelete"))) return;
    setBusyId(id);
    setError("");
    try {
      await callApi("delete", { document_id: id });
      setDocuments((prev) => prev.filter((doc) => doc.id !== id));
    } catch (err) {
      console.error(err);
      setError(err.message || t("knowledgeBase.errActionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleView(doc) {
    setViewingDocument(doc);
    setViewUrl("");
    try {
      const result = await callApi("sign_read", { document_id: doc.id });
      setViewUrl(result.url || "");
    } catch (err) {
      console.error(err);
      // Non-fatal — the details modal still shows metadata even if the
      // signed URL couldn't be minted (e.g. Storage not provisioned yet).
    }
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
            <h3 className="font-black text-slate-950">{t("knowledgeBase.title")}</h3>
            <p className="text-xs text-slate-500">{t("knowledgeBase.subtitle")}</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-5 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>
      )}

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
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleBrowseChange} accept={KNOWLEDGE_ACCEPT_ATTRIBUTE} />
        </div>
      )}

      <input ref={replaceInputRef} type="file" className="hidden" onChange={handleReplaceChange} accept={KNOWLEDGE_ACCEPT_ATTRIBUTE} />

      {loading ? (
        <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">{t("common.loading")}</div>
      ) : !hasDocuments ? (
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
                      <DocumentRowActions doc={doc} readOnly={readOnly} busy={busyId === doc.id} t={t} onView={handleView} onReprocess={handleReprocess} onReplace={handleReplaceClick} onDelete={handleDelete} />
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
                  <DocumentRowActions doc={doc} readOnly={readOnly} busy={busyId === doc.id} t={t} onView={handleView} onReprocess={handleReprocess} onReplace={handleReplaceClick} onDelete={handleDelete} />
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
                  disabled={uploading}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">{t("knowledgeBase.categoryLabel")}</label>
                <select
                  value={pendingFile.category}
                  onChange={(e) => setPendingFile((prev) => ({ ...prev, category: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  disabled={uploading}
                >
                  {KNOWLEDGE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{categoryLabelFor(cat, t)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={handleAddDocument} disabled={uploading} className="flex-1 rounded-2xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-60">
                {uploading ? t("settings.saving") : t("knowledgeBase.addDocument")}
              </button>
              <button type="button" onClick={() => setPendingFile(null)} disabled={uploading} className="rounded-2xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
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
              {viewingDocument.status === "failed" && viewingDocument.status_error && (
                <div className="flex justify-between gap-3"><dt className="text-slate-500">{t("knowledgeBase.columnStatus")}</dt><dd className="font-semibold text-rose-600">{viewingDocument.status_error}</dd></div>
              )}
            </dl>
            {viewUrl && (
              <a href={viewUrl} target="_blank" rel="noopener noreferrer" className="mt-4 block text-center text-sm font-semibold text-indigo-600 hover:underline">
                {t("knowledgeBase.openFile")}
              </a>
            )}
            <button type="button" onClick={() => setViewingDocument(null)} className="mt-4 w-full rounded-2xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">
              {t("knowledgeBase.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentRowActions({ doc, readOnly, busy, t, onView, onReprocess, onReplace, onDelete }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => onView(doc)} title={t("knowledgeBase.actionView")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
        <EyeIcon className="h-4 w-4" />
      </button>
      {!readOnly && (
        <>
          <button type="button" disabled={busy} onClick={() => onReprocess(doc.id)} title={t("knowledgeBase.actionReprocess")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
            <ArrowPathIcon className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          </button>
          <button type="button" disabled={busy} onClick={() => onReplace(doc.id)} title={t("knowledgeBase.actionReplace")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
            <ArrowUpTrayIcon className="h-4 w-4" />
          </button>
          <button type="button" disabled={busy} onClick={() => onDelete(doc.id)} title={t("knowledgeBase.actionDelete")} className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50 disabled:opacity-40">
            <TrashIcon className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
