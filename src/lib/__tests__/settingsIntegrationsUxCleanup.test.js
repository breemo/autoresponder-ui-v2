import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// UX cleanup (2026-10-06): A — grouped n8n settings; B — full-width setup
// links + Telegram QR modal; C — client-mode Feature Settings without
// channel cards (AI Behavior kept; channels managed on Integrations).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// ---- C: Feature Settings ----------------------------------------------------

const ACS = read("src/pages/admin/AdminClientSettings.jsx");

test("C: client mode is the clientIdOverride path for non-admins", () => {
  assert.ok(ACS.includes('const isClientMode = Boolean(clientIdOverride) && user?.role !== "admin";'));
  assert.ok(read("src/pages/client/ClientFeatureSettings.jsx").includes("<AdminClientSettings clientIdOverride={clientId} />"));
});

test("C: client mode never loads channel configs and cannot open/save a channel drawer", () => {
  const load = ACS.indexOf("if (isClientMode) {\n        // Channel configs are not loaded here");
  const fetchRows = ACS.indexOf("await fetchFeatureSettingsRows(clientId);");
  assert.ok(load > -1 && fetchRows > load, "client mode returns before fetchFeatureSettingsRows");
  assert.ok(ACS.includes('if (isClientMode && feature?.slug !== "ai_auto_reply") return;'));
  assert.ok(ACS.includes("if (isClientMode) return; // channel configuration is saved via Integrations only"));
});

test("C: client mode renders AI Behavior + Integrations link instead of channel cards; stats hidden", () => {
  const branch = ACS.indexOf("{isClientMode ? (");
  const cards = ACS.indexOf("{features.map((feature) => {");
  assert.ok(branch > -1 && cards > branch, "channel cards are only in the non-client branch");
  const clientBranch = ACS.slice(branch, ACS.indexOf(") : features.length === 0 ? (", branch));
  assert.ok(clientBranch.includes("onClick={() => openFeatureDrawer(aiBehaviorFeature)}"));
  assert.ok(clientBranch.includes('to="/client/integrations"'));
  assert.equal(clientBranch.includes("channelKey"), false);
  assert.equal(clientBranch.includes("features.map"), false);
  assert.ok(ACS.includes('const aiBehaviorFeature = features.find((feature) => feature.slug === "ai_auto_reply") || null;'));
  assert.ok(ACS.includes("const canManageIntegrations = isClientMode && hasUserPermission(user, PERMISSIONS.INTEGRATIONS);"));
  const stats = ACS.indexOf("{!isClientMode && (\n      <div className=\"grid grid-cols-1 gap-4 md:grid-cols-3\">");
  assert.ok(stats > -1 && stats < ACS.indexOf('t("featureSettingsPage.statAvailable")'));
});

test("C: Knowledge Base and subscription sections stay (both modes)", () => {
  assert.ok(ACS.includes("<KnowledgeBaseSection clientId={effectiveClientId}"));
  for (const k of ["currentSubscriptionTitle", "remainingUsageTitle", "usageStatsTitle", "historyTitle"]) {
    assert.ok(ACS.includes(`t("featureSettingsPage.${k}")`), k);
  }
});

test("C: feature_settings API is admin-only (channel configs not exposed through AI_SETTINGS)", () => {
  const api = read("api/_lib/clientFeatureSettings.js");
  assert.ok(api.includes('if (actor.kind !== "admin") return res.status(403).json({ success: false, message: "Forbidden" });'));
});

test("C: i18n keys exist (en + ar)", () => {
  for (const lang of ["en", "ar"]) {
    const d = JSON.parse(read(`src/locales/${lang}/translation.json`)).featureSettingsPage;
    for (const k of ["aiBehaviorCardTitle", "aiBehaviorCardDesc", "channelIntegrationsCardTitle", "channelIntegrationsCardDesc", "channelIntegrationsCardAction"]) {
      assert.ok(d[k], `${lang}.${k}`);
    }
  }
});

// ---- B: Integrations setup links + QR modal ------------------------------------

test("B: Automatic Setup Links render outside (after) the narrow aside, same gate", () => {
  const ci = read("src/pages/client/ClientIntegrations.jsx");
  const asideEnd = ci.indexOf("</aside>");
  const gate = ci.indexOf("showsGenericSetupLinks(selectedFeature.slug) && (() => {");
  assert.ok(asideEnd > -1 && gate > asideEnd, "setup links are no longer inside the aside");
  assert.ok(ci.lastIndexOf('<div className="px-4 pb-4 empty:hidden">', gate) > asideEnd);
  // status + reply mode remain in the aside
  const aside = ci.slice(ci.indexOf('<aside className="space-y-3">'), asideEnd);
  assert.ok(aside.includes('t("integrationsPage.readyToReceive")'));
  assert.ok(aside.includes('t("integrationsPage.replyModeLabel")'));
});

test("B: QR is an accessible modal with the same on-demand lifecycle", () => {
  const src = strip(read("src/pages/client/TelegramActivationQr.jsx"));
  assert.ok(src.includes('role="dialog"'));
  assert.ok(src.includes('aria-modal="true"'));
  assert.ok(src.includes("aria-labelledby={titleId}"));
  assert.ok(src.includes('e.key === "Escape"'));
  assert.ok(src.includes("onClick={() => setOpen(false)}")); // backdrop / close
  assert.ok(src.includes("{open && ("), "canvas only exists while open");
  assert.ok(src.includes("ctx.clearRect(0, 0, canvas.width, canvas.height);"));
  assert.ok(src.includes("}, [activationUrl]);"), "closes when the activation URL changes");
});

// ---- A: Admin system settings --------------------------------------------------

test("A: compact n8n control panel — same keys/API, grouped sections, Runtime/Reference legend", () => {
  const src = read("src/pages/admin/AdminSystemSettings.jsx");
  assert.ok(src.includes("const EMPTY = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, \"\"]));"));
  assert.ok(src.includes('fetch("/api/system-settings", {'));
  assert.ok(src.includes("Inbound &amp; Messaging") && src.indexOf("Inbound &amp; Messaging") < src.indexOf("Core Workflows"));
  for (const name of ["Main Inbound Flow", "Human Reply", "Evolution API Gateway", "AI-Agent-Core", "Inbound-Media-Core"]) {
    assert.ok(src.includes(`name: "${name}"`), name);
  }
  assert.ok(src.includes('<Badge kind="runtime" />') && src.includes('<Badge kind="reference" />'));
  assert.equal(src.includes("app_api_base_url"), false);
});
