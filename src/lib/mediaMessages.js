// Centralized constants/helpers for WhatsApp Media & Attachment Support v1
// — CODE FOUNDATION ONLY. Storage and the n8n Evolution media-delivery
// workflow do not exist yet (see api/human-reply.js, which rejects any
// non-text message_type until that exists). This module only prepares the
// client-side composer/renderer/validation surface so that work can be
// wired up later without another redesign. Single source of truth reused
// by ClientMessages.jsx and api/human-reply.js — do not duplicate these
// rules elsewhere.

export const MESSAGE_TYPES = {
  TEXT: "text",
  IMAGE: "image",
  AUDIO: "audio",
  DOCUMENT: "document",
};

// Every message_type other than plain text — matches the messages table's
// message_type CHECK constraint (see
// supabase/migrations/20260818_messages_media_columns.sql) minus 'text'.
export const MEDIA_MESSAGE_TYPES = [MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.AUDIO, MESSAGE_TYPES.DOCUMENT];

export function isMediaMessageType(messageType) {
  return MEDIA_MESSAGE_TYPES.includes(messageType);
}

// Conservative UI-level limits only — NOT verified against WhatsApp
// Evolution API's actual limits (not accessible from this repository).
// Centralized here specifically so there is exactly one place to adjust
// once the real Evolution integration is built and its true limits are
// confirmed. Do not treat these as authoritative platform limits.
export const MEDIA_LIMITS = {
  [MESSAGE_TYPES.IMAGE]: {
    maxBytes: 5 * 1024 * 1024, // 5 MB
    mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  [MESSAGE_TYPES.AUDIO]: {
    maxBytes: 10 * 1024 * 1024, // 10 MB
    mimeTypes: ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/aac", "audio/x-m4a"],
  },
  [MESSAGE_TYPES.DOCUMENT]: {
    maxBytes: 20 * 1024 * 1024, // 20 MB
    mimeTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain",
      "text/csv",
      "application/zip",
    ],
  },
};

// Comma-separated `accept` attribute value for a media type's file input.
export function getAcceptAttribute(messageType) {
  return (MEDIA_LIMITS[messageType]?.mimeTypes || []).join(",");
}

// Human-readable file size, e.g. "1.4 MB". No i18n — digits/units read the
// same in both supported languages, matching how file sizes are already
// shown unlocalized elsewhere in this app (e.g. channel/webhook values).
export function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

// Validates plain media metadata (mime type + byte size) against the
// centralized limits for a given message type. This is the server-safe
// form — api/media-upload-url.js only ever receives JSON fields, never a
// browser File object, so it calls this directly. validateMediaFile below
// is a thin wrapper over this so both call sites share exactly one rule
// set. Returns { valid: true } or
// { valid: false, reason: "unsupported_type" | "too_large", maxBytes? }.
// Never a security boundary by itself on the client; the server
// (api/media-upload-url.js) re-runs this exact check before ever minting a
// signed upload URL, the same "client-side checks are UX, not enforcement"
// principle already applied to permission gating elsewhere in this app.
export function validateMediaMeta(messageType, { mimeType, sizeBytes } = {}) {
  const limits = MEDIA_LIMITS[messageType];
  if (!limits) return { valid: false, reason: "unsupported_type" };
  if (limits.mimeTypes.length && !limits.mimeTypes.includes(mimeType)) {
    return { valid: false, reason: "unsupported_type" };
  }
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return { valid: false, reason: "unsupported_type" };
  if (size > limits.maxBytes) {
    return { valid: false, reason: "too_large", maxBytes: limits.maxBytes };
  }
  return { valid: true };
}

// Validates a browser File against the centralized limits for a given
// media message type. UI-only — never a security boundary by itself; see
// validateMediaMeta above for the shared rule set and the server-side note.
export function validateMediaFile(messageType, file) {
  if (!file) return { valid: false, reason: "unsupported_type" };
  return validateMediaMeta(messageType, { mimeType: file.type, sizeBytes: file.size });
}

