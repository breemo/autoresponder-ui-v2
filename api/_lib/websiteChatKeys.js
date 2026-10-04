import crypto from "node:crypto";

// Website Chat key/token primitives. No secrets are introduced: tokens are
// high-entropy random values stored only as SHA-256 hashes, and the IP hash
// key is derived from the existing server-only SUPABASE_SERVICE_ROLE_KEY.

const PUBLIC_KEY_PREFIX = "wcpk_";
const CHANNEL_KEY_PREFIX = "wc_";

const randomToken = (bytes) => crypto.randomBytes(bytes).toString("base64url");

// Embed-snippet key: public, globally unique (DB unique index), 24 random bytes.
export function generatePublicKey() {
  return PUBLIC_KEY_PREFIX + randomToken(24);
}

// Internal routing key (n8n client_feature lookup + Conversation V2
// channel_key). Never returned to browsers.
export function generateChannelKey() {
  return CHANNEL_KEY_PREFIX + randomToken(24);
}

export function isPublicKeyFormat(value) {
  return typeof value === "string" && /^wcpk_[A-Za-z0-9_-]{32}$/.test(value);
}

// Visitor bearer token (32 random bytes). Only hashToken(token) is stored.
export function generateVisitorToken() {
  return randomToken(32);
}

export function isVisitorTokenFormat(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

// Keyed hash of the caller IP for the per-IP session limit. Returns null
// when no key material or IP is available (the limit is then skipped for
// that request rather than sharing one global bucket).
export function hashIp(ip, secret = process.env.SUPABASE_SERVICE_ROLE_KEY) {
  if (!ip || !secret) return null;
  const key = crypto.createHash("sha256").update("website-chat-ip-hash-v1:" + secret).digest();
  return crypto.createHmac("sha256", key).update(String(ip)).digest("hex");
}

export function clientIpFromRequest(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  const first = typeof fwd === "string" ? fwd.split(",")[0].trim() : "";
  const real = typeof req.headers?.["x-real-ip"] === "string" ? req.headers["x-real-ip"].trim() : "";
  return first || real || req.socket?.remoteAddress || null;
}

export function bearerTokenFromRequest(req) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}
