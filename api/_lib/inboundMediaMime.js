// Post-download MIME / container acceptability for CUSTOMER -> Inbox
// inbound media.
//
// ---------------------------------------------------------------------
// Single source of truth
// ---------------------------------------------------------------------
// This module is the authoritative definition of the inbound media
// family check. It is:
//   - imported by validateInboundMedia() in ./mediaIngest.js (the
//     server-side sign_inbound_upload gate), and
//   - MIRRORED (copied — n8n Code nodes are sandboxed and cannot import)
//     inside the "Post-Download Validate" node of
//     engineering/n8n/working/Inbound-Media-Core.json.
// Keep the three in sync. Same pattern as src/lib/mediaMessages.js, which
// is likewise a shared spec reused by the client and the API.
//
// ---------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------
//   image    -> MIME family must be "image"   (a generic octet-stream is
//               accepted — Telegram's file server serves real photos as
//               application/octet-stream).
//   audio    -> MIME family must be "audio"   (generic octet-stream
//               accepted), PLUS a provider-aware exception:
//
//               META VOICE NOTES. Facebook Messenger and Instagram Direct
//               deliver a VOICE clip as an MP4 container that the Meta CDN
//               serves with Content-Type "video/mp4". Upstream it is
//               classified message_type="audio" from the attachment's own
//               type:"audio" — the bytes are a voice recording; the
//               "video/*" is only the transport container. On the Meta
//               inbound download path only (platform facebook | instagram,
//               which share FB Host Check -> FB Download in
//               Inbound-Media-Core), message_type "audio" + MIME
//               "video/mp4" is accepted AS AUDIO. message_type is NOT
//               changed to video; the real Content-Type is preserved as
//               media_mime_type.
//
//               This can only ever fire for something Meta itself labelled
//               type:"audio": a real Meta VIDEO attachment is classified
//               upstream as message_type="document" (see mapFbType in the
//               parent workflow), never "audio", so a genuine video is
//               unaffected by this exception.
//   document -> any family (application/*, text/*, even video/*).
//
// Nothing here touches host validation, signed upload, size limits, or URL
// normalisation — those stay exactly where they are in Inbound-Media-Core.

// Container MIME types that carry no real "what is this" signal — accepted
// under whatever message_type was declared upstream rather than treated as
// a mismatch.
export const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/download",
  "*/*",
]);

// Providers whose inbound media flows through the shared Meta CDN download
// path (Route By Platform outputs 2 & 3 -> FB Host Check -> FB Download ->
// Post-Download Validate, SSRF allow-list *.fbcdn.net / *.cdninstagram.com).
export const META_DOWNLOAD_PLATFORMS = new Set(["facebook", "instagram"]);

// The container MIME Meta serves a voice/audio clip under. Kept to exactly
// "video/mp4" on purpose — video/quicktime (.mov) and video/3gpp are real
// recorded video and must NOT be reinterpreted as audio.
export const META_VOICE_CONTAINER_MIME_TYPES = new Set(["video/mp4"]);

export function normalizeMime(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}

export function isGenericMime(mime) {
  return GENERIC_MIME_TYPES.has(normalizeMime(mime));
}

// True ONLY for: platform in {facebook, instagram} AND messageType "audio"
// AND mime is a Meta voice container ("video/mp4"). This is the whole
// provider-aware compatibility exception, in one testable place.
export function isMetaVoiceContainerMime({ platform, messageType, mime } = {}) {
  return (
    META_DOWNLOAD_PLATFORMS.has(String(platform || "").trim().toLowerCase()) &&
    messageType === "audio" &&
    META_VOICE_CONTAINER_MIME_TYPES.has(normalizeMime(mime))
  );
}

// The family check. Returns { ok: true } or
// { ok: false, reason: "mime_mismatch" }.
//
// `platform` is OPTIONAL — when it is omitted or unknown the Meta voice
// exception simply never applies (safe default: strict family match).
export function checkInboundMediaFamily({ platform, messageType, mime } = {}) {
  const m = normalizeMime(mime);

  // Unknown / generic container -> accept under the declared message_type.
  if (isGenericMime(m)) return { ok: true };

  const family = m.split("/")[0];

  if (messageType === "image") {
    return family === "image" ? { ok: true } : { ok: false, reason: "mime_mismatch" };
  }

  if (messageType === "audio") {
    if (family === "audio") return { ok: true };
    if (isMetaVoiceContainerMime({ platform, messageType, mime: m })) return { ok: true };
    return { ok: false, reason: "mime_mismatch" };
  }

  // "document" (or any other declared type) -> any concrete family is fine.
  return { ok: true };
}
