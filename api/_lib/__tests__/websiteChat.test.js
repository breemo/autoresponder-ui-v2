import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createMockSupabase } from "./mockSupabase.js";
import { WEBSITE_CHAT_LIMITS as L } from "../websiteChatLimits.js";
import {
  generatePublicKey,
  generateChannelKey,
  generateVisitorToken,
  hashToken,
  isPublicKeyFormat,
  hashIp,
  bearerTokenFromRequest,
} from "../websiteChatKeys.js";
import { normalizeDomainEntry, normalizeAllowedDomains, hostFromOrigin, isHostAllowed } from "../websiteChatDomains.js";
import {
  bootstrap,
  startSession,
  authenticateVisitor,
  pollMessages,
  submitMessage,
  normalizeVisitorText,
  TEAM_LABEL,
} from "../websiteChatService.js";
import { handleWidgetRequest, ownOriginMismatch } from "../../widget.js";
import { handleWebsiteChatSettings, toSafeSite, isWebsiteChatFeatureId } from "../websiteChatAccounts.js";
import {
  resolveWebsiteChatReplyTarget,
  buildWebsiteChatHumanReplyRow,
  persistWebsiteChatHumanReply,
} from "../websiteChatHumanReply.js";
import { resolveIntegrationsResource } from "../../client-integrations.js";

// ===================================================================
// In-memory repository — same method contract as websiteChatRepo.js.
// hitVisitor mirrors the SQL RPC website_chat_visitor_hit semantics.
// ===================================================================

const FEATURE_ID = "feat-website-chat";
const OTHER_FEATURE_ID = "feat-telegram";

function makeRepo(seed = {}) {
  const db = {
    integrations: seed.integrations || [],
    visitors: seed.visitors || [],
    identities: seed.identities || [],
    conversations: seed.conversations || [],
    messages: seed.messages || [],
    activeClients: new Set(seed.activeClients || ["client-A", "client-B"]),
    clientInboundLastHour: seed.clientInboundLastHour || {},
  };
  let seq = 0;
  const clock = seed.clock || { now: new Date("2026-09-30T10:00:00Z") };
  const repo = {
    db,
    clock,
    async getWebsiteChatFeatureId() {
      return seed.noFeature ? null : FEATURE_ID;
    },
    async findIntegrationByPublicKey(k) {
      const rows = db.integrations.filter((i) => i.config?.publicKey === k);
      return rows.length === 1 ? rows[0] : null;
    },
    async findIntegrationById(id) {
      return db.integrations.find((i) => i.id === id) || null;
    },
    async listSiteIntegrations(clientId, featureId) {
      return db.integrations.filter((i) => i.client_id === clientId && i.feature_id === featureId);
    },
    async findOwnedIntegration(clientId, featureId, id) {
      return db.integrations.find((i) => i.id === id && i.client_id === clientId && i.feature_id === featureId) || null;
    },
    async createIntegration({ clientId, featureId, config, isActive }) {
      const count = db.integrations.filter((i) => i.client_id === clientId && i.feature_id === featureId).length;
      if (seed.planLimit != null && count >= seed.planLimit) return { outcome: "limit_reached", plan_limit: seed.planLimit };
      const row = { id: `int-${++seq}`, client_id: clientId, feature_id: featureId, is_active: isActive, config, created_at: clock.now.toISOString() };
      db.integrations.push(row);
      return { outcome: "created", plan_limit: seed.planLimit ?? null, integration: row };
    },
    async updateIntegration(id, clientId, featureId, patch) {
      const row = db.integrations.find((i) => i.id === id && i.client_id === clientId && i.feature_id === featureId);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    async deleteIntegration(id, clientId, featureId) {
      const idx = db.integrations.findIndex((i) => i.id === id && i.client_id === clientId && i.feature_id === featureId);
      if (idx < 0) return null;
      db.integrations.splice(idx, 1);
      db.visitors = db.visitors.filter((v) => v.integration_id !== id); // FK cascade
      return id;
    },
    async isClientSubscriptionActive(clientId) {
      return db.activeClients.has(clientId);
    },
    async findVisitorByTokenHash(h) {
      return db.visitors.find((v) => v.token_hash === h) || null;
    },
    async countRecentSessions(integrationId, ipHash, sinceIso) {
      return db.visitors.filter((v) => v.integration_id === integrationId && v.created_ip_hash === ipHash && v.created_at >= sinceIso).length;
    },
    async insertVisitor(row) {
      const v = {
        id: `vis-${++seq}`,
        revoked_at: null,
        created_at: clock.now.toISOString(),
        poll_window_started_at: null,
        poll_window_count: 0,
        send_window_started_at: null,
        send_window_count: 0,
        send_day_started_at: null,
        send_day_count: 0,
        last_client_message_id: null,
        ...row,
      };
      db.visitors.push(v);
      return v;
    },
    async updateVisitor(id, integrationId, patch) {
      const v = db.visitors.find((x) => x.id === id && x.integration_id === integrationId);
      if (!v) return null;
      Object.assign(v, patch);
      return v;
    },
    async hitVisitor(visitorId, kind, { minuteMax, dayMax = null, clientMessageId = null }) {
      const v = db.visitors.find((x) => x.id === visitorId);
      if (!v) return "not_found";
      const t = clock.now.getTime();
      const expired = (start, sec) => !start || t - new Date(start).getTime() >= sec * 1000;
      if (kind === "poll") {
        if (expired(v.poll_window_started_at, 60)) { v.poll_window_started_at = clock.now.toISOString(); v.poll_window_count = 0; }
        if (v.poll_window_count >= minuteMax) return "rate_limited";
        v.poll_window_count += 1;
        return "ok";
      }
      if (clientMessageId && v.last_client_message_id === clientMessageId) return "duplicate";
      if (expired(v.send_window_started_at, 60)) { v.send_window_started_at = clock.now.toISOString(); v.send_window_count = 0; }
      if (expired(v.send_day_started_at, 86400)) { v.send_day_started_at = clock.now.toISOString(); v.send_day_count = 0; }
      if (v.send_window_count >= minuteMax || (dayMax != null && v.send_day_count >= dayMax)) return "rate_limited";
      v.send_window_count += 1;
      v.send_day_count += 1;
      if (clientMessageId) v.last_client_message_id = clientMessageId;
      return "ok";
    },
    async clearClientMessageId(visitorId, cmid) {
      const v = db.visitors.find((x) => x.id === visitorId);
      if (v && v.last_client_message_id === cmid) v.last_client_message_id = null;
    },
    async countClientInboundSince(clientId) {
      return db.clientInboundLastHour[clientId] || 0;
    },
    async findChannelIdentity({ clientId, senderId, channelKey }) {
      return db.identities.find((i) => i.client_id === clientId && i.platform === "website_chat" && i.sender_id === senderId && i.channel_key === channelKey) || null;
    },
    async listConversations(clientId, identityId) {
      return db.conversations
        .filter((c) => c.client_id === clientId && c.channel_identity_id === identityId)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    },
    async listMessages({ clientId, conversationIds, afterFilter, limit }) {
      let rows = db.messages.filter((m) => m.client_id === clientId && conversationIds.includes(m.conversation_id));
      if (afterFilter) {
        const [, ca, id] = afterFilter.match(/created_at\.gt\."([^"]+)".*id\.gt\."([^"]+)"/);
        rows = rows.filter((m) => m.created_at > ca || (m.created_at === ca && m.id > id)).sort((a, b) => (a.created_at + a.id < b.created_at + b.id ? -1 : 1));
      } else {
        rows = rows.sort((a, b) => (a.created_at + a.id < b.created_at + b.id ? 1 : -1));
      }
      return rows.slice(0, limit);
    },
  };
  return repo;
}

function site({ id, clientId = "client-A", domains = ["example.com"], active = true, keyVersion = 1, feature = FEATURE_ID, name = "Main site" }) {
  return {
    id,
    client_id: clientId,
    feature_id: feature,
    is_active: active,
    created_at: "2026-09-01T00:00:00Z",
    config: {
      channelKey: generateChannelKey(),
      publicKey: generatePublicKey(),
      keyVersion,
      displayName: name,
      allowedDomains: domains,
      reply_mode: "ai",
    },
  };
}

const deps = (repo, extra = {}) => ({ repo, now: () => repo.clock.now, ...extra });
const ORIGIN = "https://example.com";

async function newSession(repo, integration, { origin = ORIGIN, bearerToken, ipHash = "ip-1" } = {}) {
  return startSession(deps(repo), { publicKey: integration.config.publicKey, parentOrigin: origin, bearerToken, ipHash });
}

const noSecrets = (body, integration) => {
  const s = JSON.stringify(body);
  assert.ok(!s.includes(integration.config.channelKey), "channelKey leaked");
  assert.ok(!s.includes(integration.client_id), "client_id leaked");
  assert.ok(!s.includes(integration.id), "integration id leaked");
};

// ===================================================================
// 1. Keys & tokens
// ===================================================================

test("public widget key: random, well-formed, unique; channelKey separate", () => {
  const keys = new Set(Array.from({ length: 200 }, generatePublicKey));
  assert.equal(keys.size, 200);
  for (const k of keys) assert.ok(isPublicKeyFormat(k), k);
  assert.ok(!isPublicKeyFormat(generateChannelKey()));
  assert.ok(!isPublicKeyFormat("wcpk_short"));
});

test("visitor token: only the SHA-256 hash is stored", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const out = await newSession(repo, s);
  assert.equal(out.status, 200);
  const v = repo.db.visitors[0];
  assert.equal(v.token_hash, hashToken(out.body.token));
  assert.match(v.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(v).includes(out.body.token), "raw token persisted");
  assert.notEqual(hashToken(generateVisitorToken()), hashToken(generateVisitorToken()));
});

