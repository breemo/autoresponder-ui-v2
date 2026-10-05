import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Key present so the (still-exported, currently dormant) AES helpers can
// be exercised directly. buildInstagramConfigUpdate does NOT use them and
// does NOT require the key — the token is stored plaintext for go-live.
process.env.INSTAGRAM_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64");

const {
  generateVerifyToken,
  redactInstagramConfig,
  buildInstagramConfigUpdate,
  extractInstagramAccount,
  encryptToken,
  decryptStoredToken,
  isEncryptedToken,
  isTokenEncryptionAvailable,
  INSTAGRAM_SECRET_CONFIG_KEYS,
  INSTAGRAM_ACCOUNT_FIELD_KEYS,
} = await import("../instagramSetup.js");

const ROW_ID = "11111111-2222-3333-4444-555555555555";

test("generateVerifyToken: strong, url-safe, unique per call", () => {
  const a = generateVerifyToken();
  const b = generateVerifyToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{40,}$/);
});

// --- dormant AES helpers (kept for the later credential-API work) -----------
test("AES helpers: round-trip, ciphertext != plaintext, random IV", () => {
  assert.equal(isTokenEncryptionAvailable(), true);
  const enc = encryptToken("EAAG_super_secret_token");
  assert.equal(isEncryptedToken(enc), true);
  assert.equal(enc.includes("EAAG_super_secret_token"), false);
  assert.equal(decryptStoredToken(enc), "EAAG_super_secret_token");
  assert.notEqual(encryptToken("x"), encryptToken("x"));
});

test("decryptStoredToken: null for non-encrypted input, throws on tamper", () => {
  assert.equal(decryptStoredToken("plain"), null);
  assert.equal(decryptStoredToken(undefined), null);
  const enc = encryptToken("abc");
  assert.throws(() => decryptStoredToken(enc.slice(0, -2) + (enc.endsWith("AA") ? "BB" : "AA")));
});

// --- redaction (unchanged posture: token never leaves the server) ----------
test("redactInstagramConfig: strips every secret key spelling, keeps the rest", () => {
  const { config, flags } = redactInstagramConfig({
    channelKey: ROW_ID,
    verify_token: "vt_123",
    instagram_account_id: "1789",
    facebook_page_id: "9981",
    reply_mode: "ai",
    page_access_token: "PLAINTEXT_TOKEN",
    "Page Access Token": "LEGACY_TOKEN",
  });
  for (const k of INSTAGRAM_SECRET_CONFIG_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(config, k), false);
  }
  assert.equal(config.verify_token, "vt_123");
  assert.equal(config.instagram_account_id, "1789");
  assert.deepEqual(flags, { has_page_access_token: true });
});

test("redactInstagramConfig: has_page_access_token false when no/blank token", () => {
  assert.equal(redactInstagramConfig({}).flags.has_page_access_token, false);
  assert.equal(redactInstagramConfig({ page_access_token: "   " }).flags.has_page_access_token, false);
});

