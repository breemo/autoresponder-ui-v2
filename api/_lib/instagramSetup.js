import crypto from "node:crypto";

import { REPLY_MODE_VALUES, DEFAULT_REPLY_MODE, isReplyModeKey } from "../../src/lib/replyMode.js";

// Instagram manual-setup foundation (web/API only — no OAuth, no
// Multi-Account, no n8n routing in this layer).
//
// Instagram reuses the SAME storage every other non-WhatsApp channel
// uses: a single client_feature_integrations row per (client_id,
// feature_id), with the Instagram settings living in its `config` jsonb.
// No schema change, no client_instagram usage (that Multi-Account Stage 1
// table stays untouched).
//
// MULTI-ACCOUNT READINESS: every Instagram-account-scoped field is listed
// in INSTAGRAM_ACCOUNT_FIELD_KEYS below and is touched ONLY through this
// module (buildInstagramConfigUpdate / redactInstagramConfig /
// extractInstagramAccount / decryptStoredToken). When Instagram later
// moves to a `client_instagram_accounts` table, that manifest maps 1:1 to
// the new columns and only this file's storage target changes — the UI
// (InstagramSetupSection.jsx) and the API contract stay as they are.
// `reply_mode` is intentionally NOT in the manifest: it is a cross-channel
// runtime setting n8n reads uniformly as config.reply_mode for every
// channel, so it stays top-level.
//
// `config` keys this module owns for an Instagram integration:
//   channelKey            - INTERNAL, non-secret, immutable. Set once to
//                           the integration row id. It is the non-secret
//                           identifier the generated webhook URL carries
//                           (…/instagram/<channelKey>) so a later n8n
//                           routing task can resolve the integration
//                           without any secret in the URL. Never shown as
//                           an editable field to the client.
//   verify_token          - cryptographically strong, generated ONCE
//                           server-side, then persisted. Displayed/
//                           copyable to the owning client (they paste it
//                           into Meta). Never regenerated on load or on a
//                           save that doesn't need it.
//   instagram_account_id  - plain identifier, safe to trim/normalize.
//   facebook_page_id      - plain identifier, safe to trim/normalize.
//   page_access_token     - SECRET. Stored ENCRYPTED (AES-256-GCM, key
//                           from the server-only env var
//                           INSTAGRAM_TOKEN_ENC_KEY — never exposed to
//                           Vite/frontend). Even a direct browser read of
//                           client_feature_integrations.config yields only
//                           ciphertext. Still redacted out of every API
//                           read response by redactInstagramConfig() and
//                           replaced with the derived has_page_access_token
//                           flag. Decrypted only by decryptStoredToken(),
//                           a server-only path (future n8n credentials
//                           endpoint) — never returned to the browser.
//   reply_mode            - canonical string, shared with every channel.

// The Instagram-account record inside `config`. This is the set that
// later moves verbatim into `client_instagram_accounts`. `reply_mode` is
// deliberately excluded (cross-channel — stays top-level).
export const INSTAGRAM_ACCOUNT_FIELD_KEYS = [
  "channelKey",
  "verify_token",
  "instagram_account_id",
  "facebook_page_id",
  "page_access_token",
];

// Every spelling of the Page Access Token key that could exist in a
// config jsonb — the new snake_case key plus the legacy field-label
// casing Facebook/Instagram `features.fields` historically used. All of
// these are stripped from read responses.
export const INSTAGRAM_SECRET_CONFIG_KEYS = [
  "page_access_token",
  "access_token",
  "Page Access Token",
  "Access Token",
  "pageAccessToken",
  "accessToken",
];

// ~43 url-safe chars of CSPRNG entropy (32 bytes). Meta only requires the
// verify token to match what you type into the dashboard, so length/shape
// are our choice; this matches the strength of a modern API secret and is
// stronger than the ~12-char invite codes api/_lib/clientUsers.js mints.
export function generateVerifyToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Page Access Token encryption at rest (AES-256-GCM).
//
// Key: process.env.INSTAGRAM_TOKEN_ENC_KEY — a SERVER-ONLY var. It is read
// only here, inside api/ (Vercel serverless), and is NOT prefixed VITE_ so
// Vite never inlines it into the browser bundle. Accepts a 32-byte key as
// base64, base64url, or hex.
//
// Stored form:  "igenc:v1:" + base64url(iv) + ":" + base64url(tag) + ":" + base64url(ciphertext)
// (base64url has no ":" so the split is unambiguous; "v1" allows a future
// key rotation / format bump without guessing.)
// ---------------------------------------------------------------------------
const ENC_PREFIX = "igenc:v1:";

