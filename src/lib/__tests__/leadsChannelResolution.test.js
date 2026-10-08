import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterLeads,
  hasMultipleWhatsappAccounts,
  inboxConversationHref,
  isConversationUuid,
  leadsToCsv,
  resolveLeadChannel,
} from "../../pages/client/leads/leadsUi.js";
import { fetchLeadConversations } from "../../pages/client/leads/leadConversations.js";

// Leads channel resolution + Open Conversation deep link.
// See engineering/reports/claude/2026-10-08-leads-channel-resolution-open-conversation.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const code = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const t = (k) => k;

const WA1 = "00000000-0000-4000-8000-000000000001";
const WA2 = "00000000-0000-4000-8000-000000000002";
const FB = "00000000-0000-4000-8000-000000000003";
const LEGACY = "11111111-1111-4111-8111-111111111111";
const NONE = "22222222-2222-4222-8222-222222222222";
const V2 = new Map([
  [WA1, { platform: "whatsapp", channel_key: "wa-1", whatsapp_instance: { display_name: "Main line", phone: "+1" } }],
  [WA2, { platform: "whatsapp", channel_key: "wa-2", whatsapp_instance: { display_name: null, phone: "+2" } }],
  [FB, { platform: "facebook", channel_key: null, whatsapp_instance: null }],
]);
// Legacy map conflicts for WA1 and has a row for the shared sender elsewhere.
const LEGACY_MAP = { [WA1]: "facebook", [LEGACY]: "telegram", "44444444-4444-4444-8444-444444444444": "whatsapp" };
const lead = (conversation_id, extra = {}) => ({ id: conversation_id, conversation_id, sender_id: "970590000777", ...extra });

test("known channel from the V2 conversation, with WhatsApp account identity", () => {
  const r = resolveLeadChannel(lead(WA1), V2, LEGACY_MAP);
  assert.deepEqual(r, { platform: "whatsapp", key: "whatsapp", source: "conversation", channelKey: "wa-1", account: "Main line", inInbox: true });
});

test("V2 conversation takes precedence over a conflicting legacy row", () => {
  assert.equal(resolveLeadChannel(lead(WA1), V2, LEGACY_MAP).key, "whatsapp");
});

test("same sender on multiple channels / accounts resolves per conversation", () => {
  const a = resolveLeadChannel(lead(WA1), V2, LEGACY_MAP);
  const b = resolveLeadChannel(lead(WA2), V2, LEGACY_MAP);
  const c = resolveLeadChannel(lead(FB), V2, LEGACY_MAP);
  assert.equal(a.channelKey, "wa-1");
  assert.equal(b.channelKey, "wa-2");
  assert.equal(b.account, "+2"); // falls back to the account phone
  assert.equal(c.key, "facebook");
  assert.equal(c.account, null);
  assert.equal(hasMultipleWhatsappAccounts([a, b, c]), true);
  assert.equal(hasMultipleWhatsappAccounts([a, c]), false);
});

test("historical lead: legacy exact match only; otherwise honest unknown (no sender inference)", () => {
  const legacy = resolveLeadChannel(lead(LEGACY), V2, LEGACY_MAP);
  assert.equal(legacy.key, "telegram");
  assert.equal(legacy.source, "legacy");
  assert.equal(legacy.inInbox, false);
  const unknown = resolveLeadChannel(lead(NONE), V2, LEGACY_MAP);
  assert.deepEqual(unknown, { platform: null, key: "unknown", source: null, channelKey: null, account: null, inInbox: false });
  assert.equal(resolveLeadChannel({ id: "x", conversation_id: null }, V2, LEGACY_MAP).key, "unknown");
  // without Inbox permission (no V2 data) the legacy source is used as before
  assert.equal(resolveLeadChannel(lead(WA1), new Map(), LEGACY_MAP).source, "legacy");
});

