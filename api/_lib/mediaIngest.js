import {
  MEDIA_LIMITS,
  MEDIA_MESSAGE_TYPES,
  MEDIA_BUCKET,
  SIGNED_UPLOAD_URL_TTL_SECONDS,
  sanitizeFileName,
  buildMediaObjectPath,
} from "../../src/lib/mediaMessages.js";

// Customer -> Inbox INBOUND media ingestion helper.
//
// Trust model: identical to api/ai-tools.js and api/smart-assign-conversation.js
// -- the caller is the n8n "Inbound-Media-Core" sub-workflow (server-to-server),
// never a browser. A shared secret gates api/media.js; once past it the ONLY
// identity the body carries is conversation_id, and client_id is derived from
// that conversation's own row here -- never trusted from the request. This
// mirrors api/_lib/aiTools.js resolveConversationScope exactly.
//
// This module only prepares a place in Storage for inbound bytes to land (a
// signed upload URL scoped to {client_id}/{conversation_id}/...). It never
// receives or proxies the file bytes themselves -- n8n uploads directly to
// Supabase Storage with the returned signed URL, exactly like the employee
// outbound path (api/media.js action "sign_upload"). SUPABASE_SERVICE_ROLE_KEY
// therefore stays server-side and is never handed to n8n.

// Absolute ceiling regardless of type -- a safety net for Storage, separate
// from the per-type UX limits in MEDIA_LIMITS.
export const INBOUND_HARD_MAX_BYTES = 25 * 1024 * 1024;

// Inbound media validation is deliberately MORE LENIENT on MIME than the
// outbound employee path (validateMediaMeta in src/lib/mediaMessages.js).
// Outbound files are chosen by an employee from a known device; inbound files
// come from arbitrary consumer apps and legitimately arrive as image/heic,
// audio/ogg;codecs=opus, application/octet-stream, etc. Rejecting a customer's
// real photo/voice note on a strict allow-list would be worse than storing it.
// Size is still enforced (per-type + a hard cap); MIME is a family check only.
export function validateInboundMedia(messageType, { mimeType, sizeBytes } = {}) {
  if (!MEDIA_MESSAGE_TYPES.includes(messageType)) {
    return { valid: false, reason: "unsupported_type" };
  }

  const size = Number(sizeBytes);
  const sizeKnown = Number.isFinite(size) && size > 0;

  if (sizeKnown && size > INBOUND_HARD_MAX_BYTES) {
    return { valid: false, reason: "too_large", maxBytes: INBOUND_HARD_MAX_BYTES };
  }
  const perTypeMax = MEDIA_LIMITS[messageType]?.maxBytes;
  if (sizeKnown && perTypeMax && size > perTypeMax) {
    return { valid: false, reason: "too_large", maxBytes: perTypeMax };
  }

  if (mimeType) {
    const family = String(mimeType).split("/")[0].toLowerCase().trim();
    if (messageType === "image" && family !== "image") {
      return { valid: false, reason: "mime_mismatch" };
    }
    if (messageType === "audio" && family !== "audio") {
      return { valid: false, reason: "mime_mismatch" };
    }
    // "document" accepts any other family (application/*, text/*, ...).
  }

  return { valid: true };
}

// Resolves the tenant-scoped Storage object path + a signed upload URL for one
// inbound media file. `supabase` must be a service-role client (Storage signing
// requires it -- this app has no Supabase Auth, so a private bucket's
// default-deny RLS can only be satisfied by the service role).
//
// Returns { ok, status, ... }. On ok: { bucket, path, token, signed_url,
// expires_in }. On failure: { ok:false, status, code, message }.
export async function signInboundUpload(supabase, {
  conversationId,
  messageType,
  fileName,
  mimeType,
  sizeBytes,
} = {}) {
  if (!conversationId || typeof conversationId !== "string") {
    return { ok: false, status: 400, code: "MISSING_CONVERSATION_ID", message: "conversation_id is required" };
  }
  if (!MEDIA_MESSAGE_TYPES.includes(messageType)) {
    return { ok: false, status: 400, code: "UNKNOWN_MESSAGE_TYPE", message: "Unknown message_type" };
  }
  if (!fileName || typeof fileName !== "string") {
    return { ok: false, status: 400, code: "MISSING_FILE_NAME", message: "file_name is required" };
  }

  const validation = validateInboundMedia(messageType, { mimeType, sizeBytes });
  if (!validation.valid) {
    const code =
      validation.reason === "too_large"
        ? "FILE_TOO_LARGE"
        : validation.reason === "mime_mismatch"
          ? "MIME_MISMATCH"
          : "UNSUPPORTED_FILE_TYPE";
    return {
      ok: false,
      status: 400,
      code,
      message: validation.reason === "too_large" ? "File is too large" : "Unsupported file type",
    };
  }

  // conversation_id is the ONLY identity anchor. client_id (tenant) is read
  // back from the conversation row, never taken from the caller -- same rule
  // as api/_lib/aiTools.js and api/_lib/humanReply.js.
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select("id, client_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 500, code: "LOOKUP_FAILED", message: "Could not resolve the conversation" };
  }
  if (!conversation || !conversation.client_id) {
    return { ok: false, status: 404, code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" };
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 503, code: "STORAGE_NOT_CONFIGURED", message: "Storage is not configured yet" };
  }

  // Object path is built here from the server-derived client_id + the
  // validated conversation id -- exactly the {client_id}/{conversation_id}/...
  // convention buildMediaObjectPath owns, shared with the outbound path.
  const objectPath = buildMediaObjectPath({
    clientId: conversation.client_id,
    conversationId: conversation.id,
    fileName: sanitizeFileName(fileName),
  });

  try {
    const { data, error: signError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUploadUrl(objectPath);

    if (signError || !data) {
      return { ok: false, status: 503, code: "STORAGE_UNAVAILABLE", message: "Storage is not available yet" };
    }

    return {
      ok: true,
      status: 200,
      bucket: MEDIA_BUCKET,
      path: data.path || objectPath,
      token: data.token || null,
      signed_url: data.signedUrl || null,
      expires_in: SIGNED_UPLOAD_URL_TTL_SECONDS,
    };
  } catch (e) {
    return { ok: false, status: 503, code: "STORAGE_UNAVAILABLE", message: "Storage is not available yet" };
  }
}
