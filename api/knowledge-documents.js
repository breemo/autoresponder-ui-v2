import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";
import { ingestDocument } from "./_lib/knowledgeIngestion.js";
import {
  KNOWLEDGE_BUCKET,
  KNOWLEDGE_SIGNED_READ_URL_TTL_SECONDS,
  buildKnowledgeObjectPath,
  knowledgePathBelongsToDocument,
  validateKnowledgeFileMeta,
  isValidCategory,
  sanitizeFileName,
} from "../src/lib/knowledgeDocuments.js";

// AI Engine V1 — Phase 4A: client_knowledge_documents CRUD + ingestion
// trigger.
//
// client_knowledge_documents/client_knowledge_chunks both have RLS
// enabled with zero policies (Phase 1) — the browser's anon-keyed
// Supabase client cannot read or write either table, or the
// client-knowledge Storage bucket, at all. This endpoint is the only
// path to any of it. Never query these tables, or that bucket, directly
// from React/browser Supabase code.
//
// Dual-actor authorization — same MODEL as api/client-ai-behavior.js
// (not the same exported function; that file's resolveActor is local/
// unexported and scoped to its own file, and this endpoint governs a
// different table, so the ~40-line pattern is intentionally mirrored
// here rather than importing across files. A shared api/_lib/
// dualActorAuth.js helper would be a reasonable later DRY pass, not done
// here to avoid touching the already-shipped Phase 2 file for this
// change). Summary of the model (see client-ai-behavior.js's own header
// comment for the full rationale):
//   - admin (users.role === 'admin'): may act on ANY client_id, supplied
//     explicitly and existence-checked, never trusted beyond that.
//   - client (users.role === 'client', active client_users membership):
//     client_id is ALWAYS actor.membership.client_id, server-derived,
//     never accepted from the request. Read requires the AI_SETTINGS
//     permission (Knowledge Base has no dedicated permission key today —
//     reusing AI_SETTINGS since this feature lives alongside AI Behavior
//     on the same settings surface; a dedicated permission is a product
//     decision for later, not made here). Write additionally requires
//     the client's plan to have allow_self_edit === true.
//
// Every document/chunk mutation is scoped by BOTH client_id AND the
// target document_id in its own WHERE clause (not just an earlier read)
// — matches this repo's established ownership-in-the-WHERE-clause
// discipline (see apply_conversation_lifecycle_action's header comment
// for the identical reasoning). A wrong/foreign document_id therefore
// always resolves to a real 404, never a silent no-op or, worse, another
// client's row.
//
// Shape:
//   GET  /api/knowledge-documents?actor_user_id=&client_id=
//     -> { success: true, documents: [...safe...] }
//   POST /api/knowledge-documents
//     { action: "create_upload_intent" | "finalize_upload" | "reprocess"
//         | "delete" | "sign_read",
//       actor_user_id, client_id?, ... action-specific fields }

const DOCUMENT_SELECT_COLUMNS =
  "id, client_id, title, file_name, storage_path, mime_type, file_size_bytes, category, status, status_error, uploaded_by, created_at, updated_at";

function toSafeDocument(row) {
  if (!row) return row;
  const { storage_path, client_id, uploaded_by, ...safe } = row;
  return safe;
}

// Exported for direct unit testing (client isolation / admin target
// access — see api/_lib/__tests__/knowledgeDocumentsAuth.test.js) without
// needing to mock req/res for the whole HTTP handler.
export async function resolveActor(supabase, { actorUserId, requestedClientId }) {
  if (!actorUserId) return { error: { status: 401, message: "Unauthorized" } };

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("id, role, must_change_password")
    .eq("id", actorUserId)
    .maybeSingle();

  if (userError || !userRow) return { error: { status: 401, message: "Unauthorized" } };
  if (userRow.must_change_password) {
    return { error: { status: 403, message: "يجب تغيير كلمة المرور المؤقتة أولاً" } };
  }

  if (userRow.role === "admin") {
    const clientId = typeof requestedClientId === "string" ? requestedClientId.trim() : "";
    if (!clientId) return { error: { status: 400, message: "client_id is required" } };

    const { data: clientRow, error: clientError } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
    if (clientError) return { error: { status: 500, message: "فشل التحقق من العميل" } };
    if (!clientRow) return { error: { status: 404, message: "العميل غير موجود" } };

    return { actor: { kind: "admin", clientId, canWrite: true, actorUserId } };
  }

  if (userRow.role === "client") {
    const actor = await resolveActingMembership(supabase, actorUserId);
    if (!actor) return { error: { status: 401, message: "Unauthorized" } };
    if (!actorHasPermission(actor.membership, PERMISSIONS.AI_SETTINGS)) {
      return { error: { status: 403, message: "Forbidden" } };
    }

    const clientId = actor.membership.client_id;

    const { data: clientRow, error: clientError } = await supabase.from("clients").select("plan_id").eq("id", clientId).maybeSingle();
    if (clientError) return { error: { status: 500, message: "فشل التحقق من الخطة" } };

    let allowSelfEdit = false;
    if (clientRow?.plan_id) {
      const { data: planRow, error: planError } = await supabase.from("plans").select("allow_self_edit").eq("id", clientRow.plan_id).maybeSingle();
      if (planError) return { error: { status: 500, message: "فشل التحقق من الخطة" } };
      allowSelfEdit = planRow?.allow_self_edit === true;
    }

    return { actor: { kind: "client", clientId, canWrite: allowSelfEdit, actorUserId } };
  }

  return { error: { status: 401, message: "Unauthorized" } };
}

