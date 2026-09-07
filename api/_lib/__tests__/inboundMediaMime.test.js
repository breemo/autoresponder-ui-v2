import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkInboundMediaFamily,
  isMetaVoiceContainerMime,
  normalizeMime,
  isGenericMime,
} from "../inboundMediaMime.js";
import { validateInboundMedia, INBOUND_HARD_MAX_BYTES } from "../mediaIngest.js";
import { MEDIA_LIMITS } from "../../../src/lib/mediaMessages.js";

// Inbound media MIME / container acceptability — the fix for Facebook &
// Instagram voice notes arriving as message_type='audio' with a
// Content-Type of video/mp4 (an MP4 audio container), plus proof that the
// compatibility rule is tightly scoped and nothing else was weakened.

// ---------------------------------------------------------------------
// normalizeMime / isGenericMime
// ---------------------------------------------------------------------

test("normalizeMime strips parameters and lowercases", () => {
  assert.equal(normalizeMime("Audio/OGG; codecs=opus"), "audio/ogg");
  assert.equal(normalizeMime("  VIDEO/MP4 "), "video/mp4");
  assert.equal(normalizeMime(undefined), "");
});

test("isGenericMime covers the no-signal container types only", () => {
  assert.equal(isGenericMime(""), true);
  assert.equal(isGenericMime("application/octet-stream"), true);
  assert.equal(isGenericMime("binary/octet-stream"), true);
  assert.equal(isGenericMime("video/mp4"), false);
  assert.equal(isGenericMime("audio/mpeg"), false);
});

// ---------------------------------------------------------------------
// isMetaVoiceContainerMime — the scoped exception
// ---------------------------------------------------------------------

test("Meta voice container: facebook + audio + video/mp4 -> true", () => {
  assert.equal(isMetaVoiceContainerMime({ platform: "facebook", messageType: "audio", mime: "video/mp4" }), true);
});

test("Meta voice container: instagram + audio + video/mp4 -> true (shared Meta download path)", () => {
  assert.equal(isMetaVoiceContainerMime({ platform: "instagram", messageType: "audio", mime: "video/mp4" }), true);
});

test("Meta voice container: NOT whatsapp / telegram", () => {
  assert.equal(isMetaVoiceContainerMime({ platform: "whatsapp", messageType: "audio", mime: "video/mp4" }), false);
  assert.equal(isMetaVoiceContainerMime({ platform: "telegram", messageType: "audio", mime: "video/mp4" }), false);
});

test("Meta voice container: NOT for image / document message types", () => {
  assert.equal(isMetaVoiceContainerMime({ platform: "facebook", messageType: "image", mime: "video/mp4" }), false);
  assert.equal(isMetaVoiceContainerMime({ platform: "facebook", messageType: "document", mime: "video/mp4" }), false);
});

test("Meta voice container: only video/mp4 — not other video containers", () => {
  assert.equal(isMetaVoiceContainerMime({ platform: "facebook", messageType: "audio", mime: "video/quicktime" }), false);
  assert.equal(isMetaVoiceContainerMime({ platform: "facebook", messageType: "audio", mime: "video/3gpp" }), false);
  assert.equal(isMetaVoiceContainerMime({ platform: "facebook", messageType: "audio", mime: "video/webm" }), false);
});

test("Meta voice container: missing / unknown platform -> false (safe default)", () => {
  assert.equal(isMetaVoiceContainerMime({ messageType: "audio", mime: "video/mp4" }), false);
  assert.equal(isMetaVoiceContainerMime({ platform: "", messageType: "audio", mime: "video/mp4" }), false);
});

// ---------------------------------------------------------------------
// checkInboundMediaFamily — the full matrix from the task
// ---------------------------------------------------------------------

const ok = (r) => assert.deepEqual(r, { ok: true });
const mismatch = (r) => assert.equal(r.ok, false) === undefined && assert.equal(r.reason, "mime_mismatch");

test("Facebook audio + audio/mpeg -> accepted", () => {
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "audio", mime: "audio/mpeg" }));
});

test("Facebook audio + audio/mp4 -> accepted (audio family)", () => {
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "audio", mime: "audio/mp4" }));
});

test("Facebook audio + video/mp4 -> accepted AS audio (the bug fix)", () => {
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "audio", mime: "video/mp4" }));
});

test("Facebook audio + application/octet-stream -> accepted (generic container)", () => {
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "audio", mime: "application/octet-stream" }));
});

test("Facebook image + video/mp4 -> REJECTED", () => {
  mismatch(checkInboundMediaFamily({ platform: "facebook", messageType: "image", mime: "video/mp4" }));
});

test("Facebook image + image/jpeg -> accepted", () => {
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "image", mime: "image/jpeg" }));
});

test("Facebook document + any/odd MIME -> accepted (document accepts every family, unchanged)", () => {
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "document", mime: "application/x-weird" }));
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "document", mime: "video/mp4" }));
  ok(checkInboundMediaFamily({ platform: "facebook", messageType: "document", mime: "totally/bogus" }));
});

test("WhatsApp audio rules unchanged: video/mp4 -> REJECTED, audio/ogg -> accepted", () => {
  mismatch(checkInboundMediaFamily({ platform: "whatsapp", messageType: "audio", mime: "video/mp4" }));
  ok(checkInboundMediaFamily({ platform: "whatsapp", messageType: "audio", mime: "audio/ogg" }));
});