test("resolved channel feeds the channel filter and CSV export", () => {
  const leads = [lead(WA1), lead(FB), lead(NONE)];
  const res = new Map(leads.map((l) => [l.id, resolveLeadChannel(l, V2, LEGACY_MAP)]));
  const channelOf = (l) => res.get(l.id).platform || undefined;
  assert.deepEqual(filterLeads(leads, { channel: "unknown", channelOf, t }).map((l) => l.id), [NONE]);
  assert.match(leadsToCsv([leads[1]], { channelOf, t, headers: ["a"] }), /"Messenger"/);
});

test("deep link href + uuid guard", () => {
  assert.equal(inboxConversationHref(WA1), `/client/messages?conversation=${WA1}`);
  assert.equal(isConversationUuid(WA1), true);
  assert.equal(isConversationUuid("c1"), false);
  assert.equal(isConversationUuid("x' or 1=1"), false);
});

test("fetchLeadConversations pages the existing list endpoint (GET only, leads_only, cursor)", async () => {
  const calls = [];
  const pages = [
    { success: true, has_more: true, conversations: [{ conversation_id: WA1, platform: "whatsapp", channel_key: "wa-1", last_message_at: "2026-10-08T10:00:00Z" }] },
    { success: true, has_more: false, conversations: [{ conversation_id: FB, platform: "facebook", last_message_at: "2026-10-07T10:00:00Z" }] },
  ];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => pages[calls.length - 1] };
  };
  const out = await fetchLeadConversations("u-1", fakeFetch);
  assert.equal(out.status, "ok");
  assert.deepEqual([...out.byId.keys()], [WA1, FB]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.init === undefined)); // plain GET, no body
  const q1 = new URL(calls[0].url, "http://x").searchParams;
  assert.equal(q1.get("resource"), "list");
  assert.equal(q1.get("leads_only"), "1");
  assert.equal(q1.get("limit"), "200");
  const q2 = new URL(calls[1].url, "http://x").searchParams;
  assert.equal(q2.get("before_id"), WA1);
  assert.equal(q2.get("before_last_message_at"), "2026-10-08T10:00:00Z");
});

test("fetchLeadConversations: forbidden / error degrade safely", async () => {
  const forbidden = await fetchLeadConversations("u-1", async () => ({ ok: false, status: 403, json: async () => ({ success: false }) }));
  assert.equal(forbidden.status, "forbidden");
  assert.equal(forbidden.byId.size, 0);
  const err = await fetchLeadConversations("u-1", async () => {
    throw new Error("network");
  });
  assert.equal(err.status, "error");
  assert.equal((await fetchLeadConversations(null)).status, "skipped");
});

test("Inbox deep link: read-only resolution, no auto-select substitution, filters end it", () => {
  const CM = code(read("src/pages/client/ClientMessages.jsx"));
  const effect = CM.slice(CM.indexOf("const id = requestedConversationId.trim();"), CM.indexOf("[clientId, user?.id, requestedConversationId]"));
  assert.ok(CM.indexOf("const id = requestedConversationId.trim();") > 0 && effect.length > 100 && effect.length < 3000);
  assert.match(effect, /resource: "list", actor_user_id: user\.id, limit: "5", search: id/);
  assert.match(effect, /\.find\(\(c\) => c\.conversation_id === id\)/);
  assert.doesNotMatch(effect, /method: "POST"|applyStatusChange|claimConversation|action:/);
  assert.match(CM, /deepLinkBlocksAutoSelectRef\.current \? null : filteredConversations\[0\]\.conversation_id/);
  assert.match(CM, /deepLinkBlocksAutoSelectRef\.current \? null : rows\[0\]\?\.conversation_id/);
  assert.match(CM, /if \(!UUID_RE\.test\(id\)\)/);
  assert.match(CM, /conversationsCursorRef\.current = serverPagesCursor\(merged\)/);
  // polling cadence unchanged
  assert.match(CM, /setInterval\(pollMessages, 5000\)/);
  assert.match(CM, /setInterval\(pollList, 12000\)/);
});
