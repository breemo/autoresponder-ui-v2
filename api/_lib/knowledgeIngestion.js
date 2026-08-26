// AI Engine V1 — Phase 4A/4B: text extraction + chunking + embedding +
// ingestion orchestration.
//
// extractText/chunkText are pure and DB/storage/network-free — directly
// unit-testable with in-memory buffers, no live Supabase or OpenAI
// needed. ingestDocument is the only function here that touches Supabase
// (DB + Storage) and OpenAI (via embedTexts), and it is the single place
// both "finalize a new/replaced upload" and "reprocess an existing
// document" call into, so chunk-replacement behavior can never drift
// between the two call sites.
//
// Failure semantics (Phase 4B addition) — see ingestDocument's own
// comment for the full explanation: a failure at ANY stage (extraction,
// chunking, or embedding) never deletes a previous successful chunk set.
// replaceChunks — the only function that ever deletes old chunks — is
// called strictly AFTER extraction, chunking, AND embedding have all
// already succeeded, never before.
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { KNOWLEDGE_BUCKET } from "../../src/lib/knowledgeDocuments.js";
import { embedTexts } from "./openaiEmbeddings.js";

const CHUNK_SIZE = 800; // characters, not tokens — see the report for why a
// token-based size was not used (would need a tokenizer dependency; out of
// scope for "minimal, reputable packages only if required").
const CHUNK_OVERLAP = 100;

// Minimal, dependency-free CSV parser — handles quoted fields (including
// embedded commas/newlines/escaped quotes), which is the part a naive
// `line.split(",")` gets wrong. Deliberately not RFC4180-exhaustive
// (no CSV dialect options) — sufficient for "convert rows to readable
// textual content", not a general-purpose CSV library replacement.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      // skip — \n (or end of input) closes the row
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Each data row becomes one readable line: "Column: value, Column: value".
// The header row supplies column names; a short/ragged data row degrades
// to an empty value for the missing column rather than throwing.
export function csvToText(rawText) {
  const rows = parseCsv(rawText).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (rows.length === 0) return "";
  const header = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1);
  return dataRows
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => header.map((h, i) => `${h}: ${(row[i] ?? "").trim()}`).join(", "))
    .join("\n");
}

