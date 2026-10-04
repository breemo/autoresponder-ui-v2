import { WEBSITE_CHAT_LIMITS as L } from "./websiteChatLimits.js";
import { hostFromOrigin, isHostAllowed } from "./websiteChatDomains.js";
import { isPublicKeyFormat, isVisitorTokenFormat, generateVisitorToken, hashToken } from "./websiteChatKeys.js";
import { isValidCursorCreatedAt, isValidCursorId, buildNewerThanFilter } from "./conversationMessagesPage.js";

// Website Chat — public widget service logic (api/widget.js).
//
// Scope: public bootstrap, visitor session create/resume, visitor token
// validation, message polling, and message submission. It NEVER
// orchestrates a conversation, calls OpenAI or AI-Agent-Core: a validated
// visitor message is handed to n8n AutoResponder_Final_V3 through
// deps.deliverToOrchestrator (api/_lib/websiteChatOrchestrator.js, wired in
// api/widget.js). `send` returns 202 only when n8n accepted the message —
// never a fake success.
//
// Browser-visible data: public widget key (it sent it), visitor bearer
// token, display name, and its own conversation messages. Never returned:
// channelKey, client_id, integration/visitor/conversation ids, employee
// identity, allowed domains.

export const TEAM_LABEL = "Team";

const result = (status, body) => ({ status, body });
const fail = (status, code, message) => result(status, { ok: false, code, message });

const DAY_MS = 86400000;

// Fail-closed default when no orchestrator delivery is wired in.
export async function unconfiguredOrchestratorDelivery() {
  return { delivered: false, reason: "not_configured" };
}

// An integration usable by the widget: exists, is a Website Chat row,
// active, and carries both keys.
async function activeSite(repo, integration) {
  if (!integration) return { error: fail(404, "invalid_key", "Website Chat is not available") };
  const featureId = await repo.getWebsiteChatFeatureId();
  const cfg = integration.config || {};
  if (!featureId || integration.feature_id !== featureId || !cfg.publicKey || !cfg.channelKey) {
    return { error: fail(404, "invalid_key", "Website Chat is not available") };
  }
  if (integration.is_active !== true) return { error: fail(403, "site_inactive", "Website Chat is not available") };
  return { site: integration, cfg };
}

function allowedDomainsOf(cfg) {
  return Array.isArray(cfg.allowedDomains) ? cfg.allowedDomains : [];
}

async function siteForPublicKey(repo, publicKey) {
  if (!isPublicKeyFormat(publicKey)) return { error: fail(404, "invalid_key", "Website Chat is not available") };
  return activeSite(repo, await repo.findIntegrationByPublicKey(publicKey));
}

function checkParentOrigin(cfg, parentOrigin) {
  const host = hostFromOrigin(parentOrigin);
  if (!host || !isHostAllowed(host, allowedDomainsOf(cfg))) {
    return { error: fail(403, "domain_not_allowed", "This website is not allowed to use this chat") };
  }
  return { host };
}

// ---- bootstrap: display-safe config for an allowed parent page ----
export async function bootstrap(deps, { publicKey, parentOrigin }) {
  const { repo } = deps;
  const s = await siteForPublicKey(repo, publicKey);
  if (s.error) return s.error;
  const o = checkParentOrigin(s.cfg, parentOrigin);
  if (o.error) return o.error;
  return result(200, {
    ok: true,
    site: { title: s.cfg.displayName || "" },
    limits: { message_max_length: L.MESSAGE_MAX_LENGTH },
  });
}