function getEncKey() {
  const raw = process.env.INSTAGRAM_TOKEN_ENC_KEY;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const s = raw.trim();
  for (const enc of ["base64", "hex"]) {
    try {
      const buf = Buffer.from(s, enc);
      if (buf.length === 32) return buf;
    } catch (e) {
      /* try next encoding */
    }
  }
  return null;
}

// Is the encryption key configured and valid (exactly 32 bytes)?
export function isTokenEncryptionAvailable() {
  return getEncKey() !== null;
}

export function isEncryptedToken(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

// Encrypts a plaintext Page Access Token. Throws if the key is missing/
// invalid — callers that might hit that (a fresh token submission) check
// isTokenEncryptionAvailable() first and surface a clean error instead.
export function encryptToken(plaintext) {
  const key = getEncKey();
  if (!key) throw new Error("INSTAGRAM_TOKEN_ENC_KEY is missing or not a 32-byte key");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    ENC_PREFIX +
    iv.toString("base64url") + ":" + tag.toString("base64url") + ":" + ct.toString("base64url")
  );
}

// SERVER-ONLY. Decrypts a stored Page Access Token back to plaintext.
// Intended for a future n8n-facing credentials endpoint — it must NEVER be
// wired into any browser-facing response. Returns null for a value that
// isn't in the encrypted form. Throws on a bad key / tampered ciphertext.
export function decryptStoredToken(stored) {
  if (!isEncryptedToken(stored)) return null;
  const key = getEncKey();
  if (!key) throw new Error("INSTAGRAM_TOKEN_ENC_KEY is missing or not a 32-byte key");
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted token");
  const [ivB, tagB, ctB] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function trimToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// "provided" = the key is present AND not undefined. An explicit null or
// "" still counts as provided (the client cleared the field).
function provided(obj, key) {
  return obj && typeof obj === "object" && obj[key] !== undefined;
}

// Returns a copy of `config` with every secret key removed, plus the
// single derived boolean the UI needs. This is the ONLY shape any read
// path may hand back to the browser for an Instagram integration.
// (The stored token is ciphertext anyway — this is defense in depth.)
export function redactInstagramConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const safe = {};
  let hasPageAccessToken = false;

  for (const [key, value] of Object.entries(source)) {
    if (INSTAGRAM_SECRET_CONFIG_KEYS.includes(key)) {
      if (typeof value === "string" && value.trim() !== "") hasPageAccessToken = true;
      continue;
    }
    safe[key] = value;
  }

  return { config: safe, flags: { has_page_access_token: hasPageAccessToken } };
}

// The Instagram-account view of a config (no secret). Single accessor for
// any server code that needs the account's non-secret fields — keeps the
// "everything Instagram goes through this module" boundary intact for the
// future client_instagram_accounts move.
export function extractInstagramAccount(config) {
  const source = config && typeof config === "object" ? config : {};
  return {
    channelKey: source.channelKey ?? null,
    verify_token: source.verify_token ?? null,
    instagram_account_id: source.instagram_account_id ?? null,
    facebook_page_id: source.facebook_page_id ?? null,
    has_page_access_token: INSTAGRAM_SECRET_CONFIG_KEYS.some(
      (k) => typeof source[k] === "string" && source[k].trim() !== ""
    ),
  };
}

// Reads the currently-stored Page Access Token (ciphertext, or legacy
// plaintext) regardless of key casing. Used inside a save to preserve the
// existing value when the client leaves the field blank.
function readStoredToken(config) {
  const source = config && typeof config === "object" ? config : {};
  for (const key of INSTAGRAM_SECRET_CONFIG_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

// Drops any legacy reply-mode key spelling (e.g. an admin-defined "Reply
// Mode" field label) so a saved config never carries two competing keys
// for the same setting — n8n only ever reads config.reply_mode. Mirrors
// ClientIntegrations.jsx's cleanReplyModeConfig().
function stripLegacyReplyModeKeys(config) {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== "reply_mode" && isReplyModeKey(key)) continue;
    out[key] = value;
  }
  return out;
}