test("ip hash is keyed and never the raw ip", () => {
  const h = hashIp("1.2.3.4", "secret");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, hashIp("1.2.3.4", "other"));
  assert.equal(hashIp(null, "secret"), null);
  assert.equal(hashIp("1.2.3.4", ""), null);
  assert.equal(bearerTokenFromRequest({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(bearerTokenFromRequest({ headers: {} }), null);
});

// ===================================================================
// 2. Allowed domains
// ===================================================================

test("domain normalization: lowercase host, scheme/path/port stripped, explicit wildcard/localhost only", () => {
  assert.equal(normalizeDomainEntry("https://WWW.Example.com:8443/path?q=1"), "www.example.com");
  assert.equal(normalizeDomainEntry("example.com."), "example.com");
  assert.equal(normalizeDomainEntry("*.Example.com"), "*.example.com");
  assert.equal(normalizeDomainEntry("http://localhost:5173"), "localhost");
  assert.equal(normalizeDomainEntry("127.0.0.1:3000"), "127.0.0.1");
  for (const bad of ["", "   ", "10.0.0.1", "*.localhost", "exa mple.com", "user@example.com", "*", "*.*.com", "a.*.com", "-bad.com", "com", 42, null]) {
    assert.equal(normalizeDomainEntry(bad), null, String(bad));
  }
  assert.deepEqual(normalizeAllowedDomains(["Example.com", "example.com", "*.shop.io"]), { ok: true, domains: ["example.com", "*.shop.io"], invalid: [] });
  assert.equal(normalizeAllowedDomains(["ok.com", "bad domain"]).ok, false);
  assert.equal(normalizeAllowedDomains(Array.from({ length: L.MAX_ALLOWED_DOMAINS + 1 }, (_, i) => `d${i}.com`)).reason, "too_many");
});

test("host matching: exact vs wildcard (no implicit subdomains, wildcard excludes apex)", () => {
  assert.equal(isHostAllowed("example.com", ["example.com"]), true);
  assert.equal(isHostAllowed("www.example.com", ["example.com"]), false);
  assert.equal(isHostAllowed("a.example.com", ["*.example.com"]), true);
  assert.equal(isHostAllowed("a.b.example.com", ["*.example.com"]), true);
  assert.equal(isHostAllowed("example.com", ["*.example.com"]), false);
  assert.equal(isHostAllowed("evilexample.com", ["*.example.com"]), false);
  assert.equal(isHostAllowed("example.com.evil.io", ["example.com"]), false);
  assert.equal(hostFromOrigin("https://Shop.Example.com:8443"), "shop.example.com");
  assert.equal(hostFromOrigin("javascript:alert(1)"), null);
  assert.equal(hostFromOrigin("not a url"), null);
});

// ===================================================================
// 3. Bootstrap
// ===================================================================

test("bootstrap: invalid / unknown / inactive / wrong-feature keys and disallowed domains are rejected", async () => {
  const repo = makeRepo();
  const ok = site({ id: "int-1" });
  const inactive = site({ id: "int-2", active: false });
  const telegram = site({ id: "int-3", feature: OTHER_FEATURE_ID });
  repo.db.integrations.push(ok, inactive, telegram);
  const call = (publicKey, parentOrigin = ORIGIN) => bootstrap(deps(repo), { publicKey, parentOrigin });

  assert.equal((await call("nope")).status, 404);
  assert.equal((await call(generatePublicKey())).status, 404);
  assert.equal((await call(inactive.config.publicKey)).body.code, "site_inactive");
  assert.equal((await call(telegram.config.publicKey)).status, 404);
  assert.equal((await call(ok.config.publicKey, "https://evil.com")).body.code, "domain_not_allowed");
  assert.equal((await call(ok.config.publicKey, null)).body.code, "domain_not_allowed"); // missing parent origin

  const good = await call(ok.config.publicKey);
  assert.equal(good.status, 200);
  assert.deepEqual(Object.keys(good.body).sort(), ["limits", "ok", "site"]);
  assert.equal(good.body.site.title, "Main site");
  noSecrets(good.body, ok);
  assert.ok(!JSON.stringify(good.body).includes("example.com"), "allowed domains leaked");
});

// ===================================================================
// 4. Session create / resume / isolation
// ===================================================================

test("session: create then resume keeps the visitor, rotates the token, leaks nothing internal", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const first = await newSession(repo, s);
  assert.equal(first.status, 200);
  assert.equal(first.body.resumed, false);
  noSecrets(first.body, s);
  const visitorId = repo.db.visitors[0].id;

  const second = await newSession(repo, s, { bearerToken: first.body.token });
  assert.equal(second.body.resumed, true);
  assert.equal(repo.db.visitors.length, 1);
  assert.equal(repo.db.visitors[0].id, visitorId);
  assert.notEqual(second.body.token, first.body.token);
  assert.equal((await authenticateVisitor(deps(repo), first.body.token)).error.body.code, "invalid_token"); // old token dead
  assert.ok((await authenticateVisitor(deps(repo), second.body.token)).visitor);
});

test("session: a token from another website of the same client is NOT resumed (multi-site isolation)", async () => {
  const repo = makeRepo();
  const a = site({ id: "int-A1" });
  const b = site({ id: "int-A2", domains: ["other.com"] });
  repo.db.integrations.push(a, b);
  const onA = await newSession(repo, a);
  const onB = await newSession(repo, b, { origin: "https://other.com", bearerToken: onA.body.token });
  assert.equal(onB.body.resumed, false);
  assert.equal(repo.db.visitors.length, 2);
  assert.notEqual(repo.db.visitors[0].id, repo.db.visitors[1].id);
  assert.equal(repo.db.visitors[1].integration_id, "int-A2");
});

test("session: expired or revoked tokens start a new visitor; inactive subscription is refused", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const first = await newSession(repo, s);
  repo.db.visitors[0].token_expires_at = "2026-09-01T00:00:00Z";
  assert.equal((await newSession(repo, s, { bearerToken: first.body.token })).body.resumed, false);
  const second = await newSession(repo, s);
  repo.db.visitors[repo.db.visitors.length - 1].revoked_at = "2026-09-30T09:00:00Z";
  assert.equal((await newSession(repo, s, { bearerToken: second.body.token })).body.resumed, false);

  repo.db.activeClients.delete("client-A");
  assert.equal((await newSession(repo, s)).status, 402);
});

