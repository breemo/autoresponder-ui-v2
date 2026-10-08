import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelOptions,
  csvCell,
  filterLeads,
  leadChannelKey,
  leadChannelLabel,
  leadStats,
  leadsToCsv,
  shortId,
} from "../../pages/client/leads/leadsUi.js";

// Client Portal Phase 4: Leads redesign. Filters/export run on the leads
// already loaded for the client; KPI formulas are unchanged.
// See engineering/reports/claude/2026-10-08-client-leads-redesign.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const t = (k, o) => (o ? `${k}:${JSON.stringify(o)}` : k);
const DAY = 86400000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const LEADS = [
  { id: 1, name: "Ahmad", phone: "+970 59-000-0001", sender_id: "s1", conversation_id: "c-wa", created_at: ago(60000) },
  { id: 2, name: "Sara", phone: "0590000002", sender_id: "fb-2", conversation_id: "c-fb", created_at: ago(3 * DAY) },
  { id: 3, name: null, phone: "0590000001", sender_id: "web-3", conversation_id: "c-web", created_at: ago(20 * DAY) },
  { id: 4, name: "Old", phone: "", sender_id: "x", conversation_id: "c-none", created_at: ago(60 * DAY) },
];
const MAP = { "c-wa": "whatsapp", "c-fb": "facebook", "c-web": "website_chat" };
const channelOf = (l) => MAP[l.conversation_id];
const ids = (rows) => rows.map((r) => r.id);

test("KPI formulas unchanged: total, unique normalized phones, today, last 7 days", () => {
  // phones 1 and 3 normalize differently (+970590000001 vs 0590000001) — exact normalization kept
  assert.deepEqual(leadStats(LEADS), { total: 4, unique: 3, today: 1, week: 2 });
});

test("channel keys / readable labels / unknown fallback", () => {
  assert.equal(leadChannelKey("whatsapp_evolution"), "whatsapp");
  assert.equal(leadChannelKey("website_chat"), "website");
  assert.equal(leadChannelKey(undefined), "unknown");
  assert.equal(leadChannelLabel("website", t), "Website Chat");
  assert.equal(leadChannelLabel("unknown", t), "leads.unknownChannel");
  assert.deepEqual(channelOptions(LEADS, channelOf), ["whatsapp", "facebook", "website", "unknown"]);
});

test("search keeps name/phone/sender/conversation fields and adds channel name", () => {
  const f = (search) => ids(filterLeads(LEADS, { search, channelOf, t }));
  assert.deepEqual(f("sara"), [2]);
  assert.deepEqual(f("0590000001"), [3]);
  assert.deepEqual(f("web-3"), [3]);
  assert.deepEqual(f("c-none"), [4]);
  assert.deepEqual(f("website chat"), [3]);
  assert.deepEqual(f(""), [1, 2, 3, 4]);
});

test("channel + time filters combine with search", () => {
  assert.deepEqual(ids(filterLeads(LEADS, { channel: "unknown", channelOf, t })), [4]);
  assert.deepEqual(ids(filterLeads(LEADS, { time: "today", channelOf, t })), [1]);
  assert.deepEqual(ids(filterLeads(LEADS, { time: "7d", channelOf, t })), [1, 2]);
  assert.deepEqual(ids(filterLeads(LEADS, { time: "30d", channelOf, t })), [1, 2, 3]);
  assert.deepEqual(ids(filterLeads(LEADS, { time: "30d", channel: "facebook", search: "sar", channelOf, t })), [2]);
});

test("shortId truncates visually only", () => {
  const id = "a7910dc7-eb07-4fd4-bd8d-123456789abc";
  assert.equal(shortId(id), "a7910dc7…9abc");
  assert.equal(shortId("short"), "short");
});

test("CSV export: exact phones, formula-injection safe, BOM + header", () => {
  assert.equal(csvCell("+970 59-000-0001"), '"+970 59-000-0001"');
  assert.equal(csvCell("=HYPERLINK(1)"), `"'=HYPERLINK(1)"`);
  assert.equal(csvCell("@x"), `"'@x"`);
  assert.equal(csvCell("-1+2 cmd"), `"'-1+2 cmd"`);
  assert.equal(csvCell('a "q"'), '"a ""q"""');
  const csv = leadsToCsv(LEADS.slice(0, 1), { channelOf, t, headers: ["A", "B", "C", "D", "E", "F"] });
  assert.ok(csv.startsWith("﻿\"A\""));
  assert.match(csv, /"Ahmad","WhatsApp","\+970 59-000-0001","s1","c-wa"/);
});

test("Leads page: same data sources, no Open/ellipsis fake controls, AI Agent terminology", () => {
  const src = read("src/pages/client/ClientLeads.jsx");
  assert.match(src, /\.from\("leads"\)/);
  assert.match(src, /\.from\("conversation_state"\)/);
  assert.match(src, /const PAGE_SIZE = 10;/);
  assert.match(src, /channelOf\(lead\) === "whatsapp" \? `https:\/\/wa\.me\//);
  assert.doesNotMatch(src, /EllipsisHorizontal|EllipsisVertical|AI Assistant|\/client\/messages\?/);
  const en = JSON.parse(read("src/locales/en/translation.json")).leads;
  const ar = JSON.parse(read("src/locales/ar/translation.json")).leads;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort());
});
