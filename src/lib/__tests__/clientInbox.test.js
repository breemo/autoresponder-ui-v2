import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { channelLabel, channelValue, dayKey, dayLabel, senderKind, statusMeta } from "../../pages/client/inbox/inboxUi.js";

// Client Portal Phase 3: Inbox redesign. Presentation moved into
// src/pages/client/inbox; ClientMessages.jsx keeps all logic. These guards
// pin the business rules and integrations that must survive the redesign.
// See engineering/reports/claude/2026-10-08-client-inbox-redesign.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const code = (src) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const t = (k, o) => (o ? `${k}:${JSON.stringify(o)}` : k);

const CM = code(read("src/pages/client/ClientMessages.jsx"));
const DIR = "src/pages/client/inbox";
const INBOX = fs.readdirSync(path.join(ROOT, DIR)).map((f) => ({ f, src: read(`${DIR}/${f}`) }));
const HEADER = code(read(`${DIR}/InboxConversationHeader.jsx`));
const COMPOSER = code(read(`${DIR}/InboxComposer.jsx`));

test("senderKind differentiates customer / AI Agent / employee / automation", () => {
  assert.equal(senderKind({ direction: "inbound" }), "customer");
  assert.equal(senderKind({ direction: "in" }), "customer");
  assert.equal(senderKind({ direction: "outbound", reply_source: "ai" }), "ai");
  assert.equal(senderKind({ direction: "outbound", reply_source: "human" }), "employee");
  assert.equal(senderKind({ direction: "outbound", sent_by_user_id: "u1" }), "employee");
  assert.equal(senderKind({ direction: "outbound", _pending: true }), "employee");
  assert.equal(senderKind({ direction: "outbound", reply_source: "auto" }), "auto");
  assert.equal(senderKind({ direction: "outbound", reply_source: "quick_reply" }), "quick");
  assert.equal(senderKind({ direction: "outbound", reply_source: "system" }), "system");
  assert.equal(senderKind({ direction: "outbound" }), "outbound");
});

test("status / channel helpers map the existing values", () => {
  assert.deepEqual(statusMeta("waiting_human", t), { label: "common.waitingHuman", tone: "amber" });
  assert.equal(statusMeta("closed", t).tone, "slate");
  assert.equal(statusMeta(undefined, t).label, "messagesPage.statusActive");
  assert.equal(channelValue({ channel: "WhatsApp", platform: "x" }), "whatsapp");
  assert.equal(channelValue({ platform: "Telegram" }), "telegram");
  assert.equal(channelLabel("facebook", t), "Messenger");
  assert.equal(channelLabel("", t), "messagesPage.unknownChannel");
});

test("day separators: Today / Yesterday labels, stable day keys", () => {
  const now = new Date();
  const y = new Date(now.getTime() - 86400000);
  assert.ok(dayLabel(now.toISOString(), t, "en").startsWith("inbox.today, "));
  assert.ok(dayLabel(y.toISOString(), t, "en").startsWith("inbox.yesterday, "));
  assert.equal(dayKey("not a date"), "");
  assert.notEqual(dayKey(now), dayKey(y));
});

test("ClientMessages keeps polling cadence, pagination and visibility pause", () => {
  assert.match(CM, /setInterval\(pollMessages, 5000\)/);
  assert.match(CM, /setInterval\(pollList, 12000\)/);
  assert.match(CM, /if \(document\.hidden\) return;/);
  assert.match(CM, /const PAGE_SIZE = 30;/);
  assert.match(CM, /const CONVERSATIONS_PAGE_SIZE = 30;/);
  assert.match(CM, /setTimeout\(\(\) => setDebouncedSearch\(search\), 300\)/);
  assert.match(CM, /now - new Date\(p\.created_at\)\.getTime\(\) < 45000/);
});

test("ClientMessages keeps ownership / lifecycle rules verbatim", () => {
  assert.match(CM, /const canSendHumanReply = isWaitingHuman && isOwnedByMe;/);
  assert.match(CM, /const canControlConversation = !isClosedConversation && \(!isWaitingHuman \|\| isOwnedByMe\);/);
  assert.match(CM, /const REOPEN_WINDOW_MS = 2 \* 60 \* 60 \* 1000;/);
  for (const action of ["close", "reopen", "takeover"]) assert.match(CM, new RegExp(`applyStatusChange\\("${action}"`));
  assert.match(CM, /action: "claim"/);
  assert.match(CM, /action: "human_reply"/);
  assert.match(CM, /action: "sign_upload"/);
  assert.match(CM, /uploadToSignedUrl/);
  assert.match(CM, /if \(e\.key === "Enter" && !e\.shiftKey\)/);
  assert.match(CM, /canSendMediaTypeOnChannel\(selectedChannelValue, c\.type\)/);
});

test("header action visibility matches the previous Inbox conditions", () => {
  assert.match(HEADER, /\{isWaiting && !conv\.assigned_user_id && \(/);
  assert.match(HEADER, /\{isWaiting && conv\.assigned_user_id && \(/);
  assert.match(HEADER, /\{!isWaiting && !isClosed && \(/);
  assert.match(HEADER, /\{!isClosed && canControlConversation && \(/);
  assert.match(HEADER, /\{isClosed && !reopenWindowExpired && \(/);
  assert.match(HEADER, /\{isClosed && reopenWindowExpired && \(/);
});

test("composer: same disabled rules; internal note uses add_note via shared card state", () => {
  assert.match(COMPOSER, /disabled=\{sending \|\| !canSendHumanReply\}/);
  assert.match(COMPOSER, /disabled=\{sending \|\| \(!draft\.trim\(\) && !attachment\) \|\| !canSendHumanReply\}/);
  assert.match(COMPOSER, /disabled=\{!canSendMedia \|\| sending \|\| !canSendHumanReply\}/);
  assert.match(CM, /onAddNote=\{cardData\.handleAddNote\}/);
  assert.match(read(`${DIR}/useConversationCard.js`), /action: "add_note"/);
});

test("no fake controls: no AI Assist / emoji / quick-reply / tags in the Inbox UI", () => {
  for (const { f, src } of INBOX) {
    const c = code(src);
    assert.doesNotMatch(c, /AI Assist|emoji|Quick Replies|FaceSmile|Tags\b/i, f);
  }
});

test("terminology: 'AI Agent', never 'AI Assistant' (EN + AR inbox keys present)", () => {
  const en = JSON.parse(read("src/locales/en/translation.json"));
  const ar = JSON.parse(read("src/locales/ar/translation.json"));
  assert.equal(en.inbox.senderAi, "AI Agent");
  assert.ok(ar.inbox.senderAi);
  assert.deepEqual(Object.keys(en.inbox).sort(), Object.keys(ar.inbox).sort());
  for (const { f, src } of INBOX) assert.doesNotMatch(src, /AI Assistant/, f);
  assert.doesNotMatch(JSON.stringify(en.inbox), /Assistant/);
});

test("Conversation Card: one shared data source; collapsible column persisted", () => {
  assert.equal((CM.match(/useConversationCard\(/g) || []).length, 1);
  assert.match(CM, /const DETAILS_STORAGE_KEY = "ar\.inbox\.details";/);
  assert.match(CM, /detailsOpen \? "xl:grid-cols-\[320px_minmax\(0,1fr\)_320px\]" : "xl:grid-cols-\[320px_minmax\(0,1fr\)\]"/);
  assert.match(CM, /variant="drawer"/);
  assert.match(CM, /variant="panel"/);
});