test(`session rate limit: ${L.SESSIONS_PER_IP_PER_SITE} new sessions / ${L.SESSION_WINDOW_SECONDS / 60} min / IP / website`, async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  const other = site({ id: "int-2" });
  repo.db.integrations.push(s, other);
  for (let i = 0; i < L.SESSIONS_PER_IP_PER_SITE; i++) assert.equal((await newSession(repo, s)).status, 200);
  assert.equal((await newSession(repo, s)).status, 429);
  assert.equal((await newSession(repo, s, { ipHash: "ip-2" })).status, 200); // other IP
  assert.equal((await newSession(repo, other)).status, 200); // other website
  repo.clock.now = new Date(repo.clock.now.getTime() + L.SESSION_WINDOW_SECONDS * 1000 + 1000);
  assert.equal((await newSession(repo, s)).status, 200); // window passed
});

// ===================================================================
// 5. Token validation
// ===================================================================

test("token validation: wrong/expired/revoked tokens, inactive site, rotated key, removed domain, client mismatch", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const { body } = await newSession(repo, s);
  const v = repo.db.visitors[0];
  const auth = () => authenticateVisitor(deps(repo), body.token);

  assert.equal((await authenticateVisitor(deps(repo), generateVisitorToken())).error.body.code, "invalid_token");
  assert.equal((await authenticateVisitor(deps(repo), "garbage")).error.body.code, "invalid_token");
  assert.ok((await auth()).visitor);

  s.is_active = false;
  assert.equal((await auth()).error.body.code, "site_inactive");
  s.is_active = true;

  s.config.keyVersion = 2; // regenerate_key
  assert.equal((await auth()).error.body.code, "token_stale");
  s.config.keyVersion = 1;

  s.config.allowedDomains = ["another.com"];
  assert.equal((await auth()).error.body.code, "domain_not_allowed");
  s.config.allowedDomains = ["example.com"];

  v.client_id = "client-B"; // row tampered / mismatched tenant
  assert.equal((await auth()).error.body.code, "invalid_token");
  v.client_id = "client-A";

  v.revoked_at = "2026-09-30T09:00:00Z";
  assert.equal((await auth()).error.body.code, "invalid_token");
  v.revoked_at = null;

  repo.clock.now = new Date(repo.clock.now.getTime() + (L.TOKEN_TTL_DAYS + 1) * 86400000);
  assert.equal((await auth()).error.body.code, "token_expired");
});