// ---- session: create or resume a visitor; always re-issues the token ----
export async function startSession(deps, { publicKey, parentOrigin, bearerToken, ipHash }) {
  const { repo, now = () => new Date() } = deps;
  const s = await siteForPublicKey(repo, publicKey);
  if (s.error) return s.error;
  const o = checkParentOrigin(s.cfg, parentOrigin);
  if (o.error) return o.error;
  if (!(await repo.isClientSubscriptionActive(s.site.client_id))) {
    return fail(402, "service_unavailable", "Website Chat is not available");
  }

  const t = now();
  const token = generateVisitorToken();
  const patch = {
    token_hash: hashToken(token),
    token_expires_at: new Date(t.getTime() + L.TOKEN_TTL_DAYS * DAY_MS).toISOString(),
    key_version: Number(s.cfg.keyVersion) || 1,
    origin_host: o.host,
    last_seen_at: t.toISOString(),
    updated_at: t.toISOString(),
  };

  // Resume only a live visitor of THIS integration and client.
  if (isVisitorTokenFormat(bearerToken)) {
    const existing = await repo.findVisitorByTokenHash(hashToken(bearerToken));
    if (
      existing &&
      existing.integration_id === s.site.id &&
      existing.client_id === s.site.client_id &&
      !existing.revoked_at &&
      new Date(existing.token_expires_at).getTime() > t.getTime()
    ) {
      const updated = await repo.updateVisitor(existing.id, s.site.id, patch);
      if (updated) return sessionResponse(s.cfg, token, patch.token_expires_at, true);
    }
  }

  if (ipHash) {
    const since = new Date(t.getTime() - L.SESSION_WINDOW_SECONDS * 1000).toISOString();
    if ((await repo.countRecentSessions(s.site.id, ipHash, since)) >= L.SESSIONS_PER_IP_PER_SITE) {
      return fail(429, "rate_limited", "Too many new chats, please try again later");
    }
  }

  await repo.insertVisitor({
    client_id: s.site.client_id,
    integration_id: s.site.id,
    created_ip_hash: ipHash || null,
    ...patch,
  });
  return sessionResponse(s.cfg, token, patch.token_expires_at, false);
}

function sessionResponse(cfg, token, expiresAt, resumed) {
  return result(200, {
    ok: true,
    token,
    expires_at: expiresAt,
    resumed,
    site: { title: cfg.displayName || "" },
    poll: { interval_ms: L.POLL_AFTER_MS },
  });
}

// ---- visitor token validation (send / messages) ----
export async function authenticateVisitor(deps, bearerToken) {
  const { repo, now = () => new Date() } = deps;
  const invalid = { error: fail(401, "invalid_token", "Session expired, please reload the chat") };
  if (!isVisitorTokenFormat(bearerToken)) return invalid;
  const visitor = await repo.findVisitorByTokenHash(hashToken(bearerToken));
  if (!visitor || visitor.revoked_at) return invalid;
  if (new Date(visitor.token_expires_at).getTime() <= now().getTime()) {
    return { error: fail(401, "token_expired", "Session expired, please reload the chat") };
  }
  const integration = await repo.findIntegrationById(visitor.integration_id);
  if (!integration || integration.client_id !== visitor.client_id) return invalid;
  const s = await activeSite(repo, integration);
  if (s.error) return s;
  if ((Number(s.cfg.keyVersion) || 1) !== (Number(visitor.key_version) || 1)) {
    return { error: fail(401, "token_stale", "Session expired, please reload the chat") };
  }
  if (!visitor.origin_host || !isHostAllowed(visitor.origin_host, allowedDomainsOf(s.cfg))) {
    return { error: fail(403, "domain_not_allowed", "This website is not allowed to use this chat") };
  }
  return { visitor, site: s.site, cfg: s.cfg };
}

// ---- messages: the visitor's own conversation messages ----
function toPublicMessage(m) {
  const inbound = m.direction === "inbound";
  const agent = !inbound && m.reply_source === "human";
  return {
    id: m.id,
    role: inbound ? "visitor" : agent ? "agent" : "bot",
    author: agent ? TEAM_LABEL : null,
    text: typeof m.message === "string" ? m.message : "",
    created_at: m.created_at,
  };
}

