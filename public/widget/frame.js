// Website Chat widget — iframe UI. Runs on the Auto Responder origin and calls
// the existing same-origin /api/widget (bootstrap, session, send, messages).
// The parent page origin is taken ONLY from browser-provided values
// (location.ancestorOrigins / document.referrer); never from the URL query,
// a data attribute or postMessage. Unknown -> fail closed.
import {
  t,
  dirFor,
  resolveLang,
  resolveParentOrigin,
  createTokenStore,
  createWidgetClient,
  createOutbox,
  errorStateFor,
  isFatalState,
  isAccepted,
  mergeMessages,
  nextPollDelay,
  normalizeVisitorText,
  roleLabelKey,
  statusBanner,
  POLL,
} from "./widget-core.js";

const params = new URLSearchParams(window.location.search);
const publicKey = params.get("key") || ""; // public widget key (browser-visible by design)
const lang = resolveLang(params.get("lang"), navigator.language); // presentation only
const parentOrigin = resolveParentOrigin({
  ancestorOrigins: window.location.ancestorOrigins,
  referrer: document.referrer,
});

const $ = (id) => document.getElementById(id);
const root = $("wc-root");
const titleEl = $("wc-title");
const closeBtn = $("wc-close");
const bannerEl = $("wc-banner");
const listEl = $("wc-messages");
const noticeEl = $("wc-notice");
const form = $("wc-composer");
const input = $("wc-input");
const sendBtn = $("wc-send");

document.documentElement.lang = lang;
document.documentElement.dir = dirFor(lang);
titleEl.textContent = t(lang, "title");
closeBtn.setAttribute("aria-label", t(lang, "close"));
input.placeholder = t(lang, "placeholder");
input.setAttribute("aria-label", t(lang, "placeholder"));
sendBtn.textContent = t(lang, "send");

const state = {
  ready: false,
  fatal: false,
  open: true, // the iframe is created when the visitor opens the chat
  messages: [],
  cursor: null,
  status: null,
  baseMs: POLL.DEFAULT_BASE_MS,
  lastActivityAt: Date.now(),
  errorCount: 0,
  rateLimited: false,
  inflight: false,
  timer: null,
  sending: false,
  typingUntil: 0,
  unread: 0,
};
const outbox = createOutbox();
let client = null;

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function postToParent(message) {
  if (!parentOrigin || window.parent === window) return;
  window.parent.postMessage(message, parentOrigin); // UI state only — never tokens/ids
}

function showNotice(key) {
  noticeEl.textContent = key ? t(lang, key) : "";
  noticeEl.hidden = !key;
}

function updateComposer() {
  const usable = state.ready && !state.fatal;
  input.disabled = !usable;
  sendBtn.disabled = !usable || state.sending;
  sendBtn.textContent = state.sending ? t(lang, "sending") : t(lang, "send");
}

function showFatal(stateKey) {
  state.fatal = true;
  clearTimeout(state.timer);
  root.dataset.state = stateKey === "session_expired" ? "expired" : "unavailable";
  showNotice(stateKey === "session_expired" ? "session_expired" : "unavailable");
  updateComposer();
  if (isFatalState(stateKey)) postToParent({ type: "wc:unavailable" });
}

function bubble(role, text, extraClass) {
  const el = document.createElement("div");
  el.className = `wc-msg wc-msg--${role}${extraClass ? ` ${extraClass}` : ""}`;
  const labelKey = roleLabelKey(role);
  if (labelKey) {
    const author = document.createElement("span");
    author.className = "wc-msg-author";
    author.textContent = t(lang, labelKey);
    el.appendChild(author);
  }
  el.appendChild(document.createTextNode(text));
  return el;
}

function render() {
  const banner = statusBanner(state.status);
  bannerEl.hidden = !banner;
  bannerEl.textContent = banner ? t(lang, banner) : "";

  listEl.textContent = "";
  const pending = outbox.list();
  if (!state.messages.length && !pending.length) {
    const empty = document.createElement("div");
    empty.className = "wc-empty";
    empty.textContent = state.ready ? t(lang, "empty") : t(lang, "loading");
    listEl.appendChild(empty);
  }
  for (const m of state.messages) {
    const role = m.role === "visitor" || m.role === "agent" ? m.role : "bot";
    listEl.appendChild(bubble(role, m.text || ""));
  }
  for (const item of pending) {
    const el = bubble("visitor", item.text, item.state === "failed" ? "wc-msg--failed" : "wc-msg--pending");
    const meta = document.createElement("span");
    meta.className = "wc-msg-meta";
    meta.textContent = item.state === "failed" ? t(lang, "failed") : item.state === "sending" ? t(lang, "sending") : "";
    if (item.state === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "wc-retry";
      retry.textContent = t(lang, "retry");
      retry.addEventListener("click", () => {
        if (!state.sending && outbox.retry(item.localId)) deliver(item.localId);
      });
      meta.appendChild(retry);
    }
    el.appendChild(meta);
    listEl.appendChild(el);
  }
  if (state.typingUntil > Date.now()) {
    const typing = document.createElement("div");
    typing.className = "wc-typing";
    typing.textContent = t(lang, "typing");
    listEl.appendChild(typing);
  }
  listEl.scrollTop = listEl.scrollHeight;
}