test("key rotation: stale token + NEW public key resumes the same visitor", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const first = await newSession(repo, s);
  const visitorId = repo.db.visitors[0].id;
  const oldKey = s.config.publicKey;
  s.config.publicKey = generatePublicKey();
  s.config.keyVersion = 2;
  assert.equal((await startSession(deps(repo), { publicKey: oldKey, parentOrigin: ORIGIN, ipHash: "ip-1" })).status, 404); // old snippet dead
  const resumed = await newSession(repo, s, { bearerToken: first.body.token });
  assert.equal(resumed.body.resumed, true);
  assert.equal(repo.db.visitors[0].id, visitorId);
  assert.equal(repo.db.visitors[0].key_version, 2);
  assert.ok((await authenticateVisitor(deps(repo), resumed.body.token)).visitor);
});

// ===================================================================
// 6. Polling
// ===================================================================

function seedConversation(repo, s, visitorId) {
  repo.db.identities.push({ id: "ci-1", client_id: s.client_id, platform: "website_chat", sender_id: visitorId, channel_key: s.config.channelKey });
  repo.db.conversations.push({ id: "conv-1", client_id: s.client_id, channel_identity_id: "ci-1", conversation_status: "waiting_human", started_at: "2026-09-30T09:00:00Z" });
  repo.db.messages.push(
    { id: "m1", client_id: s.client_id, conversation_id: "conv-1", direction: "inbound", reply_source: null, message: "hello", created_at: "2026-09-30T09:00:01Z", sent_by_user_id: "u-x" },
    { id: "m2", client_id: s.client_id, conversation_id: "conv-1", direction: "outbound", reply_source: "ai", message: "hi!", created_at: "2026-09-30T09:00:02Z" },
    { id: "m3", client_id: s.client_id, conversation_id: "conv-1", direction: "outbound", reply_source: "human", message: "Team here", created_at: "2026-09-30T09:00:03Z", sent_by_user_id: "employee-1" }
  );
}

test("messages: own conversation only, roles mapped, employee shown as Team, no internal ids", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  const s2 = site({ id: "int-2" });
  repo.db.integrations.push(s, s2);
  const { body } = await newSession(repo, s);
  const visitorId = repo.db.visitors[0].id;
  seedConversation(repo, s, visitorId);
  // Same sender id on ANOTHER website of the same client must not leak in.
  repo.db.identities.push({ id: "ci-2", client_id: s.client_id, platform: "website_chat", sender_id: visitorId, channel_key: s2.config.channelKey });
  repo.db.conversations.push({ id: "conv-2", client_id: s.client_id, channel_identity_id: "ci-2", conversation_status: "active", started_at: "2026-09-30T09:30:00Z" });
  repo.db.messages.push({ id: "m9", client_id: s.client_id, conversation_id: "conv-2", direction: "inbound", message: "other site", created_at: "2026-09-30T09:30:01Z" });

  const out = await pollMessages(deps(repo), { bearerToken: body.token });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.messages.map((m) => [m.id, m.role, m.author, m.text]), [
    ["m1", "visitor", null, "hello"],
    ["m2", "bot", null, "hi!"],
    ["m3", "agent", TEAM_LABEL, "Team here"],
  ]);
  assert.equal(out.body.status, "waiting_human");
  const s1 = JSON.stringify(out.body);
  for (const secret of ["conv-1", "employee-1", "u-x", s.config.channelKey, s.client_id]) assert.ok(!s1.includes(secret), secret);

  const delta = await pollMessages(deps(repo), { bearerToken: body.token, after: { created_at: "2026-09-30T09:00:02Z", id: "m2" } });
  assert.deepEqual(delta.body.messages.map((m) => m.id), ["m3"]);
  assert.equal((await pollMessages(deps(repo), { bearerToken: body.token, after: { created_at: "x", id: "m2" } })).status, 400);
});

test(`poll rate limit: ${L.POLLS_PER_MINUTE_PER_VISITOR} / minute / visitor`, async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const { body } = await newSession(repo, s);
  for (let i = 0; i < L.POLLS_PER_MINUTE_PER_VISITOR; i++) assert.equal((await pollMessages(deps(repo), { bearerToken: body.token })).status, 200);
  assert.equal((await pollMessages(deps(repo), { bearerToken: body.token })).status, 429);
  repo.clock.now = new Date(repo.clock.now.getTime() + 61000);
  assert.equal((await pollMessages(deps(repo), { bearerToken: body.token })).status, 200);
});

// ===================================================================
// 7. Send (validation layer; hand-off pending)
// ===================================================================

let cmidSeq = 0;
const cmid = () => `cmid-${String(++cmidSeq).padStart(6, "0")}`;