// Builds the new `config` object to persist for an Instagram integration.
//
//   existingConfig  - the row's current config jsonb (may be {})
//   integrationId   - the client_feature_integrations row id (becomes the
//                     immutable internal channelKey)
//   input           - { instagram_account_id, facebook_page_id,
//                       reply_mode, page_access_token }  (all optional)
//
// Returns { config } on success, or { error: "invalid_reply_mode" }.
// Never returns the token to the caller — the caller re-reads nothing and
// responds via redactInstagramConfig().
//
// GO-LIVE NOTE: the Page Access Token is stored as PLAINTEXT in config for
// now, because the current shared n8n Instagram flow reads it directly as
// `config.page_access_token` (identical posture to Facebook's
// config["Page Access Token"] and Telegram's config["Bot Token"] today).
// The AES-256-GCM helpers above (encryptToken / decryptStoredToken) are
// kept, unused, for the later credential-API re-engineering — flipping
// back is a one-line change here. redactInstagramConfig() still keeps the
// token out of every browser/API response regardless.
export function buildInstagramConfigUpdate(existingConfig, integrationId, input = {}) {
  const base = existingConfig && typeof existingConfig === "object" ? { ...existingConfig } : {};

  // reply_mode: validated; blank/omitted keeps the existing value, or the
  // shared default if there is none yet.
  let replyMode = base.reply_mode || DEFAULT_REPLY_MODE;
  if (input.reply_mode !== undefined && input.reply_mode !== null && input.reply_mode !== "") {
    if (!REPLY_MODE_VALUES.includes(input.reply_mode)) return { error: "invalid_reply_mode" };
    replyMode = input.reply_mode;
  }

  // Token resolution (GO-LIVE: plaintext at rest — see the function note).
  //  - a non-blank submission -> store the RAW submitted value verbatim
  //  - blank / omitted        -> keep whatever is already stored
  // trim() is used only to detect a whitespace-only non-submission, never
  // to alter a real credential's bytes.
  const submittedTokenRaw = typeof input.page_access_token === "string" ? input.page_access_token : "";
  const submittedNewToken = submittedTokenRaw.trim() !== "";
  const storedToken = readStoredToken(base);

  let nextToken; // final value to persist, or undefined
  if (submittedNewToken) {
    nextToken = submittedTokenRaw;
  } else if (storedToken) {
    // Keep the existing value as-is. If it happens to be a leftover
    // ciphertext from an earlier build, decrypt it back to plaintext so
    // n8n can use it directly; if that fails, keep it verbatim rather
    // than lose it.
    if (isEncryptedToken(storedToken)) {
      try {
        nextToken = decryptStoredToken(storedToken) || storedToken;
      } catch (e) {
        nextToken = storedToken;
      }
    } else {
      nextToken = storedToken;
    }
  }

  let next = stripLegacyReplyModeKeys(base);

  // Remove every secret-key spelling first, then write the single
  // canonical key — so a legacy "Page Access Token" copy can never linger
  // under a name a future generic reader might miss.
  for (const key of INSTAGRAM_SECRET_CONFIG_KEYS) delete next[key];

  next = {
    ...next,
    channelKey: base.channelKey || integrationId,
    verify_token: base.verify_token || generateVerifyToken(),
    reply_mode: replyMode,
  };

  // Partial-update semantics (same as api/client-facebook.js): a key
  // provided in `input` is written (empty string -> null = cleared); a
  // key omitted from `input` leaves the stored value untouched.
  if (provided(input, "instagram_account_id")) next.instagram_account_id = trimToNull(input.instagram_account_id);
  else if (next.instagram_account_id === undefined) next.instagram_account_id = null;

  if (provided(input, "facebook_page_id")) next.facebook_page_id = trimToNull(input.facebook_page_id);
  else if (next.facebook_page_id === undefined) next.facebook_page_id = null;

  if (nextToken) next.page_access_token = nextToken;

  return { config: next };
}