// Splits a single paragraph longer than chunkSize on whitespace boundaries
// (never mid-word) — used only when one paragraph alone exceeds chunkSize.
function splitLongParagraph(paragraph, chunkSize) {
  const words = paragraph.split(/\s+/).filter(Boolean);
  const pieces = [];
  let buffer = "";
  for (const word of words) {
    if (buffer && buffer.length + 1 + word.length > chunkSize) {
      pieces.push(buffer);
      buffer = word;
    } else {
      buffer = buffer ? `${buffer} ${word}` : word;
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

// Deterministic paragraph-aware chunking with a small overlap between
// consecutive chunks (the tail of chunk N is repeated at the start of
// chunk N+1) so a fact split across a chunk boundary is still retrievable
// from either side. Paragraph boundaries (blank-line-separated) are
// preserved wherever a paragraph fits inside chunkSize on its own; only a
// paragraph that itself exceeds chunkSize is further split, on whitespace.
export function chunkText(text, { chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  function flush() {
    if (current.trim()) chunks.push(current.trim());
  }

  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > chunkSize ? splitLongParagraph(paragraph, chunkSize) : [paragraph];
    for (const piece of pieces) {
      if (!current) {
        current = piece;
        continue;
      }
      if (current.length + 2 + piece.length <= chunkSize) {
        current += `\n\n${piece}`;
        continue;
      }
      // .trim() here matters: a raw character slice can land mid-whitespace
      // (e.g. right after a word's trailing space), and without this the
      // untrimmed leading space would itself get silently stripped by
      // flush()'s own trim() once THIS chunk is later pushed — quietly
      // shortening the actual overlap by exactly that much versus what
      // was intended. Trimming here keeps the overlap's real length
      // predictable and keeps flush()'s trim() a true no-op for it.
      const previousTail = overlap > 0 ? current.slice(-overlap).trim() : "";
      flush();
      current = previousTail ? `${previousTail}\n\n${piece}` : piece;
    }
  }
  flush();

  return chunks;
}

// Extracts plain text from a supported file buffer. Never throws outward
// — every failure path (unsupported type, extraction error, or content
// that extracts to nothing usable — e.g. a scanned/image-only PDF with no
// embedded text layer) returns { ok: false, reason }, which
// ingestDocument below turns into an explicit `failed` status rather than
// ever pretending a document has usable content when it doesn't. No OCR
// in this phase, per explicit instruction.
export async function extractText(buffer, mimeType) {
  try {
    let text = "";

    if (mimeType === "application/pdf") {
      const result = await pdfParse(buffer);
      text = result?.text || "";
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const result = await mammoth.extractRawText({ buffer });
      text = result?.value || "";
    } else if (mimeType === "text/plain") {
      text = buffer.toString("utf-8");
    } else if (mimeType === "text/csv") {
      text = csvToText(buffer.toString("utf-8"));
    } else {
      return { ok: false, reason: "unsupported_type" };
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, reason: "empty_content" };
    }
    return { ok: true, text: trimmed };
  } catch (error) {
    // Safe, non-leaking reason only — the real error is logged by the
    // caller server-side, never stored in status_error verbatim (see
    // ingestDocument).
    return { ok: false, reason: "extraction_failed", debugMessage: error?.message };
  }
}

// The one place chunk replacement happens — used by BOTH finalize_upload
// (new document or replace) and reprocess in api/knowledge-documents.js,
// so they can never diverge in how old chunks are cleared. Scoped by
// BOTH document_id AND client_id on the delete, never document_id alone —
// belt-and-suspenders against ever touching another client's chunks even
// under a hypothetical id collision.
//
// Called ONLY after extraction, chunking, AND embedding have all already
// succeeded (see ingestDocument) — this function itself has no failure-
// recovery logic of its own because by the time it runs, there is
// nothing left that can still fail on the "new content" side; only a
// genuine DB error here still throws outward, exactly like before.
async function replaceChunks(supabase, { clientId, documentId, chunks, embeddings, fileName, category }) {
  const { error: deleteError } = await supabase
    .from("client_knowledge_chunks")
    .delete()
    .eq("client_id", clientId)
    .eq("document_id", documentId);
  if (deleteError) throw deleteError;

  if (chunks.length === 0) return;

  const rows = chunks.map((content, index) => ({
    client_id: clientId,
    document_id: documentId,
    chunk_index: index,
    content,
    embedding: embeddings[index],
    metadata: { file_name: fileName || null, category: category || null },
  }));

  const { error: insertError } = await supabase.from("client_knowledge_chunks").insert(rows);
  if (insertError) throw insertError;
}

// Full pipeline: mark processing -> download (service role) -> extract ->
// chunk -> embed -> replace chunks -> mark ready, or mark failed (or, for
// a reprocess of an already-`ready` document, mark the failure without
// destroying the still-good previous chunks — see markFailed below) at
// any failure point.
//
// ---------------------------------------------------------------------
// Failure semantics — the Phase 4B requirement this function exists to
// satisfy: an embedding (or extraction, or chunking) failure must NEVER
// leave a document with an empty/broken knowledge set if a previous
// successful version existed.
// ---------------------------------------------------------------------
// This is achieved with two things, deliberately kept this simple rather
// than a bigger rewrite:
//
//   1. Ordering. replaceChunks (the ONLY function that ever deletes old
//      chunks) is called strictly AFTER extractText, chunkText, AND
//      embedTexts have ALL already succeeded. If any of those three
//      fails, execution never reaches replaceChunks at all — the
//      previous chunk rows (if any) are simply never touched. No
//      "delete first, then try to fill it back in" step exists anywhere
//      in this pipeline.
//
//   2. Status recovery. The document's status BEFORE this run started is
//      read once, up front (`hadPreviousReadyVersion`). If a failure
//      happens on what was previously a `ready` document (i.e. this is a
//      reprocess/replace of something that already worked, not a brand-
//      new document's first attempt), the failure path leaves status AS
//      `ready` — not `failed` — and records the failure only in
//      status_error (prefixed `reprocess_failed_kept_previous_version:`
//      so it's unambiguous this isn't a normal "ready, no error" state).
//      This is deliberate, not an oversight: match_knowledge_chunks (the
//      retrieval RPC) hard-requires `status = 'ready'` to ever surface a
//      document's chunks — if a failed reprocess flipped status to
//      `failed`, the still-physically-present, still-good previous
//      chunks would become invisible to retrieval even though nothing
//      about their own content changed. Keeping status = `ready` is what
//      makes "the previous chunks are preserved" actually mean something
//      at the retrieval layer, not just at the raw-row level.
//
//      A brand-new document (no previous `ready` version — status was
//      `uploaded` or this is its very first ingestion) has nothing worth
//      preserving, so it gets the straightforward `failed` status with a
//      plain status_error, exactly like Phase 4A's original behavior.
//
// Every path below still ends in `ready` or `failed` — never left stuck
// in `processing` — the try/catch wraps the entire body, and every
// return goes through markFailed() or the success path at the bottom.
// embedFn defaults to the real OpenAI-backed embedTexts — overridable
// only for tests (api/_lib/__tests__/knowledgeIngestion.test.js), so unit
// tests never need a real OPENAI_API_KEY or network access. Production
// call sites (api/knowledge-documents.js) never pass this override.
export async function ingestDocument(supabase, { clientId, documentId, storagePath, mimeType, fileName, category, embedFn = embedTexts }) {
  const { data: beforeRow } = await supabase
    .from("client_knowledge_documents")
    .select("status")
    .eq("id", documentId)
    .eq("client_id", clientId)
    .maybeSingle();
  const hadPreviousReadyVersion = beforeRow?.status === "ready";

  await supabase
    .from("client_knowledge_documents")
    .update({ status: "processing", status_error: null, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("client_id", clientId);

  async function markFailed(reason) {
    const status = hadPreviousReadyVersion ? "ready" : "failed";
    const statusError = hadPreviousReadyVersion ? `reprocess_failed_kept_previous_version:${reason}` : reason;
    await supabase
      .from("client_knowledge_documents")
      .update({ status, status_error: statusError, updated_at: new Date().toISOString() })
      .eq("id", documentId)
      .eq("client_id", clientId);
    return { ok: false, reason, kept_previous_version: hadPreviousReadyVersion };
  }

  try {
    const { data: fileBlob, error: downloadError } = await supabase.storage.from(KNOWLEDGE_BUCKET).download(storagePath);
    if (downloadError || !fileBlob) {
      return await markFailed("download_failed");
    }

    const arrayBuffer = await fileBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const extraction = await extractText(buffer, mimeType);
    if (!extraction.ok) {
      return await markFailed(extraction.reason);
    }

    const chunks = chunkText(extraction.text);
    if (chunks.length === 0) {
      return await markFailed("empty_content");
    }

    const embeddingResult = await embedFn(chunks);
    if (!embeddingResult.ok) {
      // Chunks were computed but never persisted, and replaceChunks was
      // never called — the previous chunk set (if any) is completely
      // untouched at this point.
      return await markFailed(`embedding_${embeddingResult.reason}`);
    }

    await replaceChunks(supabase, { clientId, documentId, chunks, embeddings: embeddingResult.embeddings, fileName, category });

    await supabase
      .from("client_knowledge_documents")
      .update({ status: "ready", status_error: null, updated_at: new Date().toISOString() })
      .eq("id", documentId)
      .eq("client_id", clientId);

    return { ok: true, chunkCount: chunks.length };
  } catch (error) {
    console.error("knowledgeIngestion: ingestion failed:", { documentId, clientId, message: error?.message });
    return await markFailed("processing_failed");
  }
}