test("send: message length 1-2000 after trim, control chars stripped, message id required", async () => {
  assert.equal(normalizeVisitorText("   "), null);
  assert.equal(normalizeVisitorText("a".repeat(L.MESSAGE_MAX_LENGTH)).length, L.MESSAGE_MAX_LENGTH);
  assert.equal(normalizeVisitorText("a".repeat(L.MESSAGE_MAX_LENGTH + 1)), null);
  assert.equal(normalizeVisitorText(" hi\u0000\u0007 there\n "), "hi there");
  assert.equal(normalizeVisitorText(42), null);

  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const { body } = await newSession(repo, s);
  const send = (text, id = cmid()) => submitMessage(deps(repo), { bearerToken: body.token, text, clientMessageId: id });
  assert.equal((await send("")).body.code, "invalid_text");
  assert.equal((await send("a".repeat(2001))).body.code, "invalid_text");
  assert.equal((await send("hi", "bad id!")).body.code, "invalid_client_message_id");
});

test("send: no delivery wired / missing configuration -> 503 not_configured, never a fake success; retry allowed", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const { body } = await newSession(repo, s);
  const id = cmid();
  const first = await submitMessage(deps(repo), { bearerToken: body.token, text: "hello", clientMessageId: id }); // default deliverer
  assert.equal(first.status, 503);
  assert.equal(first.body.code, "not_configured");
  assert.equal(first.body.ok, false);
  assert.equal(repo.db.visitors[0].last_client_message_id, null); // guard released
  const notConfigured = deps(repo, { deliverToOrchestrator: async () => ({ delivered: false, reason: "not_configured" }) });
  const retry = await submitMessage(notConfigured, { bearerToken: body.token, text: "hello", clientMessageId: id });
  assert.equal(retry.body.code, "not_configured"); // not "duplicate"
});

test("send: accepted -> 202 and duplicate guard KEPT; upstream failure -> 502 and guard RELEASED; never 2xx without acceptance", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const { body } = await newSession(repo, s);
  const v = () => repo.db.visitors[0];

  const ok = deps(repo, { deliverToOrchestrator: async () => ({ delivered: true }) });
  const idA = cmid();
  const accepted = await submitMessage(ok, { bearerToken: body.token, text: "a", clientMessageId: idA });
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, { ok: true, accepted: true });
  assert.equal(v().last_client_message_id, idA);
  const dup = await submitMessage(ok, { bearerToken: body.token, text: "a", clientMessageId: idA });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);

  for (const reason of ["http_500", "http_403", "timeout", "network_error"]) {
    const failing = deps(repo, { deliverToOrchestrator: async () => ({ delivered: false, reason }) });
    const idB = cmid();
    const out = await submitMessage(failing, { bearerToken: body.token, text: "b", clientMessageId: idB });
    assert.equal(out.status, 502, reason);
    assert.equal(out.body.code, "upstream_unavailable");
    assert.notEqual(v().last_client_message_id, idB, "guard released");
    repo.clock.now = new Date(repo.clock.now.getTime() + 61000);
  }

  // truthy-but-not-true / malformed results are NOT acceptance
  for (const weird of [{ delivered: "yes" }, {}, null, undefined]) {
    const odd = deps(repo, { deliverToOrchestrator: async () => weird });
    const out = await submitMessage(odd, { bearerToken: body.token, text: "c", clientMessageId: cmid() });
    assert.ok(out.status >= 500, JSON.stringify(weird));
    repo.clock.now = new Date(repo.clock.now.getTime() + 61000);
  }
});

test("send: with a (future) delivering orchestrator -> 202, duplicate retry detected, channelKey only server-side", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const { body } = await newSession(repo, s);
  const delivered = [];
  const d = deps(repo, { deliverToOrchestrator: async (p) => { delivered.push(p); return { delivered: true }; } });
  const id = cmid();
  const out = await submitMessage(d, { bearerToken: body.token, text: " hello ", clientMessageId: id });
  assert.equal(out.status, 202);
  assert.deepEqual(delivered[0], { channelKey: s.config.channelKey, visitorId: repo.db.visitors[0].id, text: "hello", clientMessageId: id });
  noSecrets(out.body, s);
  const dup = await submitMessage(d, { bearerToken: body.token, text: "hello", clientMessageId: id });
  assert.equal(dup.body.duplicate, true);
  assert.equal(delivered.length, 1);
  const failing = deps(repo, { deliverToOrchestrator: async () => ({ delivered: false, reason: "http_502" }) });
  assert.equal((await submitMessage(failing, { bearerToken: body.token, text: "x", clientMessageId: cmid() })).status, 502);
});

test(`send rate limits: ${L.MESSAGES_PER_MINUTE_PER_VISITOR}/min and ${L.MESSAGES_PER_DAY_PER_VISITOR}/day per visitor, ${L.MESSAGES_PER_HOUR_PER_CLIENT}/hour per client`, async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const { body } = await newSession(repo, s);
  const d = deps(repo, { deliverToOrchestrator: async () => ({ delivered: true }) });
  const send = () => submitMessage(d, { bearerToken: body.token, text: "hi", clientMessageId: cmid() });

  for (let i = 0; i < L.MESSAGES_PER_MINUTE_PER_VISITOR; i++) assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 429);

  let sent = L.MESSAGES_PER_MINUTE_PER_VISITOR;
  while (sent < L.MESSAGES_PER_DAY_PER_VISITOR) {
    repo.clock.now = new Date(repo.clock.now.getTime() + 61000);
    for (let i = 0; i < L.MESSAGES_PER_MINUTE_PER_VISITOR && sent < L.MESSAGES_PER_DAY_PER_VISITOR; i++, sent++) {
      assert.equal((await send()).status, 202);
    }
  }
  repo.clock.now = new Date(repo.clock.now.getTime() + 61000);
  assert.equal((await send()).status, 429); // daily cap

  const repo2 = makeRepo({ clientInboundLastHour: { "client-A": L.MESSAGES_PER_HOUR_PER_CLIENT } });
  const s2 = site({ id: "int-9" });
  repo2.db.integrations.push(s2);
  const sess = await newSession(repo2, s2);
  const capped = await submitMessage(deps(repo2, { deliverToOrchestrator: async () => ({ delivered: true }) }), { bearerToken: sess.body.token, text: "hi", clientMessageId: cmid() });
  assert.equal(capped.status, 429);
});

