import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Website Chat widget — static security contract + loader behavior (fake DOM).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const W = (f) => path.join(ROOT, "public/widget", f);
const read = (f) => fs.readFileSync(W(f), "utf8");
const FILES = ["embed.js", "frame.html", "frame.css", "frame.js", "widget-core.js", "demo.html"];
const KEY = "wcpk_" + "Bc9_-".repeat(6) + "xy";

test("all Phase W widget files exist", () => {
  for (const f of FILES) assert.ok(fs.existsSync(W(f)), f);
});

test("no secret, privileged credential, channelKey or n8n reference in any browser-visible widget file", () => {
  const forbidden = [/AI_TOOLS_SECRET/i, /x-ai-tools-secret/i, /service[_-]?role/i, /SUPABASE/i, /supabase\.co/i, /channel[_-]?key/i, /channelKey/, /n8n/i, /railway\.app/i, /webhook/i, /\beyJ[A-Za-z0-9_-]{10,}/, /Bearer\s+[A-Za-z0-9_-]{20,}/];
  for (const f of FILES) {
    const src = read(f);
    for (const re of forbidden) assert.doesNotMatch(src, re, `${f} contains ${re}`);
  }
});

test("widget talks only to the existing same-origin /api/widget actions", () => {
  const core = read("widget-core.js");
  assert.match(core, /export const API_PATH = "\/api\/widget";/);
  const actions = [...new Set([...core.matchAll(/action: "([a-z_]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(actions, ["bootstrap", "messages", "send", "session"]);
  for (const f of FILES) {
    const urls = [...read(f).matchAll(/["'`](\/api\/[a-z-]+)/g)].map((m) => m[1]);
    for (const u of urls) assert.equal(u, "/api/widget", `${f} calls ${u}`);
    assert.doesNotMatch(read(f), /new WebSocket|EventSource/, f);
  }
  const frame = read("frame.js");
  assert.match(frame, /apiBase: ""/); // same-origin relative calls only
});

test("frame: parent origin only from location.ancestorOrigins / document.referrer — never from query/postMessage", () => {
  const frame = read("frame.js");
  assert.match(frame, /resolveParentOrigin\(\{\s*ancestorOrigins: window\.location\.ancestorOrigins,\s*referrer: document\.referrer,\s*\}\)/);
  const queryReads = [...frame.matchAll(/params\.get\("([a-z_]+)"\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(queryReads, ["key", "lang"]); // no parent/origin parameter
  assert.doesNotMatch(frame, /parent_origin/); // only widget-core builds the request field
  assert.doesNotMatch(frame, /data\.(origin|parent)/);
  // fail closed
  assert.match(frame, /if \(!publicKey \|\| !parentOrigin \|\| window\.parent === window\) \{\s*showFatal\("unavailable"\)/);
  // inbound postMessage from the embedding window only, outbound with an explicit target origin
  assert.match(frame, /if \(event\.source !== window\.parent \|\| event\.origin !== parentOrigin\) return;/);
  assert.match(frame, /window\.parent\.postMessage\(message, parentOrigin\)/);
  assert.doesNotMatch(frame, /postMessage\([^)]*["']\*["']/);
  assert.doesNotMatch(frame, /innerHTML/); // all text rendered via textContent / text nodes
  for (const m of frame.matchAll(/postToParent\(\{[^}]*\}\)/g)) assert.doesNotMatch(m[0], /token|key|id:/i, m[0]); // UI state only
});

test("frame.html: module script, restrictive CSP, no inline script", () => {
  const html = read("frame.html");
  assert.match(html, /<script type="module" src="\.\/frame\.js"><\/script>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'self'/);
  assert.equal((html.match(/<script/g) || []).length, 1);
});

test("embed.js: iframe referrerpolicy=origin, widget-host URL, strict postMessage origin+source checks, no token in messages", () => {
  const src = read("embed.js");
  assert.match(src, /setAttribute\("referrerpolicy", "origin"\)/);
  assert.match(src, /event\.origin !== widgetOrigin \|\| event\.source !== iframe\.contentWindow/);
  assert.match(src, /widgetOrigin \+ "\/widget\/frame\.html\?key="/);
  assert.doesNotMatch(src, /postMessage\([^)]*["']\*["']/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // ignore comments
  assert.doesNotMatch(code, /token|parent_origin/i);
  assert.match(src, /attachShadow\(\{ mode: "closed" \}\)/);
});

// ---------------------------------------------------------------- loader in a fake DOM
function makeEnv({ lang = "", dir = "", dataLang = null, position = null, key = KEY, src = "https://widget.example.com/widget/embed.js" } = {}) {
  const winListeners = {};
  const el = (tag) => {
    const classes = new Set();
    const e = {
      tagName: tag.toUpperCase(), attrs: {}, children: [], style: { cssText: "", display: "" }, listeners: {}, textContent: "", innerHTML: "", className: "",
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      classList: { toggle(c, on) { on ? classes.add(c) : classes.delete(c); }, contains: (c) => classes.has(c) },
      attachShadow(opts) { this.shadowMode = opts.mode; this.shadow = el("#shadow"); return this.shadow; },
    };
    if (tag === "iframe") e.contentWindow = { posted: [], postMessage(m, o) { this.posted.push([m, o]); } };
    return e;
  };
  const script = { src, getAttribute: (k) => ({ "data-key": key, "data-lang": dataLang, "data-position": position })[k] ?? null };
  const body = el("body");
  const document = {
    currentScript: script,
    body,
    documentElement: { getAttribute: (k) => ({ lang, dir })[k] || null },
    createElement: el,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { location: { href: "https://customer-shop.com/page" }, addEventListener(t, f) { winListeners[t] = f; }, console: { warn() {} } };
  vm.runInNewContext(read("embed.js"), { window, document, navigator: { language: "en-US" }, URL, console: { warn() {} } });
  const host = body.children[0];
  const shadowKids = host ? host.shadow.children : [];
  const panel = shadowKids.find((c) => c.className === "panel");
  const launcher = shadowKids.find((c) => c.className === "launcher");
  const style = shadowKids.find((c) => c.tagName === "STYLE");
  return { window, host, panel, launcher, style, winListeners, click: () => launcher.listeners.click.forEach((f) => f()) };
}

test("loader: launcher in a closed shadow root; iframe created only on open with widget-host URL + referrerpolicy=origin", () => {
  const env = makeEnv();
  assert.ok(env.host && env.host.shadowMode === "closed");
  assert.equal(env.panel.children.length, 0, "no iframe before open");
  env.click();
  const iframe = env.panel.children[0];
  assert.equal(iframe.tagName, "IFRAME");
  assert.equal(iframe.src, `https://widget.example.com/widget/frame.html?key=${KEY}&lang=en`);
  assert.equal(iframe.attrs.referrerpolicy, "origin");
  assert.ok(iframe.title);
  assert.ok(env.panel.classList.contains("open"));
  // (object comes from the vm realm -> compare serialized values)
  assert.equal(JSON.stringify(iframe.contentWindow.posted.at(-1)), JSON.stringify([{ type: "wc:visibility", open: true }, "https://widget.example.com"]));
  assert.doesNotMatch(iframe.src, /customer-shop|origin=|parent/);
});

test("loader: postMessage accepted only from the widget origin AND the iframe window", () => {
  const env = makeEnv();
  env.click();
  const iframe = env.panel.children[0];
  const msg = (origin, source, type) => env.winListeners.message({ origin, source, data: { type } });
  msg("https://evil.com", iframe.contentWindow, "wc:close");
  assert.ok(env.panel.classList.contains("open"), "wrong origin ignored");
  msg("https://widget.example.com", {}, "wc:close");
  assert.ok(env.panel.classList.contains("open"), "wrong source ignored");
  msg("https://widget.example.com", iframe.contentWindow, "wc:close");
  assert.equal(env.panel.classList.contains("open"), false);
  msg("https://widget.example.com", iframe.contentWindow, "wc:unavailable");
  assert.equal(env.host.style.display, "none");
});

test("loader: invalid data-key -> nothing rendered; lang/position resolution (data-lang > html lang/dir) and RTL side", () => {
  assert.equal(makeEnv({ key: "bad" }).host, undefined);
  const ar = makeEnv({ lang: "ar" });
  ar.click();
  assert.match(ar.panel.children[0].src, /&lang=ar$/);
  assert.match(ar.style.textContent, /left:20px/); // RTL default side
  const forced = makeEnv({ lang: "ar", dataLang: "en", position: "right" });
  forced.click();
  assert.match(forced.panel.children[0].src, /&lang=en$/);
  assert.match(forced.style.textContent, /right:20px/);
  const rtlDir = makeEnv({ dir: "rtl" });
  rtlDir.click();
  assert.match(rtlDir.panel.children[0].src, /&lang=ar$/);
});

// ---------------------------------------------------------------- build / platform constraints
test("PWA: widget assets excluded from precache and SPA navigation fallback", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "vite.config.js"), "utf8");
  assert.match(cfg, /globIgnores: \['widget\/\*\*'\]/);
  assert.match(cfg, /navigateFallbackDenylist: \[\/\^\\\/api\\\/\/, \/\^\\\/widget\\\/\/\]/);
});

test("Vercel: still exactly 12 top-level API functions (widget is static)", () => {
  const fns = fs.readdirSync(path.join(ROOT, "api")).filter((n) => n.endsWith(".js"));
  assert.equal(fns.length, 12, fns.join(", "));
});

test("demo page uses the real embed.js (no separate implementation)", () => {
  const demo = read("demo.html");
  assert.match(demo, /s\.src = "\/widget\/embed\.js";/);
  assert.match(demo, /s\.setAttribute\("data-key", key\)/);
  assert.doesNotMatch(demo, /\/api\//);
});