async function loadOwnedDocument(supabase, clientId, documentId) {
  const { data, error } = await supabase.from("client_knowledge_documents").select(DOCUMENT_SELECT_COLUMNS).eq("id", documentId).eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  return data;
}

async function deleteStorageObjectBestEffort(supabase, storagePath) {
  if (!storagePath) return;
  try {
    await supabase.storage.from(KNOWLEDGE_BUCKET).remove([storagePath]);
  } catch (error) {
    console.error("knowledge-documents: best-effort storage delete failed:", { storagePath, message: error?.message });
  }
}

async function handleList(req, res, supabase) {
  const { error, actor } = await resolveActor(supabase, { actorUserId: req.query?.actor_user_id, requestedClientId: req.query?.client_id });
  if (error) return res.status(error.status).json({ success: false, message: error.message });

  try {
    const { data, error: rowsError } = await supabase
      .from("client_knowledge_documents")
      .select(DOCUMENT_SELECT_COLUMNS)
      .eq("client_id", actor.clientId)
      .order("created_at", { ascending: false });
    if (rowsError) throw rowsError;

    return res.status(200).json({ success: true, documents: (data || []).map(toSafeDocument), can_edit: actor.canWrite });
  } catch (err) {
    console.error("knowledge-documents: failed to list:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في تحميل المستندات" });
  }
}

async function handleCreateUploadIntent(req, res, supabase, actor) {
  const fileName = sanitizeFileName(req.body?.file_name);
  const mimeType = req.body?.mime_type;
  const sizeBytes = req.body?.file_size_bytes;
  const existingDocumentId = req.body?.document_id; // present only for a "replace" upload

  const metaCheck = validateKnowledgeFileMeta({ mimeType, sizeBytes });
  if (!metaCheck.valid) {
    return res.status(400).json({ success: false, message: metaCheck.reason === "too_large" ? "الملف أكبر من الحجم المسموح" : "نوع الملف غير مدعوم", code: metaCheck.reason });
  }

  let documentId = existingDocumentId;
  if (documentId) {
    const existing = await loadOwnedDocument(supabase, actor.clientId, documentId);
    if (!existing) return res.status(404).json({ success: false, message: "المستند غير موجود ضمن هذا الحساب" });
  } else {
    documentId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const storagePath = buildKnowledgeObjectPath({ clientId: actor.clientId, documentId, fileName });

  try {
    const { data, error } = await supabase.storage.from(KNOWLEDGE_BUCKET).createSignedUploadUrl(storagePath);
    if (error || !data) {
      // Expected until the bucket is created (manual Storage setup — see
      // the Phase 4A report) — degrade gracefully rather than a raw 500,
      // matching api/media.js's identical precedent exactly.
      return res.status(503).json({ success: false, message: "Storage is not available yet", code: "STORAGE_UNAVAILABLE" });
    }

    return res.status(200).json({
      success: true,
      document_id: documentId,
      bucket: KNOWLEDGE_BUCKET,
      path: data.path || storagePath,
      token: data.token,
    });
  } catch (error) {
    return res.status(503).json({ success: false, message: "Storage is not available yet", code: "STORAGE_UNAVAILABLE" });
  }
}

async function handleFinalizeUpload(req, res, supabase, actor) {
  const documentId = req.body?.document_id;
  const storagePath = req.body?.storage_path;
  const fileName = sanitizeFileName(req.body?.file_name);
  const mimeType = req.body?.mime_type;
  const sizeBytes = req.body?.file_size_bytes;
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const category = req.body?.category ?? null;

  if (!documentId || !storagePath) {
    return res.status(400).json({ success: false, message: "document_id and storage_path are required" });
  }

  const metaCheck = validateKnowledgeFileMeta({ mimeType, sizeBytes });
  if (!metaCheck.valid) {
    return res.status(400).json({ success: false, message: metaCheck.reason === "too_large" ? "الملف أكبر من الحجم المسموح" : "نوع الملف غير مدعوم", code: metaCheck.reason });
  }
  if (!isValidCategory(category)) {
    return res.status(400).json({ success: false, message: "نوع المستند غير صالح" });
  }
  // Defense in depth — create_upload_intent already derived this exact
  // path server-side, but finalize is a separate request and must not
  // trust a client-supplied storage_path blindly.
  if (!knowledgePathBelongsToDocument({ storagePath, clientId: actor.clientId, documentId })) {
    return res.status(400).json({ success: false, message: "مسار الملف غير صالح" });
  }

  try {
    const existing = await loadOwnedDocument(supabase, actor.clientId, documentId);
    const previousStoragePath = existing?.storage_path;

    if (existing) {
      const { error: updateError } = await supabase
        .from("client_knowledge_documents")
        .update({
          title: title || fileName,
          file_name: fileName,
          storage_path: storagePath,
          mime_type: mimeType,
          file_size_bytes: sizeBytes,
          category,
          status: "uploaded",
          status_error: null,
          uploaded_by: actor.actorUserId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId)
        .eq("client_id", actor.clientId);
      if (updateError) throw updateError;

      if (previousStoragePath && previousStoragePath !== storagePath) {
        await deleteStorageObjectBestEffort(supabase, previousStoragePath);
      }
    } else {
      const { error: insertError } = await supabase.from("client_knowledge_documents").insert({
        id: documentId,
        client_id: actor.clientId,
        title: title || fileName,
        file_name: fileName,
        storage_path: storagePath,
        mime_type: mimeType,
        file_size_bytes: sizeBytes,
        category,
        status: "uploaded",
        uploaded_by: actor.actorUserId,
      });
      if (insertError) throw insertError;
    }

    await ingestDocument(supabase, { clientId: actor.clientId, documentId, storagePath, mimeType, fileName, category });

    const finalRow = await loadOwnedDocument(supabase, actor.clientId, documentId);
    return res.status(200).json({ success: true, document: toSafeDocument(finalRow) });
  } catch (err) {
    console.error("knowledge-documents: failed to finalize upload:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في حفظ المستند" });
  }
}

async function handleReprocess(req, res, supabase, actor) {
  const documentId = req.body?.document_id;
  if (!documentId) return res.status(400).json({ success: false, message: "document_id is required" });

  try {
    const existing = await loadOwnedDocument(supabase, actor.clientId, documentId);
    if (!existing) return res.status(404).json({ success: false, message: "المستند غير موجود ضمن هذا الحساب" });

    await ingestDocument(supabase, {
      clientId: actor.clientId,
      documentId,
      storagePath: existing.storage_path,
      mimeType: existing.mime_type,
      fileName: existing.file_name,
      category: existing.category,
    });

    const finalRow = await loadOwnedDocument(supabase, actor.clientId, documentId);
    return res.status(200).json({ success: true, document: toSafeDocument(finalRow) });
  } catch (err) {
    console.error("knowledge-documents: failed to reprocess:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في إعادة معالجة المستند" });
  }
}

