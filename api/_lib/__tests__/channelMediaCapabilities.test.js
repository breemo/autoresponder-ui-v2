import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHANNEL_MEDIA_TYPE_SUPPORT,
  canSendMediaTypeOnChannel,
  MESSAGE_TYPES,
} from "../../../src/lib/mediaMessages.js";

// Per-channel OUTBOUND media capability. Live Instagram testing confirmed
// Meta rejects an outbound audio attachment ("attachment type not
// supported") for both audio/mpeg and MP4 — so the employee Audio control
// is hidden for an Instagram conversation, alongside the already-disabled
// Document control. Image stays. Instagram INBOUND audio is a separate
// path and is unaffected.

// ---------------------------------------------------------------------
// Instagram outbound — the change
// ---------------------------------------------------------------------

test("Instagram outbound: audio is NOT allowed", () => {
  assert.equal(canSendMediaTypeOnChannel("instagram", MESSAGE_TYPES.AUDIO), false);
  assert.equal(canSendMediaTypeOnChannel("Instagram", "audio"), false); // case-insensitive
});

test("Instagram outbound: document is NOT allowed (unchanged)", () => {
  assert.equal(canSendMediaTypeOnChannel("instagram", MESSAGE_TYPES.DOCUMENT), false);
});

test("Instagram outbound: image IS allowed (unchanged)", () => {
  assert.equal(canSendMediaTypeOnChannel("instagram", MESSAGE_TYPES.IMAGE), true);
});

test("CHANNEL_MEDIA_TYPE_SUPPORT.instagram = image only", () => {
  assert.deepEqual(CHANNEL_MEDIA_TYPE_SUPPORT.instagram, { image: true, audio: false, document: false });
});

// ---------------------------------------------------------------------
// Other channels — must NOT change
// ---------------------------------------------------------------------

for (const channel of ["whatsapp", "facebook", "telegram"]) {
  test(`${channel} outbound: image / audio / document all still allowed`, () => {
    assert.equal(canSendMediaTypeOnChannel(channel, "image"), true);
    assert.equal(canSendMediaTypeOnChannel(channel, "audio"), true);
    assert.equal(canSendMediaTypeOnChannel(channel, "document"), true);
  });

  test(`${channel} has no per-type capability override (uses the default-allow path)`, () => {
    assert.equal(CHANNEL_MEDIA_TYPE_SUPPORT[channel], undefined);
  });
}

test("an unknown / unsupported channel allows nothing", () => {
  assert.equal(canSendMediaTypeOnChannel("line", "image"), false);
  assert.equal(canSendMediaTypeOnChannel("", "image"), false);
  assert.equal(canSendMediaTypeOnChannel(undefined, "audio"), false);
});

// ---------------------------------------------------------------------
// Server-side backstop lives in the Human Reply n8n builder
// ---------------------------------------------------------------------

test("Human Reply build_provider_request rejects an Instagram audio send (no Meta call)", () => {
  const p = fileURLToPath(
    new URL("../../../engineering/n8n/working/Human Reply - Multi Channel Media.json", import.meta.url)
  );
  const wf = JSON.parse(readFileSync(p, "utf8"));
  const node = wf.nodes.find((n) => n.name === "build_provider_request");
  assert.ok(node, "build_provider_request node exists");
  const code = node.parameters.jsCode;

  // The Instagram audio branch throws, matching the document branch.
  assert.match(code, /Instagram does not support audio messages/);
  assert.match(code, /Instagram does not support document messages/);

  // It must NOT still build an `type: "audio"` attachment for Instagram
  // (the old EXPERIMENTAL send-to-Meta behaviour is gone).
  assert.doesNotMatch(code, /EXPERIMENTAL: Instagram Messaging audio/);

  // Instagram image send is still built.
  const igImageIdx = code.indexOf('else if (messageType === "image")', code.indexOf('platform === "instagram"'));
  assert.ok(igImageIdx > -1, "Instagram image branch still present");
});
