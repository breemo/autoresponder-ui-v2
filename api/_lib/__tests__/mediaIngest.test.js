import test from "node:test";
import assert from "node:assert/strict";

import {
  validateInboundMedia,
  signInboundUpload,
  INBOUND_HARD_MAX_BYTES,
} from "../mediaIngest.js";
import { MEDIA_LIMITS } from "../../../src/lib/mediaMessages.js";

// --- tiny mock: only what signInboundUpload touches -------------------------
function makeSupabase({ conversation = { id: "conv-1", client_id: "client-1" }, signResult } = {}) {
  const calls = { select: null, signedPath: null };
  return {
    calls,
    from(table) {
      assert.equal(table, "conversations");
      return {
        select(cols) {
          calls.select = cols;
          return this;
        },
        eq(col, val) {
          calls.eqCol = col;
          calls.eqVal = val;
          return this;
        },
        async maybeSingle() {
          return { data: conversation, error: null };
        },
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "chat-media");
        return {
          async createSignedUploadUrl(path) {
            calls.signedPath = path;
            if (signResult) return signResult;
            return {
              data: { path, token: "tok-123", signedUrl: "https://x.supabase.co/storage/v1/object/upload/sign/chat-media/" + path + "?token=tok-123" },
              error: null,
            };
          },
        };
      },
    },
  };
}

const withServiceRole = (fn) => async (t) => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  try {
    await fn(t);
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
};

// --- validateInboundMedia --------------------------------------------------

test("validateInboundMedia: accepts a normal customer photo", () => {
  assert.deepEqual(validateInboundMedia("image", { mimeType: "image/jpeg", sizeBytes: 500_000 }), { valid: true });
});

test("validateInboundMedia: accepts lenient/unusual mimes (heic image, opus voice)", () => {
  assert.deepEqual(validateInboundMedia("image", { mimeType: "image/heic", sizeBytes: 1000 }), { valid: true });
  assert.deepEqual(validateInboundMedia("audio", { mimeType: "audio/ogg; codecs=opus", sizeBytes: 1000 }), { valid: true });
});

test("validateInboundMedia: document accepts octet-stream / unknown application types", () => {
  assert.deepEqual(validateInboundMedia("document", { mimeType: "application/octet-stream", sizeBytes: 1000 }), { valid: true });
  assert.deepEqual(validateInboundMedia("document", { mimeType: "", sizeBytes: 1000 }), { valid: true });
});

test("validateInboundMedia: rejects an unknown message_type", () => {
  assert.equal(validateInboundMedia("video", { mimeType: "video/mp4", sizeBytes: 1 }).valid, false);
});

test("validateInboundMedia: rejects a clear family mismatch", () => {
  assert.equal(validateInboundMedia("image", { mimeType: "application/pdf", sizeBytes: 1 }).reason, "mime_mismatch");
  assert.equal(validateInboundMedia("audio", { mimeType: "image/png", sizeBytes: 1 }).reason, "mime_mismatch");
});

test("validateInboundMedia: enforces the per-type size cap", () => {
  const over = MEDIA_LIMITS.image.maxBytes + 1;
  assert.deepEqual(validateInboundMedia("image", { mimeType: "image/png", sizeBytes: over }), {
    valid: false,
    reason: "too_large",
    maxBytes: MEDIA_LIMITS.image.maxBytes,
  });
});

test("validateInboundMedia: enforces the absolute hard cap for documents", () => {
  const r = validateInboundMedia("document", { mimeType: "application/pdf", sizeBytes: INBOUND_HARD_MAX_BYTES + 1 });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "too_large");
});

test("validateInboundMedia: unknown size passes (post-download check is authoritative)", () => {
  assert.deepEqual(validateInboundMedia("audio", { mimeType: "audio/ogg", sizeBytes: 0 }), { valid: true });
  assert.deepEqual(validateInboundMedia("audio", { mimeType: "audio/ogg" }), { valid: true });
});

// --- signInboundUpload ---------------------------------------------------

test("signInboundUpload: requires conversation_id", async () => {
  const r = await signInboundUpload(makeSupabase(), { messageType: "image", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "MISSING_CONVERSATION_ID");
});

test("signInboundUpload: rejects unknown message_type", async () => {
  const r = await signInboundUpload(makeSupabase(), { conversationId: "conv-1", messageType: "sticker", fileName: "a", mimeType: "image/webp", sizeBytes: 10 });
  assert.equal(r.code, "UNKNOWN_MESSAGE_TYPE");
});

test("signInboundUpload: rejects oversize before touching Storage", async () => {
  const sb = makeSupabase();
  const r = await signInboundUpload(sb, {
    conversationId: "conv-1",
    messageType: "image",
    fileName: "big.png",
    mimeType: "image/png",
    sizeBytes: INBOUND_HARD_MAX_BYTES + 1,
  });
  assert.equal(r.code, "FILE_TOO_LARGE");
  assert.equal(sb.calls.signedPath, null);
});

test("signInboundUpload: 404 when the conversation does not exist", withServiceRole(async () => {
  const sb = makeSupabase({ conversation: null });
  const r = await signInboundUpload(sb, { conversationId: "nope", messageType: "image", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 });
  assert.equal(r.status, 404);
  assert.equal(r.code, "CONVERSATION_NOT_FOUND");
}));

test("signInboundUpload: 503 when service role / Storage is not configured", async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await signInboundUpload(makeSupabase(), { conversationId: "conv-1", messageType: "image", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 });
    assert.equal(r.status, 503);
    assert.equal(r.code, "STORAGE_NOT_CONFIGURED");
  } finally {
    if (prev !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test("signInboundUpload: happy path returns a tenant-scoped signed upload URL", withServiceRole(async () => {
  const sb = makeSupabase();
  const r = await signInboundUpload(sb, {
    conversationId: "conv-1",
    messageType: "document",
    fileName: "../../etc/pass wd!.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.bucket, "chat-media");
  // path is derived from the server-side client_id + conversation id, and the
  // filename is sanitised (no traversal, no spaces/!).
  assert.match(r.path, /^client-1\/conv-1\/.+-pass_wd_\.pdf$/);
  assert.equal(sb.calls.eqVal, "conv-1");
  assert.ok(r.signed_url.includes("/chat-media/client-1/conv-1/"));
  assert.equal(r.token, "tok-123");
}));

test("signInboundUpload: 503 when Storage signing itself fails", withServiceRole(async () => {
  const sb = makeSupabase({ signResult: { data: null, error: { message: "bucket missing" } } });
  const r = await signInboundUpload(sb, { conversationId: "conv-1", messageType: "image", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 });
  assert.equal(r.status, 503);
  assert.equal(r.code, "STORAGE_UNAVAILABLE");
}));

test("signInboundUpload: an unusual inbound mime (heic) still signs", withServiceRole(async () => {
  const r = await signInboundUpload(makeSupabase(), {
    conversationId: "conv-1",
    messageType: "image",
    fileName: "IMG_0001.HEIC",
    mimeType: "image/heic",
    sizeBytes: 900_000,
  });
  assert.equal(r.ok, true);
}));