async function handleDelete(req, res, supabase, actor) {
  const documentId = req.body?.document_id;
  if (!documentId) return res.status(400).json({ success: false, message: "document_id is required" });

  try {
    const existing = await loadOwnedDocument(supabase, actor.clientId, documentId);
    if (!existing) return res.status(404).json({ success: false, message: "المستند غير موجود ضمن هذا الحساب" });

    // Ownership enforced directly in the DELETE's own WHERE clause, not
    // just the earlier read.
    const { error: deleteError } = await supabase.from("client_knowledge_documents").delete().eq("id", documentId).eq("client_id", actor.clientId);
    if (deleteError) throw deleteError;
    // client_knowledge_chunks rows cascade automatically (ON DELETE
    // CASCADE, Phase 1 migration) — no separate chunk-delete call needed.

    await deleteStorageObjectBestEffort(supabase, existing.storage_path);

    return res.status(200).json({ success: true, deleted_id: documentId });
  } catch (err) {
    console.error("knowledge-documents: failed to delete:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في حذف المستند" });
  }
}

async function handleSignRead(req, res, supabase, actor) {
  const documentId = req.body?.document_id;
  if (!documentId) return res.status(400).json({ success: false, message: "document_id is required" });

  try {
    const existing = await loadOwnedDocument(supabase, actor.clientId, documentId);
    if (!existing) return res.status(404).json({ success: false, message: "المستند غير موجود ضمن هذا الحساب" });

    const { data, error } = await supabase.storage.from(KNOWLEDGE_BUCKET).createSignedUrl(existing.storage_path, KNOWLEDGE_SIGNED_READ_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      return res.status(503).json({ success: false, message: "Storage is not available yet", code: "STORAGE_UNAVAILABLE" });
    }

    return res.status(200).json({ success: true, url: data.signedUrl, expires_in: KNOWLEDGE_SIGNED_READ_URL_TTL_SECONDS });
  } catch (err) {
    console.error("knowledge-documents: failed to sign read url:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في إنشاء رابط العرض" });
  }
}

export default async function handler(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") return handleList(req, res, supabase);

  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });

  const { error, actor } = await resolveActor(supabase, { actorUserId: req.body?.actor_user_id, requestedClientId: req.body?.client_id });
  if (error) return res.status(error.status).json({ success: false, message: error.message });

  const action = req.body?.action;

  if (action === "sign_read") return handleSignRead(req, res, supabase, actor);

  if (!actor.canWrite) return res.status(403).json({ success: false, message: "Forbidden" });

  if (action === "create_upload_intent") return handleCreateUploadIntent(req, res, supabase, actor);
  if (action === "finalize_upload") return handleFinalizeUpload(req, res, supabase, actor);
  if (action === "reprocess") return handleReprocess(req, res, supabase, actor);
  if (action === "delete") return handleDelete(req, res, supabase, actor);

  return res.status(400).json({ success: false, message: "Unknown action" });
}
