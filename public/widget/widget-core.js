// Website Chat widget — pure core logic (no DOM access).
// Loaded by frame.js inside the widget iframe and imported by the Node tests.
// Talks ONLY to the existing same-origin /api/widget actions:
// bootstrap, session, send, messages. Contains no secret of any kind; the
// only browser-visible identifier is the public widget key.

export const API_PATH = "/api/widget";

// ---------------------------------------------------------------------------
// Language / direction
// ---------------------------------------------------------------------------

export const STRINGS = {
  en: {
    title: "Chat",
    placeholder: "Type your message…",
    send: "Send",
    sending: "Sending…",
    retry: "Retry",
    failed: "Not sent",
    close: "Close chat",
    team: "Team",
    typing: "Typing…",
    waiting_human: "A team member will reply shortly",
    closed: "This conversation has ended. Send a message to start a new one.",
    unavailable: "Chat is not available right now.",
    session_expired: "Your session has expired. Please reload the page.",
    rate_limited: "Too many messages. Please wait a moment and try again.",
    backend_unavailable: "We couldn't deliver your message. Please try again.",
    network: "Connection problem. Please check your internet connection.",
    invalid_text: "Please enter a message (up to 2000 characters).",
    loading: "Loading…",
    empty: "Send us a message — we're here to help.",
  },
  ar: {
    title: "المحادثة",
    placeholder: "اكتب رسالتك…",
    send: "إرسال",
    sending: "جارٍ الإرسال…",
    retry: "إعادة المحاولة",
    failed: "لم تُرسل",
    close: "إغلاق المحادثة",
    team: "الفريق",
    typing: "يكتب…",
    waiting_human: "سيرد عليك أحد أعضاء الفريق قريباً",
    closed: "انتهت هذه المحادثة. أرسل رسالة لبدء محادثة جديدة.",
    unavailable: "المحادثة غير متاحة حالياً.",
    session_expired: "انتهت صلاحية الجلسة. يرجى إعادة تحميل الصفحة.",
    rate_limited: "رسائل كثيرة. يرجى الانتظار قليلاً ثم المحاولة مرة أخرى.",
    backend_unavailable: "تعذر إرسال رسالتك. يرجى المحاولة مرة أخرى.",
    network: "مشكلة في الاتصال. يرجى التحقق من اتصالك بالإنترنت.",
    invalid_text: "يرجى كتابة رسالة (حتى 2000 حرف).",
    loading: "جارٍ التحميل…",
    empty: "أرسل لنا رسالة — نحن هنا للمساعدة.",
  },
};

export function resolveLang(...candidates) {
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const v = c.trim().toLowerCase();
    if (v.startsWith("ar")) return "ar";
    if (v.startsWith("en")) return "en";
  }
  return "en";
}

export function dirFor(lang) {
  return lang === "ar" ? "rtl" : "ltr";
}

export function t(lang, key) {
  const table = STRINGS[lang] || STRINGS.en;
  return table[key] ?? STRINGS.en[key] ?? key;
}

// ---------------------------------------------------------------------------
// Parent origin — ONLY from browser-provided values (fail closed)
// ---------------------------------------------------------------------------