test("Telegram audio rules unchanged: video/mp4 -> REJECTED, octet-stream -> accepted (generic)", () => {
  mismatch(checkInboundMediaFamily({ platform: "telegram", messageType: "audio", mime: "video/mp4" }));
  ok(checkInboundMediaFamily({ platform: "telegram", messageType: "audio", mime: "application/octet-stream" }));
});

test("Instagram: audio + video/mp4 -> accepted AS audio; image + video/mp4 -> REJECTED", () => {
  ok(checkInboundMediaFamily({ platform: "instagram", messageType: "audio", mime: "video/mp4" }));
  mismatch(checkInboundMediaFamily({ platform: "instagram", messageType: "image", mime: "video/mp4" }));
});

test("no platform: strict family match (Meta exception cannot apply)", () => {
  mismatch(checkInboundMediaFamily({ messageType: "audio", mime: "video/mp4" }));
  ok(checkInboundMediaFamily({ messageType: "audio", mime: "audio/mpeg" }));
});

// ---------------------------------------------------------------------
// validateInboundMedia — the server sign-time gate consumes the same rule
// ---------------------------------------------------------------------

test("validateInboundMedia: facebook audio + video/mp4 -> valid", () => {
  assert.deepEqual(
    validateInboundMedia("audio", { mimeType: "video/mp4", sizeBytes: 25_000, platform: "facebook" }),
    { valid: true }
  );
});

test("validateInboundMedia: whatsapp audio + video/mp4 -> mime_mismatch (unchanged)", () => {
  assert.equal(
    validateInboundMedia("audio", { mimeType: "video/mp4", sizeBytes: 25_000, platform: "whatsapp" }).reason,
    "mime_mismatch"
  );
});

test("validateInboundMedia: no platform + audio + video/mp4 -> mime_mismatch (back-compat)", () => {
  assert.equal(validateInboundMedia("audio", { mimeType: "video/mp4", sizeBytes: 1 }).reason, "mime_mismatch");
});

test("validateInboundMedia: facebook image + video/mp4 -> mime_mismatch", () => {
  assert.equal(
    validateInboundMedia("image", { mimeType: "video/mp4", sizeBytes: 1, platform: "facebook" }).reason,
    "mime_mismatch"
  );
});

test("validateInboundMedia: existing family mismatches still rejected", () => {
  assert.equal(validateInboundMedia("image", { mimeType: "application/pdf", sizeBytes: 1 }).reason, "mime_mismatch");
  assert.equal(validateInboundMedia("audio", { mimeType: "image/png", sizeBytes: 1 }).reason, "mime_mismatch");
});

test("validateInboundMedia: oversized Meta voice note still rejected (size wins over MIME allowance)", () => {
  const over = MEDIA_LIMITS.audio.maxBytes + 1;
  const r = validateInboundMedia("audio", { mimeType: "video/mp4", sizeBytes: over, platform: "facebook" });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "too_large");
});

test("validateInboundMedia: hard cap still enforced for a facebook audio", () => {
  const r = validateInboundMedia("audio", { mimeType: "video/mp4", sizeBytes: INBOUND_HARD_MAX_BYTES + 1, platform: "facebook" });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "too_large");
});

// ---------------------------------------------------------------------
// Contract guard: the authoritative n8n workflows must keep the fix
// ---------------------------------------------------------------------

function wf(name) {
  const p = fileURLToPath(new URL(`../../../engineering/n8n/working/${name}`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf8"));
}
function nodeCode(workflow, nodeName) {
  const n = workflow.nodes.find((x) => x.name === nodeName);
  assert.ok(n, `node ${nodeName} exists`);
  return n.parameters.jsCode || n.parameters.jsonBody || "";
}

test("Inbound-Media-Core: Post-Download Validate keeps the Meta voice-note allowance, scoped", () => {
  const code = nodeCode(wf("Inbound-Media-Core.json"), "Post-Download Validate");
  assert.match(code, /isMetaVoiceMp4/);
  assert.match(code, /platform === "facebook" \|\| platform === "instagram"/);
  assert.match(code, /messageType === "audio" &&\s*\n?\s*mime === "video\/mp4"/);
  // still rejects a real family mismatch when the exception does not apply
  assert.match(code, /fam !== "audio" && !isMetaVoiceMp4/);
  assert.match(code, /fam !== "image"/); // image check untouched
});

test("Inbound-Media-Core: Sign Upload forwards platform for the server-side twin check", () => {
  const body = nodeCode(wf("Inbound-Media-Core.json"), "Sign Upload");
  assert.match(body, /platform: \$json\.platform/);
});

test("parent workflows: failed media ingest writes a placeholder, never a blank row", () => {
  for (const name of ["AutoResponder_Final.json", "AutoResponder_WhatsApp_V2.json"]) {
    const code = nodeCode(wf(name), "Build Inbound Message Row");
    assert.match(code, /if \(!row\.message\) \{/, `${name}: guards the empty message`);
    assert.match(code, /Unsupported media/, `${name}: writes a deterministic placeholder`);
    // the media-OK branch is unchanged (still keyed on incoming.ok + media_path)
    assert.match(code, /incoming\.ok === true && incoming\.media_path/);
  }
});