// ===================================================================
// 8. api/widget.js HTTP layer
// ===================================================================

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

test("widget.js: POST only, foreign Origin refused, unknown action 400, forged ids ignored", async () => {
  const repo = makeRepo();
  const s = site({ id: "int-1" });
  repo.db.integrations.push(s);
  const d = deps(repo, { ipHash: "ip-1" });

  let res = mockRes();
  await handleWidgetRequest({ method: "GET", headers: {} }, res, d);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers["Cache-Control"], "no-store");

  res = mockRes();
  await handleWidgetRequest({ method: "POST", headers: { host: "app.test", origin: "https://evil.com" }, body: { action: "bootstrap" } }, res, d);
  assert.equal(res.statusCode, 403);
  assert.equal(ownOriginMismatch({ headers: { host: "app.test", origin: "https://app.test" } }), false);
  assert.equal(ownOriginMismatch({ headers: { host: "app.test" } }), false);

  res = mockRes();
  await handleWidgetRequest({ method: "POST", headers: { host: "app.test" }, body: { action: "nope" } }, res, d);
  assert.equal(res.statusCode, 400);

  res = mockRes();
  await handleWidgetRequest({ method: "POST", headers: { host: "app.test" }, body: { action: "session", key: s.config.publicKey, parent_origin: ORIGIN } }, res, d);
  const token = res.body.token;
  seedConversation(repo, s, repo.db.visitors[0].id);
  repo.db.messages.push({ id: "mX", client_id: "client-B", conversation_id: "conv-B", direction: "inbound", message: "other tenant", created_at: "2026-09-30T09:10:00Z" });
  res = mockRes();
  await handleWidgetRequest(
    { method: "POST", headers: { host: "app.test", authorization: `Bearer ${token}` }, body: { action: "messages", client_id: "client-B", conversation_id: "conv-B", channel_key: "x" } },
    res,
    d
  );
  assert.equal(res.statusCode, 200);
  assert.ok(!JSON.stringify(res.body).includes("other tenant"));
  assert.equal(res.body.messages.length, 3);
});

// ===================================================================
// 9. Settings (client-integrations?resource=website_chat)
// ===================================================================

const owner = { user: { id: "u1", must_change_password: false }, membership: { client_id: "client-A", role: "owner", is_active: true } };
function settingsDeps(repo, actor = owner) {
  return { repo, resolveActor: async (id) => (id === "u1" ? actor : null) };
}
async function settings(repo, { method = "POST", body = {}, query = {}, actor } = {}) {
  const res = mockRes();
  await handleWebsiteChatSettings({ method, body: { actor_user_id: "u1", ...body }, query: { actor_user_id: "u1", ...query } }, res, settingsDeps(repo, actor));
  return res;
}

test("settings: create generates server-side keys; channelKey never returned; multi-site gives distinct keys", async () => {
  const repo = makeRepo();
  const a = await settings(repo, { body: { action: "create", display_name: "Shop", allowed_domains: ["https://Shop.com/"] } });
  const b = await settings(repo, { body: { action: "create", display_name: "Blog", allowed_domains: ["blog.io"], channelKey: "evil", config: { channelKey: "evil" } } });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const [ra, rb] = repo.db.integrations;
  assert.notEqual(ra.config.channelKey, rb.config.channelKey);
  assert.notEqual(ra.config.publicKey, rb.config.publicKey);
  assert.notEqual(rb.config.channelKey, "evil");
  assert.deepEqual(ra.config.allowedDomains, ["shop.com"]);
  for (const r of [a, b]) {
    assert.ok(!("channel_key" in r.body.site) && !JSON.stringify(r.body).includes(repo.db.integrations[0].config.channelKey));
    assert.ok(isPublicKeyFormat(r.body.site.public_key));
  }
  const list = await settings(repo, { method: "GET" });
  assert.equal(list.body.sites.length, 2);
  assert.ok(!JSON.stringify(list.body).includes(ra.config.channelKey) && !JSON.stringify(list.body).includes(rb.config.channelKey));
  assert.deepEqual(Object.keys(toSafeSite(ra)).sort(), ["allowed_domains", "created_at", "display_name", "id", "is_active", "key_version", "public_key", "reply_mode"]);
});