// ---------------------------------------------------------------------------
// Supported media channels
// ---------------------------------------------------------------------------
//
// Media UI availability, per channel/platform value on a
// messages/conversation_state row. WhatsApp Evolution is the only channel
// with a runtime-verified, end-to-end n8n Human Reply MEDIA DRAFT delivery
// (text/image/audio/document). Facebook and Telegram are enabled here so
// their own media delivery can be built and runtime-tested against that
// same n8n workflow — enabling the control is NOT a claim that
// Facebook/Telegram media delivery already works; see the Human Reply
// MEDIA DRAFT workflow status before assuming otherwise.
//
// This is a UI-availability gate only. api/human-reply.js's media
// authorization/validation never branches on channel — it already applies
// uniformly to any conversation regardless of platform — so extending this
// array needs no server-side change.
//
// BUSINESS DECISION carried over from the original WhatsApp-only gate
// (confirmed by product, not independently re-derived from data):
// WhatsApp Evolution is, for the current version of Auto Responder, the
// ONLY supported WhatsApp implementation. The distinct "WhatsApp Cloud
// API" feature (features.slug = "whatsapp", see AdminClientSettings.jsx's
// FEATURE_META: title "WhatsApp Cloud API") exists in the admin/plan
// catalog but is not yet a live, connectable client integration — so the
// channel/platform literal "whatsapp" that appears on a real
// messages/conversation_state row is, today, unambiguously an Evolution
// conversation. This is a product-scope assumption, not a schema-level
// guarantee: if WhatsApp Cloud API is ever actually connected as a client
// integration, "whatsapp" must be replaced with an explicit
// integration-identity check (a channel_key/feature_id-type column
// propagated onto messages/conversation_state — see the Phase A/B
// architecture verification reports for exactly what that would require)
// before both could safely coexist. Do not add "whatsapp" back to a
// broad/substring match if that day comes — it must go back to an exact,
// disambiguated value.
// "instagram" is enabled here so the three media controls (image /
// document / audio) become available on an Instagram conversation for
// end-to-end testing. As with facebook/telegram, enabling a control is
// NOT a claim that delivery already works for every type — the Human
// Reply Instagram builder currently forms text/image via the Instagram
// Graph attachment API and forms experimental audio (type:"audio") and
// document (type:"file") requests purely to capture Meta's real API
// response. No per-type hiding until those live tests are in.
export const SUPPORTED_MEDIA_CHANNEL_VALUES = ["whatsapp", "facebook", "telegram", "instagram"];

export function isSupportedMediaChannel(channel) {
  const key = String(channel || "").trim().toLowerCase();
  if (!key) return false;
  return SUPPORTED_MEDIA_CHANNEL_VALUES.includes(key);
}

// Single gate the composer checks before enabling any media control. Kept
// separate from isSupportedMediaChannel so a future per-plan/feature check
// (e.g. does this client's plan even include media) can be added here
// later without touching call sites.
export function canSendMediaOnChannel(channel) {
  return isSupportedMediaChannel(channel);
}

// ---------------------------------------------------------------------------
// WhatsApp Media & Attachment Support v1 — Phase B: Storage foundation
// ---------------------------------------------------------------------------
//
// Private bucket only. NOT created by this phase — see
// api/media-upload-url.js / api/media-read-url.js (the only two places that
// ever mint a URL against it) and the phase report for the manual Storage
// setup this still requires. Centralized here so every reference to the
// bucket name/lifetimes comes from exactly one place.
export const MEDIA_BUCKET = "chat-media";

// Fixed 2-hour validity — Supabase Storage's createSignedUploadUrl() does
// not accept a custom expiry, so this documents the platform's own fixed
// value rather than configuring anything. Source: node_modules/@supabase/
// storage-js StorageFileApi.d.ts ("They are valid for 2 hours.").
export const SIGNED_UPLOAD_URL_TTL_SECONDS = 7200;

// createSignedUrl() DOES accept a custom expiresIn — this value is passed
// directly as that argument by api/media-read-url.js, so it's genuinely
// enforced (not just documentation).
export const SIGNED_READ_URL_TTL_SECONDS = 300;

// Strips any directory component and any character outside a conservative
// safe set, collapses repeated underscores, and caps length. The object
// path already isolates tenants/conversations (see buildMediaObjectPath
// below), so this only guards against a hostile/garbled filename breaking
// the resulting Storage path or a later download prompt — never a security
// boundary by itself.
export function sanitizeFileName(fileName) {
  const base = String(fileName || "").split(/[/\\]/).pop() || "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_{2,}/g, "_").slice(0, 120);
  return cleaned || "file";
}

// Object path convention: {client_id}/{conversation_id}/{unique-id}-{sanitized-file-name}
// clientId and conversationId must always be server-derived values (see
// api/media-upload-url.js: actor.membership.client_id from
// resolveActingMembership(), and a conversation_id already verified against
// a real conversation_state row owned by that client) — never raw request
// input. This namespaces every object per tenant/conversation even though
// the bucket itself has no RLS policies yet (Task 1 — not created in this
// phase).
export function buildMediaObjectPath({ clientId, conversationId, fileName }) {
  const uniqueId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${clientId}/${conversationId}/${uniqueId}-${sanitizeFileName(fileName)}`;
}

// Verifies a media_path sits inside the {clientId}/{conversationId}/ Storage
// namespace buildMediaObjectPath above always mints into. Used by
// api/human-reply.js to authorize a media send: unlike api/media-read-url.js
// (which checks an already-existing `messages` row), no messages row exists
// yet at send time — n8n creates it — so the object path's own namespace
// prefix is the only ownership signal available. clientId must always be
// actor.membership.client_id (server-derived, never the request body) and
// conversationId the value already checked against that same actor's
// conversation_state. A caller can therefore never reach another tenant's or
// another conversation's object this way; at most they could reference an
// unminted/nonexistent path inside their own already-authorized
// client/conversation namespace, which carries no cross-tenant risk.
export function mediaPathBelongsToConversation({ mediaPath, clientId, conversationId }) {
  if (typeof mediaPath !== "string" || !mediaPath) return false;
  const prefix = `${clientId}/${conversationId}/`;
  return mediaPath.startsWith(prefix) && mediaPath.length > prefix.length;
}
