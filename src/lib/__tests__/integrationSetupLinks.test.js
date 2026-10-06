import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { showsGenericSetupLinks } from "../integrationSetupLinks.js";

// D4 Step C smoke regression: Website Chat's channelKey is never sent to
// the browser, so the channelKey-based "Automatic Setup Links" panel must
// not render for it (it showed "Enter Channel Key…").

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("generic setup links hidden for website_chat and instagram", () => {
  assert.equal(showsGenericSetupLinks("website_chat"), false);
  assert.equal(showsGenericSetupLinks("Website_Chat"), false);
  assert.equal(showsGenericSetupLinks("instagram"), false);
  assert.equal(showsGenericSetupLinks("instagram_business"), false);
});

test("generic setup links still shown for legacy webhook channels", () => {
  for (const slug of ["telegram", "facebook", "whatsapp_evolution", "", undefined]) {
    assert.equal(showsGenericSetupLinks(slug), true, String(slug));
  }
});

test("ClientIntegrations gates the setup-links panel with showsGenericSetupLinks", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/pages/client/ClientIntegrations.jsx"), "utf8");
  assert.match(src, /import \{ buildChannelSetupLinks, showsGenericSetupLinks \} from "\.\.\/\.\.\/lib\/integrationSetupLinks\.js";/);
  const gate = src.indexOf("showsGenericSetupLinks(selectedFeature.slug) && (() => {");
  const links = src.indexOf("buildGeneratedLinks(selectedFeature, selectedIntegration, t, inboundWebhookBase)");
  assert.ok(gate > -1 && links > gate, "setup-links panel must be gated");
  assert.ok(links - gate < 200, "gate must wrap the panel that builds the links");
});