test("settings: update keeps server-owned keys, regenerate rotates key, set_active, delete, validation", async () => {
  const repo = makeRepo();
  await settings(repo, { body: { action: "create", display_name: "Shop", allowed_domains: ["shop.com"] } });
  const row = repo.db.integrations[0];
  const { channelKey, publicKey } = row.config;

  const upd = await settings(repo, { body: { action: "update", id: row.id, display_name: "Shop 2", allowed_domains: ["*.shop.com"], reply_mode: "welcome_only", public_key: "x" } });
  assert.equal(upd.statusCode, 200);
  assert.equal(row.config.channelKey, channelKey);
  assert.equal(row.config.publicKey, publicKey);
  assert.equal(row.config.displayName, "Shop 2");
  assert.equal(row.config.reply_mode, "welcome_only");

  const regen = await settings(repo, { body: { action: "regenerate_key", id: row.id } });
  assert.notEqual(regen.body.site.public_key, publicKey);
  assert.equal(regen.body.site.key_version, 2);
  assert.equal(row.config.channelKey, channelKey);

  assert.equal((await settings(repo, { body: { action: "set_active", id: row.id, is_active: "false" } })).statusCode, 400);
  assert.equal((await settings(repo, { body: { action: "set_active", id: row.id, is_active: false } })).body.site.is_active, false);

  assert.equal((await settings(repo, { body: { action: "create", display_name: "", allowed_domains: ["a.com"] } })).statusCode, 400);
  assert.equal((await settings(repo, { body: { action: "create", display_name: "X", allowed_domains: [] } })).statusCode, 400);
  assert.equal((await settings(repo, { body: { action: "create", display_name: "X", allowed_domains: ["bad domain"] } })).statusCode, 400);
  assert.equal((await settings(repo, { body: { action: "create", display_name: "X", allowed_domains: ["a.com"], reply_mode: "nope" } })).statusCode, 400);

  assert.equal((await settings(repo, { body: { action: "delete", id: row.id } })).statusCode, 200);
  assert.equal(repo.db.integrations.length, 0);
});

test("settings: authorization and tenant isolation", async () => {
  const repo = makeRepo();
  const foreign = site({ id: "int-B", clientId: "client-B" });
  repo.db.integrations.push(foreign);
  assert.equal((await settings(repo, { body: { action: "update", id: "int-B", display_name: "hijack" } })).statusCode, 404);
  assert.equal((await settings(repo, { body: { action: "delete", id: "int-B" } })).statusCode, 404);
  assert.equal(foreign.config.displayName, "Main site");
  const list = await settings(repo, { method: "GET" });
  assert.equal(list.body.sites.length, 0);

  const res = mockRes();
  await handleWebsiteChatSettings({ method: "POST", body: { actor_user_id: "nobody", action: "create" }, query: {} }, res, settingsDeps(repo));
  assert.equal(res.statusCode, 401);
  const agent = { user: { id: "u1", must_change_password: false }, membership: { client_id: "client-A", role: "agent", is_active: true } };
  assert.equal((await settings(repo, { actor: agent, body: { action: "create" } })).statusCode, 403);
  const mustChange = { ...owner, user: { id: "u1", must_change_password: true } };
  assert.equal((await settings(repo, { actor: mustChange, body: { action: "create" } })).statusCode, 403);
});

test("settings: plan limit and feature not migrated", async () => {
  const limited = makeRepo({ planLimit: 1 });
  assert.equal((await settings(limited, { body: { action: "create", display_name: "A", allowed_domains: ["a.com"] } })).statusCode, 200);
  assert.equal((await settings(limited, { body: { action: "create", display_name: "B", allowed_domains: ["b.com"] } })).statusCode, 409);
  assert.equal((await settings(makeRepo({ noFeature: true }), { method: "GET" })).statusCode, 503);
  assert.equal(await isWebsiteChatFeatureId(makeRepo(), FEATURE_ID), true);
  assert.equal(await isWebsiteChatFeatureId(makeRepo(), OTHER_FEATURE_ID), false);
  assert.equal(await isWebsiteChatFeatureId(makeRepo({ noFeature: true }), FEATURE_ID), false);
  assert.equal(resolveIntegrationsResource({ query: { resource: "website_chat" } }), "website_chat");
});

// ===================================================================
// 10. Human Reply (website_chat persists directly)
// ===================================================================

test("human reply: website_chat target resolved within tenant; other platforms untouched", async () => {
  const supabase = createMockSupabase({
    conversations: [
      { id: "conv-w", client_id: "client-A", platform: "website_chat", channel_identity_id: "ci-w" },
      { id: "conv-t", client_id: "client-A", platform: "telegram", channel_identity_id: "ci-t" },
      { id: "conv-x", client_id: "client-B", platform: "website_chat", channel_identity_id: "ci-x" },
    ],
    contact_channel_identities: [
      { id: "ci-w", client_id: "client-A", sender_id: "vis-1" },
      { id: "ci-x", client_id: "client-B", sender_id: "vis-9" },
    ],
    messages: [],
  });
  assert.deepEqual(await resolveWebsiteChatReplyTarget(supabase, "client-A", "conv-w"), { isWebsiteChat: true, senderId: "vis-1" });
  assert.deepEqual(await resolveWebsiteChatReplyTarget(supabase, "client-A", "conv-t"), { isWebsiteChat: false });
  assert.deepEqual(await resolveWebsiteChatReplyTarget(supabase, "client-A", "conv-x"), { isWebsiteChat: false }); // other tenant
  assert.deepEqual(await resolveWebsiteChatReplyTarget({ from() { throw new Error("db down"); } }, "client-A", "conv-w"), { isWebsiteChat: false });

  const row = buildWebsiteChatHumanReplyRow({ clientId: "client-A", conversationId: "conv-w", senderId: "vis-1", message: "hello", sentByUserId: "emp-1" });
  assert.deepEqual(row, {
    client_id: "client-A", channel: "website_chat", sender: "vis-1", message: "hello", direction: "outbound",
    reply_source: "human", sent_by_user_id: "emp-1", conversation_id: "conv-w", message_type: "text",
  });
  const db = createMockSupabase({ messages: [] });
  assert.equal(await persistWebsiteChatHumanReply(db, row), true);
});

test("humanReply.js: website branch sits after authorization + takeover checks and before the n8n webhook lookup", () => {
  const src = fs.readFileSync(new URL("../humanReply.js", import.meta.url), "utf8");
  const iBlock = src.indexOf("humanTakeoverBlock(gate, actor.user.id)");
  const iWebsite = src.indexOf("resolveWebsiteChatReplyTarget(supabase, actor.membership.client_id, conversation_id)");
  const iWebhook = src.indexOf('.from("system_settings")');
  assert.ok(iBlock > 0 && iWebsite > iBlock && iWebhook > iWebsite);
  assert.match(src, /MEDIA_NOT_SUPPORTED/);
});

