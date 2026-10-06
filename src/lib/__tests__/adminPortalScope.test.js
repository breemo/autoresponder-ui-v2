import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Admin Portal = platform administration only. Cross-tenant operational
// screens (Admin Messages / Admin Auto Replies) were removed; day-to-day
// operations live in the Client Portal. See
// engineering/reports/claude/2026-10-06-admin-portal-responsibility-audit.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const LAYOUT = read("src/layouts/SharedDashboardLayout.jsx");
const APP = read("src/App.jsx");

test("final admin sidebar: Overview -> Clients -> Plans -> Features -> Settings", () => {
  const block = LAYOUT.slice(LAYOUT.indexOf("const adminItems = ["), LAYOUT.indexOf("];", LAYOUT.indexOf("const adminItems = [")));
  const routes = [...block.matchAll(/to: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(routes, ["/admin", "/admin/clients", "/admin/plans", "/admin/features", "/admin/settings"]);
});

test("admin messages / auto-replies: no page, no import, no title or full-height wiring", () => {
  for (const f of ["src/pages/admin/AdminMessages.jsx", "src/pages/admin/AdminAutoReplies.jsx"]) {
    assert.equal(fs.existsSync(path.join(ROOT, f)), false, f);
  }
  assert.equal(/AdminMessages|AdminAutoReplies/.test(APP), false);
  assert.equal(LAYOUT.includes('"/admin/messages"'), false);
  assert.equal(LAYOUT.includes('"/admin/auto-replies"'), false);
  assert.ok(LAYOUT.includes('const FULL_HEIGHT_ROUTES = ["/client/messages"];'));
});

test("old admin bookmarks redirect to /admin", () => {
  assert.ok(APP.includes('<Route path="/admin/messages" element={<Navigate to="/admin" replace />} />'));
  assert.ok(APP.includes('<Route path="/admin/auto-replies" element={<Navigate to="/admin" replace />} />'));
});

test("client Inbox and Auto Replies are unchanged", () => {
  assert.ok(LAYOUT.includes('{ to: "/client/messages", labelKey: "navigation.conversations"'));
  assert.ok(LAYOUT.includes('{ to: "/client/auto-replies", labelKey: "navigation.autoReplies"'));
  assert.ok(APP.includes('path="/client/messages"'));
  assert.ok(APP.includes('path="/client/auto-replies"'));
  assert.ok(fs.existsSync(path.join(ROOT, "src/pages/client/ClientMessages.jsx")));
  assert.ok(fs.existsSync(path.join(ROOT, "src/pages/client/ClientAutoReplies.jsx")));
});

test("no admin page reads tenants' operational content from the browser", () => {
  const dir = path.join(ROOT, "src/pages/admin");
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.jsx?$/.test(name)) continue;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    for (const table of ["messages", "leads", "conversation_state", "auto_replies"]) {
      if (new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]`).test(src)) offenders.push(`${name}:${table}`);
    }
  }
  assert.deepEqual(offenders, []);
});