// --- buildInstagramConfigUpdate (go-live: PLAINTEXT token at rest) ---------
test("first save: immutable channelKey + persistent verify_token + PLAINTEXT token", () => {
  const { config } = buildInstagramConfigUpdate({}, ROW_ID, {
    instagram_account_id: "1789",
    facebook_page_id: "9981",
    reply_mode: "ai",
    page_access_token: "EAAG_TOKEN_1",
  });
  assert.equal(config.channelKey, ROW_ID);
  assert.match(config.verify_token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(config.reply_mode, "ai");
  assert.equal(config.instagram_account_id, "1789");
  assert.equal(config.facebook_page_id, "9981");
  assert.equal(config.page_access_token, "EAAG_TOKEN_1"); // usable by n8n directly
  assert.equal(isEncryptedToken(config.page_access_token), false);
});

test("first save works with NO encryption key configured", () => {
  const saved = process.env.INSTAGRAM_TOKEN_ENC_KEY;
  delete process.env.INSTAGRAM_TOKEN_ENC_KEY;
  try {
    const { config, error } = buildInstagramConfigUpdate({}, ROW_ID, { page_access_token: "T" });
    assert.equal(error, undefined);
    assert.equal(config.page_access_token, "T");
  } finally {
    process.env.INSTAGRAM_TOKEN_ENC_KEY = saved;
  }
});

test("verify_token and channelKey never change on later saves", () => {
  const existing = { channelKey: ROW_ID, verify_token: "STABLE_VT", reply_mode: "ai" };
  const { config } = buildInstagramConfigUpdate(existing, "different-id", {
    instagram_account_id: "1789",
    reply_mode: "auto",
  });
  assert.equal(config.verify_token, "STABLE_VT");
  assert.equal(config.channelKey, ROW_ID);
  assert.equal(config.reply_mode, "auto");
});

test("blank token preserves the stored value; raw bytes of a new token are kept", () => {
  const existing = { channelKey: ROW_ID, verify_token: "VT", page_access_token: "KEEP_ME" };
  const kept = buildInstagramConfigUpdate(existing, ROW_ID, { page_access_token: "   " }).config;
  assert.equal(kept.page_access_token, "KEEP_ME");

  const replaced = buildInstagramConfigUpdate(existing, ROW_ID, { page_access_token: "  NEW_RAW  " }).config;
  assert.equal(replaced.page_access_token, "  NEW_RAW  ");
});

test("a leftover ciphertext store is decrypted back to plaintext on save", () => {
  const existing = { channelKey: ROW_ID, verify_token: "VT", page_access_token: encryptToken("OLD_PLAIN") };
  const { config } = buildInstagramConfigUpdate(existing, ROW_ID, { instagram_account_id: "1" });
  assert.equal(config.page_access_token, "OLD_PLAIN");
});

test("legacy 'Page Access Token' key is folded into the canonical plaintext key", () => {
  const existing = { channelKey: ROW_ID, verify_token: "VT", "Page Access Token": "LEGACY" };
  const { config } = buildInstagramConfigUpdate(existing, ROW_ID, { instagram_account_id: "1" });
  assert.equal(Object.prototype.hasOwnProperty.call(config, "Page Access Token"), false);
  assert.equal(config.page_access_token, "LEGACY");
});

test("omitted identifier keeps stored value; explicit '' clears it", () => {
  const existing = { channelKey: ROW_ID, verify_token: "VT", instagram_account_id: "1789", facebook_page_id: "99" };
  const kept = buildInstagramConfigUpdate(existing, ROW_ID, { reply_mode: "ai" }).config;
  assert.equal(kept.instagram_account_id, "1789");
  const cleared = buildInstagramConfigUpdate(existing, ROW_ID, { instagram_account_id: "" }).config;
  assert.equal(cleared.instagram_account_id, null);
  assert.equal(cleared.facebook_page_id, "99");
});

test("rejects an invalid reply_mode", () => {
  assert.equal(buildInstagramConfigUpdate({}, ROW_ID, { reply_mode: "bogus" }).error, "invalid_reply_mode");
});

test("the token never survives into a redacted API response", () => {
  const { config } = buildInstagramConfigUpdate({}, ROW_ID, { page_access_token: "PLAINTEXT_SECRET" });
  const { config: safe, flags } = redactInstagramConfig(config);
  assert.equal(JSON.stringify(safe).includes("PLAINTEXT_SECRET"), false);
  assert.equal(flags.has_page_access_token, true);
});

test("extractInstagramAccount: non-secret account view; manifest excludes reply_mode", () => {
  const acc = extractInstagramAccount({
    channelKey: ROW_ID,
    verify_token: "VT",
    instagram_account_id: "1789",
    facebook_page_id: "99",
    reply_mode: "ai",
    page_access_token: "SECRET",
  });
  assert.deepEqual(acc, {
    channelKey: ROW_ID,
    verify_token: "VT",
    instagram_account_id: "1789",
    facebook_page_id: "99",
    has_page_access_token: true,
  });
  assert.equal(INSTAGRAM_ACCOUNT_FIELD_KEYS.includes("reply_mode"), false);
  assert.equal(INSTAGRAM_ACCOUNT_FIELD_KEYS.includes("page_access_token"), true);
});
