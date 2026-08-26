import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, csvToText, extractText, ingestDocument } from "../knowledgeIngestion.js";
import { createMockSupabase } from "./mockSupabase.js";

// --- chunkText -------------------------------------------------------

test("chunking: deterministic — same input always produces the same chunks", () => {
  const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
  const a = chunkText(text, { chunkSize: 40, overlap: 5 });
  const b = chunkText(text, { chunkSize: 40, overlap: 5 });
  assert.deepEqual(a, b);
});

test("chunking: short text stays as a single chunk", () => {
  const chunks = chunkText("A short menu description.", { chunkSize: 800, overlap: 100 });
  assert.deepEqual(chunks, ["A short menu description."]);
});

test("chunking: empty/whitespace-only text produces zero chunks", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n  "), []);
  assert.deepEqual(chunkText(null), []);
});

test("chunking: splits into multiple bounded chunks and preserves paragraph order", () => {
  const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i} with some extra padding text to take up space.`);
  const text = paragraphs.join("\n\n");
  const chunks = chunkText(text, { chunkSize: 150, overlap: 20 });
  assert.ok(chunks.length > 1, "expected more than one chunk");
  // Every paragraph's identifying number must still appear somewhere,
  // in original order, across the chunk sequence.
  const joined = chunks.join(" ||| ");
  const positions = paragraphs.map((_, i) => joined.indexOf(`Paragraph number ${i} `));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `paragraph ${i} out of order`);
  }
});

test("chunking: consecutive chunks overlap by the requested tail", () => {
  const text = Array.from({ length: 6 }, (_, i) => `Section ${i}: ${"word ".repeat(20)}`).join("\n\n");
  const chunks = chunkText(text, { chunkSize: 120, overlap: 30 });
  assert.ok(chunks.length > 1);
  for (let i = 1; i < chunks.length; i++) {
    // .trim() mirrors chunkText's own documented behavior: the overlap
    // tail is trimmed before being prepended, so a raw untrimmed slice
    // (which can land mid-whitespace) is not the right comparison — see
    // the "previousTail" comment in knowledgeIngestion.js.
    const previousTail = chunks[i - 1].slice(-30).trim();
    assert.ok(chunks[i].startsWith(previousTail), `chunk ${i} does not start with the previous chunk's tail`);
    assert.ok(previousTail.length > 20, "overlap should still be close to the requested size, not trimmed down to nothing");
  }
});

