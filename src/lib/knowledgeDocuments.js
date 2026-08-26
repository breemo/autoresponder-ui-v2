// AI Engine V1 — Phase 4A: Knowledge Base document constants/helpers.
// Shared by both api/knowledge-documents.js (server-side, authoritative)
// and src/pages/client/KnowledgeBaseSection.jsx (browser-side, UX hints
// only — never a security boundary by itself, matching the exact
// convention already established in src/lib/mediaMessages.js).
//
// sanitizeFileName is intentionally reused from mediaMessages.js rather
// than duplicated — it's a generic filename sanitizer with no media-
// specific logic in it.
import { sanitizeFileName } from "./mediaMessages.js";

export { sanitizeFileName };

// Private bucket, NOT created by this phase — see the accompanying Phase
// 4A report for the manual Storage setup this still requires (same
// pattern as MEDIA_BUCKET in mediaMessages.js: centralized here so every
// reference to the bucket name comes from exactly one place).
export const KNOWLEDGE_BUCKET = "client-knowledge";

// Single source of truth for the category picker — KnowledgeBaseSection.jsx
// renders these, api/knowledge-documents.js validates against the same
// list before ever writing to client_knowledge_documents.category, and
// the Phase 4A migration's CHECK constraint mirrors this exact value set.
// Keep all three in sync if this set ever changes.
export const KNOWLEDGE_CATEGORIES = ["menu", "price_list", "brochure", "services_catalog", "faq", "policy", "other"];

export function isValidCategory(category) {
  return category === null || category === undefined || KNOWLEDGE_CATEGORIES.includes(category);
}

// MVP-supported file types (Phase 4A spec §2/§10 — PDF, DOCX, TXT, CSV;
// XLSX deliberately excluded: no reliable parsing dependency already
// vetted for it in this pass, and the spec only allows it "if the
// existing stack supports it reliably" — it doesn't yet).
export const KNOWLEDGE_MIME_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/csv": "csv",
};

export const KNOWLEDGE_ACCEPT_ATTRIBUTE = Object.keys(KNOWLEDGE_MIME_TYPES).join(",");

// 20 MB — matches the existing MEDIA_LIMITS[document] ceiling in
// mediaMessages.js, reused as the same practical ceiling rather than
// inventing a different number with no basis.
export const KNOWLEDGE_MAX_FILE_BYTES = 20 * 1024 * 1024;

export function validateKnowledgeFileMeta({ mimeType, sizeBytes }) {
  if (!KNOWLEDGE_MIME_TYPES[mimeType]) return { valid: false, reason: "unsupported_type" };
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return { valid: false, reason: "unsupported_type" };
  if (size > KNOWLEDGE_MAX_FILE_BYTES) return { valid: false, reason: "too_large", maxBytes: KNOWLEDGE_MAX_FILE_BYTES };
  return { valid: true };
}

// createSignedUrl() TTL for previewing/downloading the original file —
// short-lived, matches mediaMessages.js's SIGNED_READ_URL_TTL_SECONDS
// convention exactly (no permanent public URLs, per the hard security
// requirement).
export const KNOWLEDGE_SIGNED_READ_URL_TTL_SECONDS = 300;

// Object path convention: {client_id}/{document_id}/{unique-id}-{safe-file-name}
// — the exact same shape as buildMediaObjectPath in mediaMessages.js.
// clientId and documentId must always be server-derived (see
// api/knowledge-documents.js: actor.membership.client_id from
// resolveActor(), documentId either freshly generated server-side for a
// new document or an existing row's own id, already ownership-checked)
// — never raw request input. The unique-id component means a replace
// upload never collides with (or accidentally overwrites) the object the
// old row still points at until finalize explicitly swaps it over.
export function buildKnowledgeObjectPath({ clientId, documentId, fileName }) {
  const uniqueId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${clientId}/${documentId}/${uniqueId}-${sanitizeFileName(fileName)}`;
}

// Verifies a storage_path sits inside the {clientId}/{documentId}/ Storage
// namespace buildKnowledgeObjectPath above always mints into — same
// ownership-signal role as mediaPathBelongsToConversation in
// mediaMessages.js.
export function knowledgePathBelongsToDocument({ storagePath, clientId, documentId }) {
  if (typeof storagePath !== "string" || !storagePath) return false;
  const prefix = `${clientId}/${documentId}/`;
  return storagePath.startsWith(prefix) && storagePath.length > prefix.length;
}
