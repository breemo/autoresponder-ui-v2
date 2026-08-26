import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_CATEGORIES,
  isValidCategory,
  validateKnowledgeFileMeta,
  buildKnowledgeObjectPath,
  knowledgePathBelongsToDocument,
  sanitizeFileName,
} from "../../../src/lib/knowledgeDocuments.js";

test("category validation: accepts every known category plus null/undefined (unset)", () => {
  for (const category of KNOWLEDGE_CATEGORIES) {
    assert.equal(isValidCategory(category), true);
  }
  assert.equal(isValidCategory(null), true);
  assert.equal(isValidCategory(undefined), true);
});

test("category validation: rejects anything not in the fixed set", () => {
  assert.equal(isValidCategory("random_category"), false);
  assert.equal(isValidCategory("MENU"), false); // case-sensitive, matches the DB CHECK constraint exactly
});

test("unsupported type rejection: only the 4 MVP mime types are accepted", () => {
  assert.equal(validateKnowledgeFileMeta({ mimeType: "application/pdf", sizeBytes: 1000 }).valid, true);
  assert.equal(validateKnowledgeFileMeta({ mimeType: "text/plain", sizeBytes: 1000 }).valid, true);
  assert.equal(validateKnowledgeFileMeta({ mimeType: "application/vnd.ms-excel", sizeBytes: 1000 }).valid, false); // xlsx explicitly out of scope
  assert.equal(validateKnowledgeFileMeta({ mimeType: "image/png", sizeBytes: 1000 }).valid, false);
  assert.equal(validateKnowledgeFileMeta({ mimeType: "application/pdf", sizeBytes: 1000 }).reason, undefined);
  assert.equal(validateKnowledgeFileMeta({ mimeType: "image/png", sizeBytes: 1000 }).reason, "unsupported_type");
});

test("file size limit is enforced", () => {
  const tooLarge = 25 * 1024 * 1024;
  const result = validateKnowledgeFileMeta({ mimeType: "application/pdf", sizeBytes: tooLarge });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "too_large");
});

test("filename sanitization: strips path components and unsafe characters", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("menu (final) v2!!.pdf"), "menu_final_v2_.pdf");
  assert.equal(sanitizeFileName(""), "file");
});

test("path isolation: buildKnowledgeObjectPath always nests under {clientId}/{documentId}/", () => {
  const path = buildKnowledgeObjectPath({ clientId: "client-1", documentId: "doc-1", fileName: "menu.pdf" });
  assert.ok(path.startsWith("client-1/doc-1/"));
  assert.match(path, /menu\.pdf$/);
});

test("path isolation: knowledgePathBelongsToDocument rejects a path from a different client or document", () => {
  const path = buildKnowledgeObjectPath({ clientId: "client-1", documentId: "doc-1", fileName: "menu.pdf" });
  assert.equal(knowledgePathBelongsToDocument({ storagePath: path, clientId: "client-1", documentId: "doc-1" }), true);
  assert.equal(knowledgePathBelongsToDocument({ storagePath: path, clientId: "client-2", documentId: "doc-1" }), false);
  assert.equal(knowledgePathBelongsToDocument({ storagePath: path, clientId: "client-1", documentId: "doc-2" }), false);
  assert.equal(knowledgePathBelongsToDocument({ storagePath: "../client-1/doc-1/menu.pdf", clientId: "client-1", documentId: "doc-1" }), false);
});
