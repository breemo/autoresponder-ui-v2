import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEmbedSnippet,
  buildPreviewUrl,
  collapseWebsiteChatRows,
  isHostListed,
  maskPublicKey,
  parseDomainsInput,
  WEBSITE_CHAT_CARD_ID,
} from "../websiteChatEmbed.js";

// D4 Step C — Smoke Finding #2: Website Chat install/setup UI (Phase U MVP).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const KEY = "wcpk_Abcdefghijklmnopqrstuvwxyz012345";
const ORIGIN = "https://jawab-ai-git-develop-example.vercel.app";

// ---- embed snippet ------------------------------------------------------

test("buildEmbedSnippet: exact embed.js contract with the public key only", () => {
  assert.equal(
    buildEmbedSnippet(ORIGIN, KEY),
    `<script src="${ORIGIN}/widget/embed.js" data-key="${KEY}" async></script>`
  );
  // origin is normalized (path/trailing slash dropped)
  assert.equal(buildEmbedSnippet(`${ORIGIN}/client/integrations`, KEY), buildEmbedSnippet(ORIGIN, KEY));
});

test("buildEmbedSnippet matches the loader's own documented usage and key format", () => {
  const embed = read("public/widget/embed.js");
  assert.ok(embed.includes('<script src="https://<auto-responder-host>/widget/embed.js" data-key="wcpk_…" async></script>'));
  assert.ok(embed.includes('script.getAttribute("data-key")'));
  assert.ok(embed.includes("/^wcpk_[A-Za-z0-9_-]{32}$/"));
});

test("buildEmbedSnippet / buildPreviewUrl: invalid key or origin -> empty", () => {
  for (const bad of ["", null, undefined, "wcpk_short", `${KEY}x`, "wcpk_Abcdefghijklmnopqrstuvwxyz01234<", "pk_" + "a".repeat(32)]) {
    assert.equal(buildEmbedSnippet(ORIGIN, bad), "", String(bad));
    assert.equal(buildPreviewUrl(ORIGIN, bad, "en"), "", String(bad));
  }
  for (const badOrigin of ["", "javascript:alert(1)", "not a url", "ftp://x.com"]) {
    assert.equal(buildEmbedSnippet(badOrigin, KEY), "");
    assert.equal(buildPreviewUrl(badOrigin, KEY, "en"), "");
  }
});

test("buildPreviewUrl: existing demo page with key + lang", () => {
  assert.equal(buildPreviewUrl(ORIGIN, KEY, "en"), `${ORIGIN}/widget/demo.html?key=${KEY}&lang=en`);
  assert.equal(buildPreviewUrl(ORIGIN, KEY, "ar-SA"), `${ORIGIN}/widget/demo.html?key=${KEY}&lang=ar`);
  assert.equal(buildPreviewUrl(ORIGIN, KEY, undefined), `${ORIGIN}/widget/demo.html?key=${KEY}&lang=en`);
  assert.ok(fs.existsSync(path.join(ROOT, "public/widget/demo.html")));
});

test("maskPublicKey: only the last 4 characters visible", () => {
  assert.equal(maskPublicKey(KEY), "wcpk_••••2345");
  assert.equal(maskPublicKey("bad"), "");
});

test("isHostListed mirrors server domain rules (UX hint only)", () => {
  assert.equal(isHostListed("example.com", ["example.com"]), true);
  assert.equal(isHostListed("www.example.com", ["example.com"]), false);
  assert.equal(isHostListed("a.example.com", ["*.example.com"]), true);
  assert.equal(isHostListed("example.com", ["*.example.com"]), false);
  assert.equal(isHostListed("localhost", ["localhost"]), true);
  assert.equal(isHostListed("", ["example.com"]), false);
  assert.equal(isHostListed("example.com", null), false);
});

test("parseDomainsInput splits lines/commas/spaces", () => {
  assert.deepEqual(parseDomainsInput("example.com\n*.example.com, shop.io  "), ["example.com", "*.example.com", "shop.io"]);
  assert.deepEqual(parseDomainsInput(""), []);
});

