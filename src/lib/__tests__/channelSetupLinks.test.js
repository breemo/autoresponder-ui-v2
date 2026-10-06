import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildChannelSetupLinks, getConfigValue, setupPlatformFromSlug } from "../integrationSetupLinks.js";
import { buildQrMatrix } from "../telegramActivationQr.js";
import qrcode from "qrcode-generator";

// Channel setup links come from the backend-served Main Inbound Flow base
// (no VITE_WEBHOOK_BASE_URL fallback) + the on-demand Telegram activation QR.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const DEV = "https://n8n-production-fcd4.up.railway.app/webhook/ca335c86-de34-4bbb-ac74-57d89095f9bc/dev/inbound";

test("Telegram: webhook = <base>/telegram/<channelKey>; activation embeds that exact URL", () => {
  const r = buildChannelSetupLinks({ slug: "telegram", config: { channelKey: "tg-key", "Bot Token": "123:ABC" }, inboundBase: DEV });
  assert.equal(r.platform, "telegram");
  assert.equal(r.webhookUrl, `${DEV}/telegram/tg-key`);
  assert.equal(r.activationUrl, `https://api.telegram.org/bot123:ABC/setWebhook?url=${encodeURIComponent(`${DEV}/telegram/tg-key`)}`);
});

test("Telegram without a Bot Token -> webhook only, no activation link", () => {
  const r = buildChannelSetupLinks({ slug: "telegram", config: { channelKey: "k" }, inboundBase: DEV });
  assert.equal(r.activationUrl, null);
});

test("Facebook / Instagram use the same environment base; legacy key spellings still resolve", () => {
  assert.equal(buildChannelSetupLinks({ slug: "facebook", config: { "Channel Key": "fb" }, inboundBase: DEV }).webhookUrl, `${DEV}/facebook/fb`);
  assert.equal(buildChannelSetupLinks({ slug: "instagram", config: { channel_key: "ig" }, inboundBase: `${DEV}/` }).webhookUrl, `${DEV}/instagram/ig`);
  assert.equal(buildChannelSetupLinks({ slug: "facebook", config: { channelKey: "fb" }, inboundBase: DEV }).activationUrl, null);
  assert.equal(setupPlatformFromSlug("messenger"), "facebook");
  assert.equal(getConfigValue({ "bot token": " t " }, ["Bot Token"]), "t");
});

test("fail closed: no base (missing/invalid from the backend) or no channelKey -> no links", () => {
  for (const inboundBase of [null, undefined, "", "   "]) {
    assert.equal(buildChannelSetupLinks({ slug: "telegram", config: { channelKey: "k", "Bot Token": "T" }, inboundBase }), null);
  }
  assert.equal(buildChannelSetupLinks({ slug: "telegram", config: { "Bot Token": "T" }, inboundBase: DEV }), null);
});

test("no frontend source reads VITE_WEBHOOK_BASE_URL any more (Website Chat server use is separate)", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        if (name !== "__tests__") walk(p);
      }
      else if (/\.(jsx?|tsx?)$/.test(name) && strip(fs.readFileSync(p, "utf8")).includes("VITE_WEBHOOK_BASE_URL")) offenders.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(offenders, []);
  // Website Chat keeps using the origin of the server env var (unchanged).
  assert.ok(read("api/_lib/websiteChatOrchestrator.js").includes("originFromUrl(env.VITE_WEBHOOK_BASE_URL)"));
});

test("pages use the backend-served base", () => {
  const ci = read("src/pages/client/ClientIntegrations.jsx");
  assert.ok(ci.includes('setInboundWebhookBase(typeof listResp.inbound_webhook_base === "string" ? listResp.inbound_webhook_base : null);'));
  assert.ok(ci.includes("buildGeneratedLinks(selectedFeature, selectedIntegration, t, inboundWebhookBase)"));
  assert.ok(ci.includes('webhookBase={inboundWebhookBase || ""}'));
  assert.ok(ci.includes('t("integrationsPage.inboundWebhookNotConfigured")'));
  const admin = read("src/pages/admin/AdminClientSettings.jsx");
  assert.ok(admin.includes('setInboundWebhookBase(typeof data.inbound_webhook_base === "string" ? data.inbound_webhook_base : null);'));
  assert.ok(admin.includes("inboundBase: inboundWebhookBase"));
});

// ---- Telegram activation QR ------------------------------------------------

test("buildQrMatrix encodes EXACTLY the given activation URL (same matrix as the library)", () => {
  const url = `https://api.telegram.org/bot123:ABC/setWebhook?url=${encodeURIComponent(`${DEV}/telegram/k`)}`;
  const m = buildQrMatrix(url);
  const ref = qrcode(0, "M");
  ref.addData(url, "Byte");
  ref.make();
  assert.equal(m.size, ref.getModuleCount());
  for (let r = 0; r < m.size; r += 1) for (let c = 0; c < m.size; c += 1) assert.equal(m.modules[r][c], ref.isDark(r, c));
  assert.equal(buildQrMatrix(""), null);
  assert.equal(buildQrMatrix(null), null);
});

test("QR component: on demand, passed-in URL only, no persistence / network / download / logging", () => {
  const src = strip(read("src/pages/client/TelegramActivationQr.jsx"));
  assert.ok(src.includes("buildQrMatrix(activationUrl)"));
  assert.ok(src.includes("useState(false)")); // closed until the user asks
  for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "toDataURL", "toBlob", "download", "console.", "http://", "https://", "XMLHttpRequest", "indexedDB"]) {
    assert.equal(src.includes(forbidden), false, forbidden);
  }
  const helper = strip(read("src/lib/telegramActivationQr.js"));
  for (const forbidden of ["fetch(", "http://", "https://", "localStorage", "console."]) assert.equal(helper.includes(forbidden), false, forbidden);
  // rendered only for the Telegram activation card
  const ci = read("src/pages/client/ClientIntegrations.jsx");
  assert.ok(ci.includes("{activationQr && <TelegramActivationQr activationUrl={value} />}"));
  assert.ok(ci.includes("activationQr: true"));
});

test("qrcode-generator is a pinned runtime dependency", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies["qrcode-generator"], "2.0.4");
  assert.ok(read("pnpm-lock.yaml").includes("qrcode-generator@2.0.4"));
});

test("i18n: new integrationsPage keys exist in en and ar", () => {
  for (const lang of ["en", "ar"]) {
    const d = JSON.parse(read(`src/locales/${lang}/translation.json`)).integrationsPage;
    for (const k of ["inboundWebhookNotConfigured", "showActivationQr", "hideActivationQr", "activationQrWarning", "activationQrAlt"]) assert.ok(d[k], `${lang}.${k}`);
  }
});
