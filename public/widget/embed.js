/*
 * Website Chat — embed loader (runs on the customer's website).
 *
 *   <script src="https://<auto-responder-host>/widget/embed.js" data-key="wcpk_…" async></script>
 *   optional: data-lang="ar|en"  data-position="left|right"
 *
 * Renders a floating launcher (inside a closed Shadow DOM, isolated from host
 * styles) and, on first open, an iframe served by the Auto Responder host.
 * The iframe derives the parent origin from browser-provided values only;
 * this loader never sends it (nor any token/identifier) to the iframe.
 */
(function () {
  "use strict";

  var script =
    document.currentScript ||
    (function () {
      var list = document.querySelectorAll('script[src*="/widget/embed.js"][data-key]');
      return list.length ? list[list.length - 1] : null;
    })();
  if (!script) return;

  var publicKey = (script.getAttribute("data-key") || "").trim();
  if (!/^wcpk_[A-Za-z0-9_-]{32}$/.test(publicKey)) {
    if (window.console) console.warn("[website-chat] missing or invalid data-key");
    return;
  }

  var widgetOrigin;
  try {
    widgetOrigin = new URL(script.src, window.location.href).origin;
  } catch (e) {
    return;
  }

  var registry = (window.__websiteChatWidgets = window.__websiteChatWidgets || {});
  if (registry[publicKey]) return; // already loaded for this key
  registry[publicKey] = true;

  function pickLang() {
    var candidates = [
      script.getAttribute("data-lang"),
      document.documentElement.getAttribute("lang"),
      document.documentElement.getAttribute("dir") === "rtl" ? "ar" : "",
      navigator.language,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var v = (candidates[i] || "").toLowerCase();
      if (v.indexOf("ar") === 0) return "ar";
      if (v.indexOf("en") === 0) return "en";
    }
    return "en";
  }
  var lang = pickLang();
  var dataPos = (script.getAttribute("data-position") || "").toLowerCase();
  var side = dataPos === "left" || dataPos === "right" ? dataPos : lang === "ar" ? "left" : "right";
  var labels = lang === "ar" ? { open: "فتح المحادثة", title: "نافذة المحادثة" } : { open: "Open chat", title: "Chat window" };

  var host = document.createElement("div");
  host.setAttribute("data-website-chat", "");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483646;bottom:0;" + side + ":0;";
  var shadow = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;

  var style = document.createElement("style");
  style.textContent =
    ":host{all:initial}" +
    ".launcher{position:fixed;bottom:20px;" + side + ":20px;width:56px;height:56px;border-radius:50%;border:0;" +
    "background:#4f46e5;color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(15,23,42,.25);display:flex;" +
    "align-items:center;justify-content:center;padding:0}" +
    ".launcher:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}" +
    ".launcher svg{width:26px;height:26px}" +
    ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:#ef4444;" +
    "color:#fff;font:700 11px/18px system-ui,sans-serif;text-align:center;padding:0 5px;display:none}" +
    ".panel{position:fixed;bottom:88px;" + side + ":20px;width:370px;height:560px;max-width:calc(100vw - 24px);" +
    "max-height:calc(100vh - 110px);border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,.3);" +
    "background:#fff;display:none}" +
    ".panel.open{display:block}" +
    ".panel iframe{width:100%;height:100%;border:0;display:block}" +
    "@media (max-width:480px){.panel{bottom:0;" + side + ":0;width:100vw;height:100%;max-width:100vw;max-height:100vh;border-radius:0}}";

  var launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "launcher";
  launcher.setAttribute("aria-label", labels.open);
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  var badge = document.createElement("span");
  badge.className = "badge";
  launcher.appendChild(badge);

  var panel = document.createElement("div");
  panel.className = "panel";
  var iframe = null;
  var isOpen = false;

  function sendVisibility() {
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: "wc:visibility", open: isOpen }, widgetOrigin);
    }
  }

  function ensureIframe() {
    if (iframe) return;
    iframe = document.createElement("iframe");
    iframe.title = labels.title;
    iframe.setAttribute("referrerpolicy", "origin");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    iframe.setAttribute("allow", "");
    iframe.src =
      widgetOrigin + "/widget/frame.html?key=" + encodeURIComponent(publicKey) + "&lang=" + encodeURIComponent(lang);
    panel.appendChild(iframe);
  }

  function setOpen(open) {
    isOpen = open;
    if (open) ensureIframe();
    panel.classList.toggle("open", open);
    launcher.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) setBadge(0);
    sendVisibility();
  }

  function setBadge(count) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.style.display = count > 0 ? "block" : "none";
  }

  launcher.addEventListener("click", function () {
    setOpen(!isOpen);
  });

  // frame -> loader: UI state only. Strict origin + source checks.
  window.addEventListener("message", function (event) {
    if (!iframe || event.origin !== widgetOrigin || event.source !== iframe.contentWindow) return;
    var data = event.data || {};
    if (data.type === "wc:close") setOpen(false);
    else if (data.type === "wc:ready") sendVisibility();
    else if (data.type === "wc:unread") setBadge(isOpen ? 0 : Number(data.count) || 0);
    else if (data.type === "wc:unavailable") host.style.display = "none";
  });

  shadow.appendChild(style);
  shadow.appendChild(panel);
  shadow.appendChild(launcher);

  function mount() {
    (document.body || document.documentElement).appendChild(host);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
