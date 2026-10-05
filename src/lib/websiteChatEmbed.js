// Website Chat — pure dashboard helpers for the install snippet and the
// preview link (WebsiteChatSection.jsx). Contract = public/widget/embed.js:
//
//   <script src="https://<auto-responder-host>/widget/embed.js" data-key="wcpk_…" async></script>
//
// Only the PUBLIC widget key is ever used here (it is what the customer
// pastes into their website). The internal channelKey is server-only and
// never reaches the browser.

export const PUBLIC_KEY_RE = /^wcpk_[A-Za-z0-9_-]{32}$/;

export function isPublicKey(value) {
  return typeof value === "string" && PUBLIC_KEY_RE.test(value);
}

// "https://host[:port]" for an http(s) origin, else "".
export function normalizeOrigin(origin) {
  try {
    const url = new URL(String(origin || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

export function buildEmbedSnippet(origin, publicKey) {
  const base = normalizeOrigin(origin);
  if (!base || !isPublicKey(publicKey)) return "";
  return `<script src="${base}/widget/embed.js" data-key="${publicKey}" async></script>`;
}

export function maskPublicKey(publicKey) {
  if (!isPublicKey(publicKey)) return "";
  return `wcpk_••••${publicKey.slice(-4)}`;
}

// The existing DEV/manual test page (public/widget/demo.html).
export function buildPreviewUrl(origin, publicKey, lang) {
  const base = normalizeOrigin(origin);
  if (!base || !isPublicKey(publicKey)) return "";
  const l = `${lang || ""}`.toLowerCase().startsWith("ar") ? "ar" : "en";
  return `${base}/widget/demo.html?key=${encodeURIComponent(publicKey)}&lang=${l}`;
}

// UX hint only (the server is authoritative): would `host` pass the site's
// allowed domains? Mirrors api/_lib/websiteChatDomains.js — exact host,
// "*.example.com" = subdomains only, localhost / 127.0.0.1 explicit.
export function isHostListed(host, allowedDomains) {
  const h = `${host || ""}`.toLowerCase();
  if (!h || !Array.isArray(allowedDomains)) return false;
  return allowedDomains.some((entry) => {
    const d = `${entry || ""}`.toLowerCase();
    if (d.startsWith("*.")) return h.endsWith(d.slice(1)) && h !== d.slice(2);
    return d === h;
  });
}

// Domain textarea/comma input -> trimmed, non-empty entries (the server
// normalizes and validates them).
export function parseDomainsInput(text) {
  return `${text || ""}`
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- Integrations page (ClientIntegrations.jsx) ----------------------
// Website Chat is one channel with N sites (one integration row per site).
// The page shows it as ONE card that renders WebsiteChatSection; it never
// goes through the generic add / set_active / save_config editor.

export const WEBSITE_CHAT_SLUG = "website_chat";
export const WEBSITE_CHAT_CARD_ID = "website_chat";

export function isWebsiteChatSlug(slug) {
  return `${slug || ""}`.toLowerCase() === WEBSITE_CHAT_SLUG;
}

export function websiteChatCard(featureId, sites = []) {
  return {
    id: WEBSITE_CHAT_CARD_ID,
    feature_id: featureId,
    slug: WEBSITE_CHAT_SLUG,
    is_active: sites.some((s) => s && s.is_active === true),
    site_count: sites.length,
    config: {},
  };
}

// Replaces every website_chat row with a single card at the position of
// the first one. `websiteChatFeatureId` also matches rows without a slug.
export function collapseWebsiteChatRows(rows, websiteChatFeatureId) {
  const list = Array.isArray(rows) ? rows : [];
  const isWc = (r) => isWebsiteChatSlug(r?.slug) || (!!websiteChatFeatureId && r?.feature_id === websiteChatFeatureId);
  const wcRows = list.filter(isWc);
  if (wcRows.length === 0) return list;
  const out = [];
  let inserted = false;
  for (const r of list) {
    if (!isWc(r)) out.push(r);
    else if (!inserted) {
      out.push(websiteChatCard(wcRows[0].feature_id, wcRows));
      inserted = true;
    }
  }
  return out;
}