// ===================================================================
// 11. Migration contract
// ===================================================================

test("migration: visitors table stores only a token hash, is server-only, and tenant-keyed", () => {
  const sql = fs.readFileSync(new URL("../../../supabase/migrations/20260930_website_chat_foundation.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.website_chat_visitors/);
  assert.match(sql, /token_hash text not null/);
  assert.doesNotMatch(sql, /\btoken text\b|raw_token/);
  assert.match(sql, /check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /alter table public\.website_chat_visitors enable row level security;/);
  assert.match(sql, /revoke all on public\.website_chat_visitors from anon, authenticated;/);
  assert.match(sql, /foreign key \(integration_id, client_id\)\s+references public\.client_feature_integrations \(id, client_id\) on delete cascade/);
  assert.match(sql, /client_feature_integrations_website_chat_public_key_key/);
  assert.match(sql, /grant execute on function public\.website_chat_visitor_hit\([^)]*\) to service_role;/);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /system_settings/);
});

// DEV pre-flight STOP #1 remediation: the global UNIQUE (client_id, feature_id)
// is REPLACED by a partial unique index excluding only website_chat.
const MIGRATION_SQL = fs.readFileSync(new URL("../../../supabase/migrations/20260930_website_chat_foundation.sql", import.meta.url), "utf8");
// statements only (comments stripped), so ordering checks ignore the header docs
const MIGRATION_CODE = MIGRATION_SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

test("migration: website_chat feature id is resolved dynamically, after the feature row is ensured", () => {
  const iInsert = MIGRATION_CODE.indexOf("insert into public.features (name, slug, description)");
  const iResolve = MIGRATION_CODE.indexOf("select id into v_wc_feature_id from public.features where slug = 'website_chat';");
  assert.ok(iInsert >= 0 && iResolve > iInsert);
  assert.match(MIGRATION_CODE, /if v_wc_feature_id is null then\s+raise exception 'website_chat feature row missing';/);
  assert.doesNotMatch(MIGRATION_CODE, /feature_id <> '[0-9a-f-]{36}'/); // no hard-coded environment id
});

test("migration: duplicate (client_id, feature_id) groups among NON-website rows abort the migration", () => {
  assert.match(
    MIGRATION_CODE,
    /where feature_id is distinct from v_wc_feature_id\s+group by client_id, feature_id\s+having count\(\*\) > 1/
  );
  assert.match(MIGRATION_CODE, /if v_dups > 0 then\s+raise exception 'client_feature_integrations has % duplicate \(client_id, feature_id\) groups/);
});

test("migration: replacement partial unique index excludes only the website_chat feature id", () => {
  assert.match(
    MIGRATION_CODE,
    /'create unique index client_feature_integrations_client_feature_non_website_key\s+on public\.client_feature_integrations \(client_id, feature_id\)\s+where feature_id <> %L::uuid',\s+v_wc_feature_id/
  );
  assert.match(MIGRATION_CODE, /execute format\(/);
});

test("migration: replacement protection is created BEFORE the old global unique is removed; constraint or index handled", () => {
  const iCreate = MIGRATION_CODE.indexOf("create unique index client_feature_integrations_client_feature_non_website_key");
  const iDupCheck = MIGRATION_CODE.indexOf("if v_dups > 0 then");
  const iDropConstraint = MIGRATION_CODE.indexOf("drop constraint client_feature_integrations_client_id_feature_id_key");
  const iDropIndex = MIGRATION_CODE.indexOf("drop index public.client_feature_integrations_client_id_feature_id_key");
  assert.ok(iDupCheck > 0 && iCreate > iDupCheck, "duplicate check precedes the new index");
  assert.ok(iDropConstraint > iCreate && iDropIndex > iCreate, "old unique removed only after the new one exists");
  // constraint branch guarded by pg_constraint, index branch by to_regclass
  assert.match(
    MIGRATION_CODE,
    /conname = 'client_feature_integrations_client_id_feature_id_key'\s+\) then\s+alter table public\.client_feature_integrations\s+drop constraint client_feature_integrations_client_id_feature_id_key;\s+elsif to_regclass\('public\.client_feature_integrations_client_id_feature_id_key'\) is not null then\s+drop index public\.client_feature_integrations_client_id_feature_id_key;/
  );
  // the old object is never dropped anywhere else
  assert.equal((MIGRATION_CODE.match(/client_feature_integrations_client_id_feature_id_key;/g) || []).length, 2);
  assert.doesNotMatch(MIGRATION_CODE, /raise warning/);
});

test("migration: single transaction; Website Chat key uniqueness and composite key kept; created_at untouched", () => {
  assert.match(MIGRATION_CODE.trim(), /^begin;/);
  assert.match(MIGRATION_CODE.trim(), /commit;$/);
  assert.equal((MIGRATION_CODE.match(/^begin;$/gm) || []).length, 1);
  assert.match(MIGRATION_CODE, /create unique index if not exists client_feature_integrations_website_chat_public_key_key\s+on public\.client_feature_integrations \(\(config->>'publicKey'\)\)\s+where config \? 'publicKey';/);
  assert.match(MIGRATION_CODE, /create unique index if not exists client_feature_integrations_website_chat_channel_key_key\s+on public\.client_feature_integrations \(\(config->>'channelKey'\)\)\s+where config \? 'publicKey';/);
  assert.match(MIGRATION_CODE, /add constraint client_feature_integrations_id_client_id_key unique \(id, client_id\);/);
  assert.doesNotMatch(MIGRATION_CODE, /alter\s+column\s+created_at|created_at\s+(set\s+data\s+)?type\b/i);
  assert.doesNotMatch(MIGRATION_CODE, /alter table public\.client_feature_integrations\s+alter/i);
});