// ---------------------------------------------------------------- polling
function schedule() {
  clearTimeout(state.timer);
  if (state.fatal || !state.ready) return;
  const delay = nextPollDelay({
    hidden: document.hidden,
    open: state.open,
    hasConversation: state.messages.length > 0 || outbox.list().length > 0,
    lastActivityAt: state.lastActivityAt,
    now: Date.now(),
    baseMs: state.baseMs,
    errorCount: state.errorCount,
    rateLimited: state.rateLimited,
  });
  if (delay == null) return;
  state.timer = setTimeout(poll, delay);
}

function pollNow() {
  clearTimeout(state.timer);
  poll();
}

async function poll() {
  if (state.inflight || state.fatal || !state.ready) return;
  state.inflight = true;
  let result;
  try {
    result = await client.messages(state.cursor);
  } finally {
    state.inflight = false;
  }
  if (result.ok) {
    state.errorCount = 0;
    state.rateLimited = false;
    const incoming = Array.isArray(result.body.messages) ? result.body.messages : [];
    if (incoming.length) {
      const known = new Set(state.messages.map((m) => String(m.id)));
      const fresh = incoming.filter((m) => !known.has(String(m.id)));
      state.messages = mergeMessages(state.messages, incoming);
      outbox.reconcile(state.messages);
      if (fresh.some((m) => m.role !== "visitor")) {
        state.typingUntil = 0;
        state.lastActivityAt = Date.now();
        if (!state.open) {
          state.unread += fresh.filter((m) => m.role !== "visitor").length;
          postToParent({ type: "wc:unread", count: state.unread });
        }
      }
    }
    if (result.body.cursor) state.cursor = result.body.cursor;
    if (result.body.status !== undefined) state.status = result.body.status;
    if (Number(result.body.poll_after_ms) > 0) state.baseMs = Number(result.body.poll_after_ms);
    render();
  } else {
    const errState = errorStateFor(result);
    if (errState === "unavailable" || errState === "session_expired") {
      showFatal(errState);
      return;
    }
    if (result.status === 429) state.rateLimited = true;
    state.errorCount += 1;
  }
  schedule();
}

// ---------------------------------------------------------------- sending
async function deliver(localId) {
  const item = outbox.get(localId);
  if (!item || state.sending || state.fatal) return;
  state.sending = true;
  updateComposer();
  render();
  const result = await client.send(item.text, item.clientMessageId); // same id on retry
  state.sending = false;
  if (isAccepted(result)) {
    outbox.mark(localId, "sent");
    state.lastActivityAt = Date.now();
    state.typingUntil = Date.now() + 45000;
    showNotice(null);
    setTimeout(pollNow, 1200);
  } else {
    const errState = errorStateFor(result);
    if (errState === "unavailable" || errState === "session_expired") {
      outbox.mark(localId, "failed");
      showFatal(errState);
    } else {
      outbox.mark(localId, "failed");
      showNotice(errState);
      if (result.status === 429) state.rateLimited = true;
    }
  }
  updateComposer();
  render();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.sending || state.fatal || !state.ready) return;
  const text = normalizeVisitorText(input.value);
  if (!text) {
    showNotice("invalid_text");
    return;
  }
  showNotice(null);
  input.value = "";
  const item = outbox.add(text);
  deliver(item.localId);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

closeBtn.addEventListener("click", () => {
  state.open = false;
  postToParent({ type: "wc:close" });
  schedule();
});

// Parent -> frame: UI visibility only, from the embedding window's origin.
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== parentOrigin) return;
  const data = event.data || {};
  if (data.type === "wc:visibility") {
    state.open = !!data.open;
    if (state.open) {
      state.unread = 0;
      postToParent({ type: "wc:unread", count: 0 });
      state.lastActivityAt = Date.now();
      pollNow();
    } else {
      schedule();
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(state.timer);
  else pollNow();
});

// ---------------------------------------------------------------- init
async function init(attempt = 0) {
  if (!publicKey || !parentOrigin || window.parent === window) {
    showFatal("unavailable"); // fail closed
    render();
    return;
  }
  if (!client) {
    client = createWidgetClient({
      fetchImpl: window.fetch.bind(window),
      apiBase: "",
      publicKey,
      parentOrigin,
      tokenStore: createTokenStore(safeLocalStorage(), publicKey),
    });
  }
  const retryLater = (result) => {
    const errState = errorStateFor(result);
    if (isFatalState(errState) || attempt >= 2) {
      showFatal(isFatalState(errState) ? errState : "unavailable");
      render();
      return;
    }
    showNotice(errState);
    setTimeout(() => init(attempt + 1), 5000 * 3 ** attempt); // 5s, 15s, then give up
  };

  const boot = await client.bootstrap();
  if (!boot.ok) return retryLater(boot);
  const title = boot.body && boot.body.site && boot.body.site.title;
  if (title) {
    titleEl.textContent = title;
    document.title = title;
  }
  const session = await client.session();
  if (!session.ok) return retryLater(session);
  const interval = Number(session.body && session.body.poll && session.body.poll.interval_ms);
  if (interval > 0) state.baseMs = interval;

  state.ready = true;
  root.dataset.state = "ready";
  showNotice(null);
  updateComposer();
  render();
  postToParent({ type: "wc:ready" });
  input.focus();
  poll();
}

updateComposer();
render();
init();