test("chunking: a single paragraph longer than chunkSize is split on whitespace, never mid-word", () => {
  const longWord = "word ".repeat(100).trim();
  const chunks = chunkText(longWord, { chunkSize: 50, overlap: 0 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.doesNotMatch(chunk, /wo$|wor$/); // never truncated mid-"word"
  }
});

// --- csvToText ---------------------------------------------------------

test("csv: converts rows into readable 'Column: value' text", () => {
  const csv = "Name,Price\nBurger,25\nFries,10";
  const text = csvToText(csv);
  assert.equal(text, "Name: Burger, Price: 25\nName: Fries, Price: 10");
});

test("csv: handles quoted fields containing commas", () => {
  const csv = 'Name,Description\n"Family Meal","Burger, fries, and a drink"';
  const text = csvToText(csv);
  assert.equal(text, "Name: Family Meal, Description: Burger, fries, and a drink");
});

test("csv: header-only input produces empty text", () => {
  assert.equal(csvToText("Name,Price"), "");
  assert.equal(csvToText(""), "");
});

// --- extractText: PDF fixture -------------------------------------------
//
// Builds a minimal, syntactically valid single-page PDF with a real text
// layer entirely in-memory (no network, no fixture file) — offsets are
// computed from the actual assembled string lengths rather than
// hand-counted, so the fixture stays correct if the content ever changes.
// This exercises the real unpdf (pdf.js) parser end-to-end, network-free.
function buildMinimalPdf(text) {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const contentStream = `BT /F1 24 Tf 20 100 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 144] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += xref;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

// --- extractText ---------------------------------------------------------

test("extractText: PDF text layer is extracted via unpdf", async () => {
  const pdfBuffer = buildMinimalPdf("Hello, World!");
  const result = await extractText(pdfBuffer, "application/pdf");
  assert.equal(result.ok, true);
  assert.match(result.text, /Hello, World!/);
});

test("extractText: corrupt/invalid PDF bytes are rejected as extraction_failed, never faked", async () => {
  const result = await extractText(Buffer.from("this is not a real pdf file"), "application/pdf");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "extraction_failed");
});

test("extractText: plain text is decoded directly", async () => {
  const result = await extractText(Buffer.from("Hello, this is our menu.", "utf-8"), "text/plain");
  assert.equal(result.ok, true);
  assert.equal(result.text, "Hello, this is our menu.");
});

test("extractText: csv is converted through csvToText", async () => {
  const result = await extractText(Buffer.from("Item,Price\nTea,5", "utf-8"), "text/csv");
  assert.equal(result.ok, true);
  assert.equal(result.text, "Item: Tea, Price: 5");
});

test("extractText: empty content (e.g. a blank file, or a scanned PDF with no text layer) is rejected, never faked", async () => {
  const result = await extractText(Buffer.from("   \n  ", "utf-8"), "text/plain");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty_content");
});

test("extractText: unsupported mime type is rejected clearly", async () => {
  const result = await extractText(Buffer.from("data"), "application/zip");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_type");
});

// --- ingestDocument (mocked Supabase DB + Storage) ------------------------

function createMockStorage(files) {
  return {
    from() {
      return {
        async download(path) {
          const content = files[path];
          if (content === undefined) return { data: null, error: { message: "not found" } };
          const buf = Buffer.from(content, "utf-8");
          return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null };
        },
      };
    },
  };
}

function supabaseWithStorage(tables, files) {
  const supabase = createMockSupabase(tables);
  supabase.storage = createMockStorage(files);
  return supabase;
}

// Deterministic fake embedder — every ingestDocument test below injects
// this instead of the real (network-calling, OPENAI_API_KEY-requiring)
// embedTexts, so these tests run with no live OpenAI access at all. A
// 1536-length array of zeros satisfies "every embedding has the right
// dimension" without needing real embedding values for any of these
// structural assertions.
async function fakeEmbedOk(texts) {
  return { ok: true, embeddings: texts.map(() => new Array(1536).fill(0)) };
}
async function fakeEmbedFail(reason = "api_error") {
  return { ok: false, reason };
}

test("ingestDocument: happy path marks the document ready and writes chunks + embeddings scoped to client+document", async () => {
  const tables = {
    client_knowledge_documents: [{ id: "doc-1", client_id: "client-1", status: "uploaded" }],
    client_knowledge_chunks: [],
  };
  const supabase = supabaseWithStorage(tables, { "client-1/doc-1/file.txt": "This is the full menu text for the restaurant." });

  const result = await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-1", storagePath: "client-1/doc-1/file.txt", mimeType: "text/plain", fileName: "file.txt", category: "menu", embedFn: fakeEmbedOk });

  assert.equal(result.ok, true);
  assert.equal(tables.client_knowledge_documents[0].status, "ready");
  assert.equal(tables.client_knowledge_documents[0].status_error, null);
  assert.ok(tables.client_knowledge_chunks.length > 0);
  for (const chunk of tables.client_knowledge_chunks) {
    assert.equal(chunk.client_id, "client-1");
    assert.equal(chunk.document_id, "doc-1");
    assert.ok(Array.isArray(chunk.embedding), "chunk row must carry a persisted embedding");
    assert.equal(chunk.embedding.length, 1536);
  }
});

test("ingestDocument: extraction failure marks the document failed with a status_error, never left stuck in processing", async () => {
  const tables = {
    client_knowledge_documents: [{ id: "doc-2", client_id: "client-1", status: "uploaded" }],
    client_knowledge_chunks: [],
  };
  const supabase = supabaseWithStorage(tables, { "client-1/doc-2/blank.txt": "   " });

  const result = await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-2", storagePath: "client-1/doc-2/blank.txt", mimeType: "text/plain", fileName: "blank.txt", category: null, embedFn: fakeEmbedOk });

  assert.equal(result.ok, false);
  assert.equal(tables.client_knowledge_documents[0].status, "failed");
  assert.equal(tables.client_knowledge_documents[0].status_error, "empty_content");
  assert.equal(tables.client_knowledge_chunks.length, 0);
});

test("ingestDocument: a missing storage object also resolves to failed, not stuck processing", async () => {
  const tables = { client_knowledge_documents: [{ id: "doc-3", client_id: "client-1", status: "uploaded" }], client_knowledge_chunks: [] };
  const supabase = supabaseWithStorage(tables, {}); // no file at all

  const result = await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-3", storagePath: "client-1/doc-3/missing.txt", mimeType: "text/plain", fileName: "missing.txt", category: null, embedFn: fakeEmbedOk });

  assert.equal(result.ok, false);
  assert.equal(tables.client_knowledge_documents[0].status, "failed");
});

test("ingestDocument: a brand-new document whose embedding fails is marked failed (no previous version to preserve)", async () => {
  const tables = { client_knowledge_documents: [{ id: "doc-new", client_id: "client-1", status: "uploaded" }], client_knowledge_chunks: [] };
  const supabase = supabaseWithStorage(tables, { "client-1/doc-new/file.txt": "Some perfectly good extractable text." });

  const result = await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-new", storagePath: "client-1/doc-new/file.txt", mimeType: "text/plain", fileName: "file.txt", category: null, embedFn: () => fakeEmbedFail("api_error") });

  assert.equal(result.ok, false);
  assert.equal(result.kept_previous_version, false);
  assert.equal(tables.client_knowledge_documents[0].status, "failed");
  assert.match(tables.client_knowledge_documents[0].status_error, /embedding_api_error/);
  assert.equal(tables.client_knowledge_chunks.length, 0);
});

test("ingestDocument: reprocess REPLACES old chunks rather than duplicating them", async () => {
  const tables = {
    client_knowledge_documents: [{ id: "doc-4", client_id: "client-1", status: "ready" }],
    client_knowledge_chunks: [
      { client_id: "client-1", document_id: "doc-4", chunk_index: 0, content: "stale chunk from a previous version" },
    ],
  };
  const supabase = supabaseWithStorage(tables, { "client-1/doc-4/file.txt": "Brand new content after reprocessing." });

  await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-4", storagePath: "client-1/doc-4/file.txt", mimeType: "text/plain", fileName: "file.txt", category: "menu", embedFn: fakeEmbedOk });

  const remaining = tables.client_knowledge_chunks.filter((c) => c.document_id === "doc-4");
  assert.equal(remaining.length, 1);
  assert.match(remaining[0].content, /Brand new content/);
  assert.doesNotMatch(remaining[0].content, /stale chunk/);
});

test("ingestDocument: reprocessing one document never touches another document's or another client's chunks", async () => {
  const tables = {
    client_knowledge_documents: [
      { id: "doc-5", client_id: "client-1", status: "ready" },
      { id: "doc-6", client_id: "client-2", status: "ready" },
    ],
    client_knowledge_chunks: [
      { client_id: "client-1", document_id: "doc-5", chunk_index: 0, content: "client-1's own chunk" },
      { client_id: "client-2", document_id: "doc-6", chunk_index: 0, content: "client-2's own chunk — must survive untouched" },
    ],
  };
  const supabase = supabaseWithStorage(tables, { "client-1/doc-5/file.txt": "Client one's reprocessed content." });

  await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-5", storagePath: "client-1/doc-5/file.txt", mimeType: "text/plain", fileName: "file.txt", category: null, embedFn: fakeEmbedOk });

  const client2Chunks = tables.client_knowledge_chunks.filter((c) => c.client_id === "client-2");
  assert.equal(client2Chunks.length, 1);
  assert.equal(client2Chunks[0].content, "client-2's own chunk — must survive untouched");
});

// --- Phase 4B failure-semantics: preserving a previously-good version ---

test("ingestDocument: a reprocess embedding failure on an already-ready document PRESERVES the previous chunks and keeps status ready", async () => {
  const tables = {
    client_knowledge_documents: [{ id: "doc-7", client_id: "client-1", status: "ready" }],
    client_knowledge_chunks: [
      { client_id: "client-1", document_id: "doc-7", chunk_index: 0, content: "the last known-good menu content" },
    ],
  };
  const supabase = supabaseWithStorage(tables, { "client-1/doc-7/file.txt": "A new version of the menu that never finishes embedding." });

  const result = await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-7", storagePath: "client-1/doc-7/file.txt", mimeType: "text/plain", fileName: "file.txt", category: "menu", embedFn: () => fakeEmbedFail("api_error") });

  assert.equal(result.ok, false);
  assert.equal(result.kept_previous_version, true);
  // Status must still be `ready` — a `failed` document is invisible to
  // match_knowledge_chunks (status = 'ready' is a hard filter there), so
  // flipping to `failed` here would make "preserved" chunks unretrievable
  // even though the rows themselves still exist.
  assert.equal(tables.client_knowledge_documents[0].status, "ready");
  assert.match(tables.client_knowledge_documents[0].status_error, /^reprocess_failed_kept_previous_version:/);

  const remaining = tables.client_knowledge_chunks.filter((c) => c.document_id === "doc-7");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].content, "the last known-good menu content");
});

test("ingestDocument: a reprocess extraction failure on an already-ready document also preserves the previous chunks", async () => {
  const tables = {
    client_knowledge_documents: [{ id: "doc-8", client_id: "client-1", status: "ready" }],
    client_knowledge_chunks: [{ client_id: "client-1", document_id: "doc-8", chunk_index: 0, content: "previous good content" }],
  };
  const supabase = supabaseWithStorage(tables, { "client-1/doc-8/blank.txt": "   " }); // replaced with an unusable file

  const result = await ingestDocument(supabase, { clientId: "client-1", documentId: "doc-8", storagePath: "client-1/doc-8/blank.txt", mimeType: "text/plain", fileName: "blank.txt", category: null, embedFn: fakeEmbedOk });

  assert.equal(result.kept_previous_version, true);
  assert.equal(tables.client_knowledge_documents[0].status, "ready");
  assert.equal(tables.client_knowledge_chunks.filter((c) => c.document_id === "doc-8").length, 1);
});
