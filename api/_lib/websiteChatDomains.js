import { WEBSITE_CHAT_LIMITS } from "./websiteChatLimits.js";

// Website Chat allowed-domain handling (server-side).
//
// Stored entries are normalized hostnames:
//   "example.com"      exact host only (NOT www.example.com)
//   "*.example.com"    any subdomain of example.com (NOT example.com itself)
//   "localhost" / "127.0.0.1"  explicit local testing, any port
// Scheme, path, query and port are stripped. IP addresses other than
// 127.0.0.1 are rejected. Nothing is allowed implicitly.

const LABEL = "(?!-)[a-z0-9-]{1,63}(?<!-)";
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,62}$`);
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function isValidHost(host) {
  if (LOCAL_HOSTS.has(host)) return true;
  if (IPV4_RE.test(host) || host.includes(":")) return false; // other IPs / IPv6
  return host.length <= 253 && HOSTNAME_RE.test(host);
}

// Normalizes one admin-entered entry. Returns the normalized string or null.
export function normalizeDomainEntry(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split(/[/?#]/)[0]; // path / query / fragment
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/\.$/, ""); // trailing dot
  if (s.includes("@")) return null;
  let wildcard = false;
  if (s.startsWith("*.")) {
    wildcard = true;
    s = s.slice(2);
  }
  if (s.includes("*")) return null;
  if (!isValidHost(s)) return null;
  if (wildcard && LOCAL_HOSTS.has(s)) return null;
  return wildcard ? `*.${s}` : s;
}

// Validates a whole list. { ok, domains, invalid }
export function normalizeAllowedDomains(list) {
  if (!Array.isArray(list)) return { ok: false, domains: [], invalid: [], reason: "not_a_list" };
  const domains = [];
  const invalid = [];
  for (const entry of list) {
    const n = normalizeDomainEntry(entry);
    if (!n) invalid.push(entry);
    else if (!domains.includes(n)) domains.push(n);
  }
  if (invalid.length) return { ok: false, domains, invalid, reason: "invalid_entries" };
  if (domains.length > WEBSITE_CHAT_LIMITS.MAX_ALLOWED_DOMAINS) return { ok: false, domains, invalid, reason: "too_many" };
  return { ok: true, domains, invalid };
}

// Host (lowercase, no port) of an origin/URL string, or null.
export function hostFromOrigin(origin) {
  if (typeof origin !== "string" || !origin.trim()) return null;
  try {
    const u = new URL(origin.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

export function isHostAllowed(host, allowedDomains) {
  if (typeof host !== "string" || !host || !Array.isArray(allowedDomains)) return false;
  const h = host.toLowerCase();
  for (const entry of allowedDomains) {
    if (typeof entry !== "string") continue;
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (h.endsWith("." + base) && h.length > base.length + 1) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}
