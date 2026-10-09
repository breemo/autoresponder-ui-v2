import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextHideAfterSelection } from "../../pages/client/replies/selection.js";

// Client Portal final UI consistency pass (Replies, Team, Team Performance,
// Account Settings). Guards the request/payload expressions that must stay
// identical and the shared overlay contract.
// See engineering/reports/claude/2026-10-09-client-portal-final-ui-pass.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

test("Hide After Selecting: checkbox model reproduces <select multiple> values", () => {
  const opts = [{ value: "BOOKING" }, { value: "PRICES" }, { value: "HUMAN" }];
  assert.deepEqual(nextHideAfterSelection(opts, ["BOOKING", "PRICES"], 2), ["BOOKING", "PRICES", "HUMAN"]);
  assert.deepEqual(nextHideAfterSelection(opts, ["BOOKING", "PRICES"], 0), ["PRICES"]);
  assert.deepEqual(nextHideAfterSelection(opts, ["HUMAN", "BOOKING"], 1), ["BOOKING", "PRICES", "HUMAN"]); // option order, like selectedOptions
  assert.deepEqual(nextHideAfterSelection(opts, ["GONE"], 1), ["PRICES"]); // unknown values dropped on change, like the native select
  assert.deepEqual(nextHideAfterSelection([{ value: "X" }, { value: "X" }], ["X"], 0), ["X"]); // duplicate payloads behave like the native select
});

test("Auto Replies: queries and payloads unchanged", () => {
  const s = read("src/pages/client/ClientAutoReplies.jsx");
  assert.match(s, /\.update\(\{ trigger_text: form\.trigger_text\.trim\(\), reply_text: form\.reply_text\.trim\(\), is_active: form\.is_active \}\)\.eq\("id", form\.id\)\.eq\("client_id", clientId\)/);
  assert.match(s, /\.insert\(\[\{ client_id: clientId, trigger_text: form\.trigger_text\.trim\(\), reply_text: form\.reply_text\.trim\(\), is_active: form\.is_active \}\]\)/);
  assert.match(s, /\.update\(\{ is_active: !r\.is_active \}\)/);
  assert.match(s, /if \(!form\.id && autoLimit > 0 && replies\.length >= autoLimit\)/);
  assert.match(s, /window\.confirm\(t\("autoRepliesPage\.confirmDelete"\)\)/);
});

test("Quick Replies: record shape + payload fallback unchanged", () => {
  const s = read("src/pages/client/ClientQuickReplies.jsx");
  assert.match(s, /const finalPayload = payload\.trim\(\) \|\| title\.trim\(\)\.replace\(\/\\s\+\/g, "_"\)\.toUpperCase\(\);/);
  assert.match(s, /const record = \{ client_id: clientId, title: title\.trim\(\), payload: finalPayload, action_type: type, display_order: Number\(displayOrder\) \|\| items\.length \+ 1, is_active: true, hide_after_payloads: hideAfterPayloads \};/);
  assert.match(s, /items\.map\(\(item\) => \(\{ key: item\.id, value: item\.payload, label: item\.title \}\)\)/);
  for (const v of ["custom", "order", "booking", "quote", "human_request", "question"]) assert.ok(s.includes(`<option value="${v}">`), v);
  assert.doesNotMatch(s, /<select multiple className/);
});

test("Team: actions, confirms and security-sensitive calls unchanged", () => {
  const s = read("src/pages/client/ClientTeam.jsx");
  for (const a of ["add_user", "change_role", "set_active", "remove", "reset_password", "change_permissions"]) assert.ok(s.includes(`callTeamAction("${a}"`), a);
  for (const c of ["confirmChangeOwnerRole", "confirmDeactivate", "confirmRemove", "confirmResetPassword"]) assert.ok(s.includes(`team.${c}`), c);
  assert.match(s, /disabled: busy \|\| lastOwner,\s*title: lastOwner \? t\("team\.lockLastOwnerToggle"\)/);
  assert.match(s, /disabled: busy \|\| lastOwner,\s*title: lastOwner \? t\("team\.lockLastOwnerRemove"\)/);
  assert.match(s, /disabled: busy \|\| !member\.is_active,/);
  assert.match(s, /if \(prev\.member\.role === "owner" && key === PERMISSIONS\.TEAM_MANAGEMENT\) return prev;/);
  assert.match(s, /const canManage = hasUserPermission\(user, PERMISSIONS\.TEAM_MANAGEMENT\);/);
});

test("Account Settings: single Save request + payload unchanged; Apply never persists", () => {
  const s = read("src/pages/client/ClientSettings.jsx");
  assert.match(s, /\.from\("clients"\)\s*\.update\(\{\s*business_name: form\.business_name,\s*phone: form\.phone,\s*address: form\.address,\s*business_description: form\.business_description,\s*welcome_message: form\.welcome_message,\s*default_reply: form\.default_reply,\s*closing_message: form\.closing_message,\s*website: form\.website \|\| null,\s*timezone: workingHours\.timezone\.trim\(\) \|\| null,\s*working_hours: workingHoursPayload,\s*\}\)/);
  assert.equal((s.match(/\.from\("clients"\)/g) || []).length, 2); // load + save only
  const drawer = s.slice(s.indexOf("function BusinessHoursDrawer"), s.indexOf("export default function ClientSettings"));
  assert.doesNotMatch(drawer, /supabase|fetch\(/);
  for (const k of ["welcome_message", "default_reply", "closing_message", "business_description", "website", "address", "phone", "business_name"]) assert.ok(s.includes(`"${k}"`) || s.includes(`form.${k}`), k);
  const loc = read("src/pages/client/LocationsSection.jsx");
  for (const a of ["update", "add", "set_primary", "set_active", "delete", "set_list_complete"]) assert.ok(loc.includes(`callApi("${a}"`), a);
});

test("Overlays: portal, dialog semantics, Escape; no legacy hero scale", () => {
  const o = read("src/components/app/Overlay.jsx");
  assert.match(o, /createPortal\(/);
  assert.match(o, /role="dialog"/);
  assert.match(o, /aria-modal="true"/);
  assert.match(o, /e\.key === "Escape"/);
  assert.match(o, /role="menu"/);
  for (const p of ["ClientAutoReplies", "ClientQuickReplies", "ClientTeam", "ClientTeamPerformance", "ClientSettings", "LocationsSection"]) {
    assert.doesNotMatch(read(`src/pages/client/${p}.jsx`), /rounded-3xl|font-black|text-3xl|tracking-\[0\.25em\]/, p);
  }
});

test("new strings: EN/AR parity", () => {
  const en = JSON.parse(read("src/locales/en/translation.json"));
  const ar = JSON.parse(read("src/locales/ar/translation.json"));
  assert.deepEqual(Object.keys(en.replies).sort(), Object.keys(ar.replies).sort());
});