export async function pollMessages(deps, { bearerToken, after }) {
  const { repo } = deps;
  const a = await authenticateVisitor(deps, bearerToken);
  if (a.error) return a.error;

  const hit = await repo.hitVisitor(a.visitor.id, "poll", { minuteMax: L.POLLS_PER_MINUTE_PER_VISITOR });
  if (hit === "rate_limited") return fail(429, "rate_limited", "Too many requests");
  if (hit !== "ok") return fail(401, "invalid_token", "Session expired, please reload the chat");

  let afterFilter = null;
  if (after !== undefined && after !== null) {
    if (!isValidCursorCreatedAt(after?.created_at) || !isValidCursorId(String(after?.id ?? ""))) {
      return fail(400, "invalid_cursor", "Invalid cursor");
    }
    afterFilter = buildNewerThanFilter(after.created_at, String(after.id));
  }

  const empty = { ok: true, messages: [], cursor: after || null, status: null, poll_after_ms: L.POLL_AFTER_MS };
  const identity = await repo.findChannelIdentity({
    clientId: a.site.client_id,
    senderId: a.visitor.id,
    channelKey: a.cfg.channelKey,
  });
  if (!identity) return result(200, empty);
  const conversations = await repo.listConversations(a.site.client_id, identity.id);
  if (!conversations.length) return result(200, empty);

  let rows = await repo.listMessages({
    clientId: a.site.client_id,
    conversationIds: conversations.map((c) => c.id),
    afterFilter,
    limit: L.MESSAGES_PAGE_LIMIT,
  });
  if (!afterFilter) rows = rows.slice().reverse(); // newest page -> ascending
  const messages = rows.filter((m) => typeof m.message === "string" && m.message.trim()).map(toPublicMessage);
  const last = rows[rows.length - 1];
  return result(200, {
    ok: true,
    messages,
    cursor: last ? { created_at: last.created_at, id: last.id } : after || null,
    status: conversations[0].conversation_status || null,
    poll_after_ms: L.POLL_AFTER_MS,
  });
}

// ---- send: validation layer; hand-off pending (n8n phase) ----
// Strips control characters except \n and \t; length is checked after trim.
export function normalizeVisitorText(text) {
  if (typeof text !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (cleaned.length < L.MESSAGE_MIN_LENGTH || cleaned.length > L.MESSAGE_MAX_LENGTH) return null;
  return cleaned;
}

export async function submitMessage(deps, { bearerToken, text, clientMessageId }) {
  const { repo, now = () => new Date(), deliverToOrchestrator = unconfiguredOrchestratorDelivery } = deps;
  const a = await authenticateVisitor(deps, bearerToken);
  if (a.error) return a.error;

  const cleaned = normalizeVisitorText(text);
  if (!cleaned) {
    return fail(400, "invalid_text", `Message must be ${L.MESSAGE_MIN_LENGTH}-${L.MESSAGE_MAX_LENGTH} characters`);
  }
  if (typeof clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientMessageId)) {
    return fail(400, "invalid_client_message_id", "Invalid message id");
  }

  const hourAgo = new Date(now().getTime() - 3600000).toISOString();
  if ((await repo.countClientInboundSince(a.site.client_id, hourAgo)) >= L.MESSAGES_PER_HOUR_PER_CLIENT) {
    return fail(429, "rate_limited", "Too many messages, please try again later");
  }

  const hit = await repo.hitVisitor(a.visitor.id, "send", {
    minuteMax: L.MESSAGES_PER_MINUTE_PER_VISITOR,
    dayMax: L.MESSAGES_PER_DAY_PER_VISITOR,
    clientMessageId,
  });
  if (hit === "duplicate") return result(200, { ok: true, accepted: true, duplicate: true });
  if (hit === "rate_limited") return fail(429, "rate_limited", "Too many messages, please slow down");
  if (hit !== "ok") return fail(401, "invalid_token", "Session expired, please reload the chat");

  const delivery = await deliverToOrchestrator({
    channelKey: a.cfg.channelKey,
    visitorId: a.visitor.id,
    text: cleaned,
    clientMessageId,
  });
  if (delivery?.delivered !== true) {
    // Not delivered: release the duplicate guard so the same message can be retried.
    await repo.clearClientMessageId(a.visitor.id, clientMessageId);
    if (delivery?.reason === "not_configured") {
      return fail(503, "not_configured", "Website Chat is not available");
    }
    return fail(502, "upstream_unavailable", "Message could not be delivered, please retry");
  }
  // Accepted by n8n: the duplicate guard stays set (a retry of the same
  // client_message_id is answered as duplicate, not re-sent).
  return result(202, { ok: true, accepted: true });
}