test("collapseWebsiteChatRows: N site rows -> one card (no site config kept)", () => {
  const rows = [
    { id: "tg", feature_id: "f-tg", slug: "telegram", is_active: true, config: {} },
    { id: "s1", feature_id: "f-wc", slug: "website_chat", is_active: false, config: { publicKey: KEY } },
    { id: "s2", feature_id: "f-wc", slug: "website_chat", is_active: true, config: { publicKey: KEY } },
  ];
  const out = collapseWebsiteChatRows(rows, "f-wc");
  assert.deepEqual(out.map((r) => r.id), ["tg", WEBSITE_CHAT_CARD_ID]);
  const card = out[1];
  assert.equal(card.site_count, 2);
  assert.equal(card.is_active, true);
  assert.deepEqual(card.config, {});
  assert.equal(collapseWebsiteChatRows([rows[0]], "f-wc").length, 1);
  // matched by feature id even without slug
  assert.equal(collapseWebsiteChatRows([{ id: "x", feature_id: "f-wc" }], "f-wc")[0].id, WEBSITE_CHAT_CARD_ID);
});

test("helpers never produce or read channelKey", () => {
  const helper = stripComments(read("src/lib/websiteChatEmbed.js"));
  assert.equal(/channel_?key/i.test(helper), false);
  assert.equal(buildEmbedSnippet(ORIGIN, KEY).toLowerCase().includes("channel"), false);
});

// ---- WebsiteChatSection --------------------------------------------------

test("WebsiteChatSection: only the website_chat resource; reuses existing actions; no channelKey", () => {
  const src = stripComments(read("src/pages/client/WebsiteChatSection.jsx"));
  assert.ok(src.includes('"/api/client-integrations?resource=website_chat"'));
  const fetchTargets = [...src.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(fetchTargets.length >= 2);
  for (const target of fetchTargets) assert.ok(target.startsWith("API") || target.startsWith("`${API}"), target);
  for (const action of ['"create"', '"update"', '"set_active"']) assert.ok(src.includes(action), action);
  // Rotate key / Delete deliberately not exposed in this pass.
  assert.equal(src.includes('"regenerate_key"'), false);
  assert.equal(src.includes('"delete"'), false);
  assert.equal(/channel_?key/i.test(src), false);
  assert.equal(src.includes("supabase"), false);
  assert.ok(src.includes("buildEmbedSnippet(origin, site.public_key)"));
  assert.ok(src.includes("buildPreviewUrl(origin, site.public_key"));
});

// ---- ClientIntegrations hook ---------------------------------------------

test("ClientIntegrations: Website Chat bypasses the generic add / set_active / editor", () => {
  const src = read("src/pages/client/ClientIntegrations.jsx");
  // collapsed into one card
  assert.ok(src.includes("collapseWebsiteChatRows(normalized, websiteChatFeature?.id)"));
  // Add tile: returns before the generic `add` call for website_chat
  const addFn = src.slice(src.indexOf("async function handleAddIntegration(feature)"));
  const wcBranch = addFn.indexOf("if (isWebsiteChatSlug(feature?.slug))");
  const genericAdd = addFn.indexOf('callIntegrationAction("add"');
  assert.ok(wcBranch > -1 && genericAdd > wcBranch);
  assert.ok(addFn.slice(wcBranch, genericAdd).includes("return;"));
  // Detail: early return rendering WebsiteChatSection before the generic
  // header (toggle/save), field editor, reply-mode summary and setup links.
  const branch = src.indexOf("if (isWebsiteChatSlug(selectedFeature.slug)) {");
  const section = src.indexOf("<WebsiteChatSection", branch);
  const genericToggle = src.indexOf("onClick={() => toggleActive(selectedIntegration.feature_id");
  const noFields = src.indexOf('t("integrationsPage.noCustomFields")');
  const links = src.indexOf("showsGenericSetupLinks(selectedFeature.slug) && (() => {");
  assert.ok(branch > -1 && section > branch);
  const branchBody = src.slice(branch, src.indexOf("return (", section));
  assert.ok(branchBody.includes("<WebsiteChatSection"));
  for (const generic of [genericToggle, noFields, links]) assert.ok(generic > section, "generic UI must come after the website_chat early return");
  assert.equal(branchBody.includes("toggleActive("), false);
  assert.equal(branchBody.includes("handleSaveIntegration("), false);
});

test("websiteChat.* translations exist in en and ar for every key used", () => {
  const src = read("src/pages/client/WebsiteChatSection.jsx");
  const keys = [...new Set([...src.matchAll(/\bt\(\s*"(websiteChat\.[a-zA-Z0-9_]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 10);
  for (const lang of ["en", "ar"]) {
    const dict = JSON.parse(read(`src/locales/${lang}/translation.json`));
    for (const k of keys) assert.ok(dict.websiteChat?.[k.split(".")[1]], `${lang}: ${k}`);
  }
});