function toHttpOrigin(value) {
  if (typeof value !== "string" || !value || value === "null") return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

// ancestorOrigins: location.ancestorOrigins (Chromium/Safari); referrer:
// document.referrer (Firefox fallback). Never a query parameter, data
// attribute or postMessage value. Returns null when unknown -> fail closed.
export function resolveParentOrigin({ ancestorOrigins, referrer } = {}) {
  const first = ancestorOrigins && ancestorOrigins.length > 0 ? ancestorOrigins[0] : null;
  if (first) return toHttpOrigin(first);
  return toHttpOrigin(referrer);
}

// ---------------------------------------------------------------------------
// Token store (iframe-origin localStorage, in-memory fallback)
// ---------------------------------------------------------------------------

export function tokenStorageKey(publicKey) {
  return `wc:${publicKey}`;
}

export function createTokenStore(storage, publicKey) {
  const key = tokenStorageKey(publicKey);
  let memory = null;
  return {
    get() {
      try {
        const v = storage ? storage.getItem(key) : null;
        if (v) return v;
      } catch {
        /* storage blocked */
      }
      return memory;
    },
    set(token) {
      memory = token || null;
      try {
        if (!storage) return;
        if (token) storage.setItem(key, token);
        else storage.removeItem(key);
      } catch {
        /* storage blocked: memory only */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Error / status mapping (never shows raw backend text)
// ---------------------------------------------------------------------------

export const AUTH_RECOVERABLE = new Set(["invalid_token", "token_expired", "token_stale"]);

export function isAuthRecoverable(result) {
  return !!result && result.status === 401 && AUTH_RECOVERABLE.has(result.code);
}

// -> one of: unavailable | session_expired | rate_limited | backend_unavailable | network | invalid_text
export function errorStateFor(result) {
  if (!result) return "network";
  const { status, code } = result;
  if (status === 0 || code === "network") return "network";
  if (status === 401) return "session_expired";
  if (status === 429) return "rate_limited";
  if (status === 400 && (code === "invalid_text" || code === "invalid_client_message_id")) return "invalid_text";
  if (status === 404 || status === 402 || status === 403) return "unavailable";
  if (status === 503 && code === "not_configured") return "unavailable";
  if (status >= 500) return "backend_unavailable";
  return "backend_unavailable";
}

// Fatal = the widget cannot be used at all (hide the launcher).
export function isFatalState(state) {
  return state === "unavailable";
}

export function statusBanner(status) {
  if (status === "waiting_human") return "waiting_human";
  if (status === "closed") return "closed";
  return null;
}

export function roleLabelKey(role) {
  return role === "agent" ? "team" : null;
}

// ---------------------------------------------------------------------------
// Messages: merge / dedupe / order, optimistic reconciliation
// ---------------------------------------------------------------------------

function timeOf(value) {
  const n = Date.parse(value);
  return Number.isNaN(n) ? 0 : n;
}

function compareMessages(a, b) {
  const ta = timeOf(a.created_at), tb = timeOf(b.created_at);
  if (ta !== tb) return ta - tb;
  const ai = String(a.id), bi = String(b.id);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

export function mergeMessages(existing, incoming) {
  const byId = new Map();
  for (const m of existing || []) if (m && m.id != null) byId.set(String(m.id), m);
  for (const m of incoming || []) if (m && m.id != null) byId.set(String(m.id), m);
  return [...byId.values()].sort(compareMessages);
}

// Removes optimistic (pending/sent) visitor bubbles that now exist on the
// server. The contract returns no client_message_id, so the stored copy is
// matched by role "visitor" + identical text, oldest first, each server
// message used at most once.
export function reconcileOutbox(outbox, serverMessages) {
  const used = new Set();
  const remaining = [];
  for (const item of outbox) {
    if (item.state === "failed") {
      remaining.push(item);
      continue;
    }
    const match = (serverMessages || []).find(
      (m) => m.role === "visitor" && !used.has(String(m.id)) && m.text === item.text && timeOf(m.created_at) >= timeOf(item.createdAtFloor)
    );
    if (match) used.add(String(match.id));
    else remaining.push(item);
  }
  return remaining;
}

// Same normalization as the backend (control chars except \n/\t stripped,
// trimmed, 1-2000 chars) so the optimistic bubble matches the stored text.
export const MESSAGE_MAX_LENGTH = 2000;
export function normalizeVisitorText(text) {
  if (typeof text !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (cleaned.length < 1 || cleaned.length > MESSAGE_MAX_LENGTH) return null;
  return cleaned;
}

// ---------------------------------------------------------------------------
// Outbox: stable client_message_id per message (retries reuse it)
// ---------------------------------------------------------------------------

export function newClientMessageId(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `cm-${Date.now().toString(36)}-${rnd()}${rnd()}`;
}

export function createOutbox({ idFactory = () => newClientMessageId(), now = () => new Date() } = {}) {
  let items = [];
  let seq = 0;
  return {
    add(text) {
      const item = {
        localId: `local-${++seq}`,
        clientMessageId: idFactory(),
        text,
        state: "sending",
        // server timestamps are ISO strings; allow some clock skew
        createdAtFloor: new Date(now().getTime() - 5 * 60 * 1000).toISOString(),
      };
      items = [...items, item];
      return item;
    },
    get(localId) {
      return items.find((i) => i.localId === localId) || null;
    },
    mark(localId, state) {
      items = items.map((i) => (i.localId === localId ? { ...i, state } : i));
    },
    // retry keeps the SAME client_message_id
    retry(localId) {
      const item = items.find((i) => i.localId === localId);
      if (!item) return null;
      items = items.map((i) => (i.localId === localId ? { ...i, state: "sending" } : i));
      return { ...item, state: "sending" };
    },
    reconcile(serverMessages) {
      items = reconcileOutbox(items, serverMessages);
    },
    list() {
      return items;
    },
    hasSending() {
      return items.some((i) => i.state === "sending");
    },
  };
}

// ---------------------------------------------------------------------------
// Polling schedule
// ---------------------------------------------------------------------------

export const POLL = Object.freeze({
  ACTIVE_WINDOW_MS: 60000,
  IDLE_MS: 10000,
  CLOSED_MS: 30000,
  RATE_LIMITED_MS: 30000,
  MAX_BACKOFF_MS: 60000,
  DEFAULT_BASE_MS: 3000,
});

// Returns the delay in ms until the next poll, or null to pause.
export function nextPollDelay({
  hidden = false,
  open = false,
  hasConversation = false,
  lastActivityAt = 0,
  now = Date.now(),
  baseMs = POLL.DEFAULT_BASE_MS,
  errorCount = 0,
  rateLimited = false,
} = {}) {
  if (hidden) return null;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : POLL.DEFAULT_BASE_MS;
  let delay;
  if (open) delay = now - lastActivityAt <= POLL.ACTIVE_WINDOW_MS ? base : Math.max(POLL.IDLE_MS, base);
  else if (hasConversation) delay = Math.max(POLL.CLOSED_MS, base);
  else return null; // closed launcher, nothing to watch
  if (rateLimited) delay = Math.max(delay, POLL.RATE_LIMITED_MS);
  if (errorCount > 0) delay = Math.min(POLL.MAX_BACKOFF_MS, Math.max(delay, base * 2 ** errorCount));
  return delay;
}

// ---------------------------------------------------------------------------
// API client with ONE automatic session recovery + ONE retry on 401
// ---------------------------------------------------------------------------

async function request(fetchImpl, apiBase, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`${apiBase}${API_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, code: data && data.code, body: data || {} };
  } catch {
    return { ok: false, status: 0, code: "network", body: {} };
  }
}

export function createWidgetClient({ fetchImpl, apiBase = "", publicKey, parentOrigin, tokenStore }) {
  if (!parentOrigin) throw new Error("parent origin unavailable");
  const client = {
    bootstrap() {
      return request(fetchImpl, apiBase, { action: "bootstrap", key: publicKey, parent_origin: parentOrigin });
    },
    async session() {
      const r = await request(
        fetchImpl,
        apiBase,
        { action: "session", key: publicKey, parent_origin: parentOrigin },
        tokenStore.get()
      );
      if (r.ok && r.body && r.body.token) tokenStore.set(r.body.token); // always replace
      return r;
    },
    async authed(body) {
      let r = await request(fetchImpl, apiBase, body, tokenStore.get());
      if (!isAuthRecoverable(r)) return r;
      const s = await client.session(); // ONE recovery
      if (!s.ok) return s;
      r = await request(fetchImpl, apiBase, body, tokenStore.get()); // ONE retry
      return r;
    },
    messages(after) {
      return client.authed(after ? { action: "messages", after } : { action: "messages" });
    },
    send(text, clientMessageId) {
      return client.authed({ action: "send", text, client_message_id: clientMessageId });
    },
  };
  return client;
}

export function isAccepted(result) {
  return !!result && result.ok === true && result.body && result.body.accepted === true;
}
