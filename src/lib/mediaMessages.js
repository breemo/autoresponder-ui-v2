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

// Validates a browser File against the centralized limits for a given
// media message type. Returns { valid: true } or
// { valid: false, reason: "unsupported_type" | "too_large", maxBytes? }.
// UI-only — never a security boundary by itself; the future upload
// endpoint must re-validate server-side before minting a signed upload
// URL, the same "client-side checks are UX, not enforcement" principle
// already applied to permission gating elsewhere in this app.
export function validateMediaFile(messageType, file) {
  const limits = MEDIA_LIMITS[messageType];
  if (!limits || !file) return { valid: false, reason: "unsupported_type" };
  if (limits.mimeTypes.length && !limits.mimeTypes.includes(file.type)) {
    return { valid: false, reason: "unsupported_type" };
  }
  if (file.size > limits.maxBytes) {
    return { valid: false, reason: "too_large", maxBytes: limits.maxBytes };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// WhatsApp Evolution channel gating
// ---------------------------------------------------------------------------
//
// v1 media support is WhatsApp Evolution ONLY. This app also has a
// separate, distinct "WhatsApp Cloud API" feature (features.slug =
// "whatsapp", see AdminClientSettings.jsx's FEATURE_META: title "WhatsApp
// Cloud API") that is explicitly NOT in scope for media in this phase.
//
// IMPORTANT — could not be safely resolved from this repository:
// ClientIntegrations.jsx's own webhook-URL builder (buildGeneratedLinks's
// `platform` ternary) collapses BOTH the "whatsapp" (Cloud API) and
// "whatsapp_evolution" feature slugs to the exact same literal platform
// string "whatsapp" when building the inbound webhook URL
// (`${webhookBase}/${platform}/${channelKey}`). If n8n's inbound webhook
// (`POST inbound/:platform/:channelKey`, see
// engineering/knowledge/N8N_WORKFLOWS.md) writes that same `:platform`
// segment into messages.channel / conversation_state.platform, a plain
// "whatsapp" value is AMBIGUOUS between the two integrations — enabling
// media on it would risk also enabling it for Cloud API conversations,
// which this phase explicitly must not do. No other column visible to
// this repository (messages, conversation_state) disambiguates the two.
//
// Until the real runtime value is confirmed, EVOLUTION_CHANNEL_VALUES
// stays empty and isWhatsAppEvolutionChannel() always returns false —
// media controls stay disabled everywhere, for every channel, which is
// the safe default. To enable v1: confirm the actual channel/platform
// value written for a real WhatsApp Evolution conversation (inspect a
// live messages/conversation_state row for a known Evolution-connected
// client, or confirm the exact `:platform` segment n8n's Evolution inbound
// path uses) and add that exact value to this array — no other code
// change is required.
export const EVOLUTION_CHANNEL_VALUES = [];

export function isWhatsAppEvolutionChannel(channel) {
  const key = String(channel || "").trim().toLowerCase();
  if (!key) return false;
  return EVOLUTION_CHANNEL_VALUES.includes(key);
}

// Single gate the composer checks before enabling any media control. Kept
// separate from isWhatsAppEvolutionChannel so a future per-plan/feature
// check (e.g. does this client's plan even include media) can be added
// here later without touching call sites.
export function canSendMediaOnChannel(channel) {
  return isWhatsAppEvolutionChannel(channel);
}
