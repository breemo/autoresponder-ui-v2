import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeNavKey, pageTitleKey, pageWidthFor, visibleClientNav, visibleUserMenu } from "../clientNav.js";

// Client Portal redesign Phase 0-2: compact ClientShell (client only),
// route-preserving grouped navigation, page width variants, real-data Home.
// See engineering/reports/claude/2026-10-07-client-portal-shell-home-implementation.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const member = (client_role, extra = {}) => ({ role: "client", client_role, is_active: true, permissions_overrides: null, ...extra });
// Code without comments (guards must not trip on explanatory comments).
const code = (src) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const hrefs = (user) => visibleClientNav(user).map((i) => i.to);

test("owner sees the 8 grouped primary items (no route changes)", () => {
  assert.deepEqual(hrefs(member("owner")), [
    "/client",
    "/client/messages",
    "/client/leads",
    "/client/auto-replies",
    "/client/feature-settings",
    "/client/integrations",
    "/client/team",
    "/client/settings",
  ]);
});

test("agent keeps Replies (auto_replies) without Settings; IT gets AI Agent/Integrations/Settings", () => {
  assert.deepEqual(hrefs(member("agent")), ["/client", "/client/messages", "/client/leads", "/client/auto-replies"]);
  assert.deepEqual(hrefs(member("it")), ["/client", "/client/feature-settings", "/client/integrations", "/client/settings"]);
});

test("permission overrides are respected", () => {
  const agentNoLeads = member("agent", { permissions_overrides: { leads: false, integrations: true } });
  assert.deepEqual(hrefs(agentNoLeads), ["/client", "/client/messages", "/client/auto-replies", "/client/integrations"]);
  assert.deepEqual(hrefs(member("agent", { is_active: false })), []);
});

test("must_change_password collapses navigation to My Account", () => {
  const u = member("owner", { must_change_password: true });
  assert.deepEqual(hrefs(u), ["/client/account"]);
  assert.deepEqual(visibleUserMenu(u).map((i) => i.to), ["/client/account"]);
  assert.deepEqual(visibleUserMenu(member("agent")).map((i) => i.to), ["/client/account", "/client/my-performance"]);
});

test("grouped routes resolve to their nav item; titles and widths per route", () => {
  assert.equal(activeNavKey("/client/quick-replies"), "replies");
  assert.equal(activeNavKey("/client/team-performance"), "team");
  assert.equal(activeNavKey("/client"), "home");
  assert.equal(pageTitleKey("/client/feature-settings"), "shell.nav.aiAgent");
  assert.equal(pageWidthFor("/client/messages"), "full");
  assert.equal(pageWidthFor("/client/leads"), "wide");
  assert.equal(pageWidthFor("/client/settings"), "readable");
  assert.equal(pageWidthFor("/client/feature-settings"), "readablePlus");
});

test("Client uses ClientShell; Admin keeps SharedDashboardLayout", () => {
  assert.ok(read("src/layouts/ClientLayout.jsx").includes("<ClientShell>{children}</ClientShell>"));
  const admin = read("src/layouts/AdminLayout.jsx");
  assert.ok(admin.includes('<SharedDashboardLayout panel="admin">{children}</SharedDashboardLayout>'));
  const shared = read("src/layouts/SharedDashboardLayout.jsx");
  assert.ok(shared.includes("w-72") && shared.includes("bg-[#0F172A]") && shared.includes("const adminItems = ["));
});

test("ClientShell keeps the RTL-safe drawer transform and existing behaviors", () => {
  const shell = read("src/layouts/ClientShell.jsx");
  assert.ok(shell.includes('mobileNavOpen ? "translate-x-0" : isRtl ? "translate-x-full" : "-translate-x-full"'));
  assert.equal(/rtl:-?translate-x/.test(code(shell)), false);
  assert.ok(shell.includes('navigate("/login")'));
  assert.ok(shell.includes("clearSessionExpiry()"));
  assert.ok(shell.includes("<SubscriptionBanner />"));
  assert.ok(shell.includes("<RouteErrorBoundary key={location.pathname}>"));
  assert.ok(shell.includes("h-app-viewport"));
  assert.ok(shell.includes("safe-area-inset-top"));
});

test("Home uses real data only (no sample numbers, no fake health/live/AI-conversation metrics)", () => {
  const home = code(read("src/pages/client/ClientDashboard.jsx"));
  assert.ok(home.includes("/api/conversation?resource=dashboard"));
  assert.ok(home.includes("aiReplies / outboundTotal"));
  for (const fake of ["1,284", "327", "91%", "Healthy", "Live activity", "fully handled"]) {
    assert.equal(home.includes(fake), false, fake);
  }
});

test("new shell/home strings exist in EN and AR with identical keys", () => {
  const en = JSON.parse(read("src/locales/en/translation.json"));
  const ar = JSON.parse(read("src/locales/ar/translation.json"));
  const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  for (const ns of ["shell", "home"]) assert.deepEqual(flat(en[ns]).sort(), flat(ar[ns]).sort());
  assert.equal(/ai assistant/i.test(JSON.stringify(en.shell) + JSON.stringify(en.home)), false);
});
