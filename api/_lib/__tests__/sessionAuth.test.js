import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_FAILURE,
  extractBearerToken,
  verifySessionToken,
  resolveSessionIdentity,
  resolveActorUserId,
  createSupabaseAuthVerifier,
  authFailureStatus,
} from "../sessionAuth.js";

// Security S3 foundation: verified-session identity helpers. These are
// isolated and unused by endpoints until Supabase Auth is live.

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

const req = (authorization) => ({ headers: authorization === undefined ? {} : { authorization } });

// Test verifier: accepts tokens of the form "valid:<userId>:<expSeconds>".
const fakeVerifier = async (token) => {
  const [kind, userId, exp] = token.split(":");
  if (kind === "valid") return { userId, expiresAt: exp ? Number(exp) : undefined };
  if (kind === "expired") {
    const err = new Error("jwt expired");
    err.authReason = AUTH_FAILURE.EXPIRED;
    throw err;
  }
  throw new Error("bad signature");
};
const opts = (extra = {}) => ({ verifier: fakeVerifier, nowMs: NOW_MS, ...extra });

// ---- extractBearerToken ---------------------------------------------------

test("missing / blank Authorization header -> missing_token", () => {
  assert.deepEqual(extractBearerToken(req()), { ok: false, reason: AUTH_FAILURE.MISSING });
  assert.deepEqual(extractBearerToken(req("   ")), { ok: false, reason: AUTH_FAILURE.MISSING });
  assert.deepEqual(extractBearerToken({}), { ok: false, reason: AUTH_FAILURE.MISSING });
});

test("non-Bearer or malformed header -> malformed_token", () => {
  for (const h of ["Basic abc", "Bearer", "Bearer ", "Bearer a b", "token abc", "abc"]) {
    assert.deepEqual(extractBearerToken(req(h)), { ok: false, reason: AUTH_FAILURE.MALFORMED }, h);
  }
  assert.equal(extractBearerToken(req(`Bearer ${"x".repeat(9000)}`)).reason, AUTH_FAILURE.MALFORMED);
});

test("Bearer token is extracted (case-insensitive scheme, Fetch Headers too)", () => {
  assert.deepEqual(extractBearerToken(req("Bearer abc.def.ghi")), { ok: true, token: "abc.def.ghi" });
  assert.deepEqual(extractBearerToken(req("bearer abc")), { ok: true, token: "abc" });
  const headers = new Headers({ Authorization: "Bearer xyz" });
  assert.deepEqual(extractBearerToken({ headers }), { ok: true, token: "xyz" });
});

test("tokens are never read from query or body", () => {
  const r = { headers: {}, query: { access_token: "valid:u1" }, body: { token: "valid:u1" } };
  assert.equal(extractBearerToken(r).ok, false);
});

// ---- verifySessionToken ---------------------------------------------------

test("no verifier configured -> verifier_unavailable (token is never trusted)", async () => {
  assert.deepEqual(await verifySessionToken("valid:u1"), { ok: false, reason: AUTH_FAILURE.VERIFIER_UNAVAILABLE });
});

test("invalid token (verifier throws / returns nothing) -> invalid_token", async () => {
  assert.equal((await verifySessionToken("forged", opts())).reason, AUTH_FAILURE.INVALID);
  assert.equal((await verifySessionToken("t", opts({ verifier: async () => null }))).reason, AUTH_FAILURE.INVALID);
  assert.equal((await verifySessionToken("t", opts({ verifier: async () => ({ userId: "" }) }))).reason, AUTH_FAILURE.INVALID);
  assert.equal((await verifySessionToken("t", opts({ verifier: async () => ({ userId: 42 }) }))).reason, AUTH_FAILURE.INVALID);
});

test("expired token -> expired_token (verifier-reported or by expiresAt)", async () => {
  assert.equal((await verifySessionToken("expired:u1", opts())).reason, AUTH_FAILURE.EXPIRED);
  assert.equal((await verifySessionToken(`valid:u1:${NOW_S - 1}`, opts())).reason, AUTH_FAILURE.EXPIRED);
  assert.equal((await verifySessionToken(`valid:u1:${NOW_S}`, opts())).reason, AUTH_FAILURE.EXPIRED);
  assert.equal((await verifySessionToken("valid:u1:NaN", opts())).reason, AUTH_FAILURE.INVALID);
});

test("valid token -> verified userId", async () => {
  assert.deepEqual(await verifySessionToken(`valid:u1:${NOW_S + 60}`, opts()), { ok: true, userId: "u1", expiresAt: NOW_S + 60 });
});

// ---- resolveSessionIdentity ----------------------------------------------

test("identity: absent header -> absent; bad tokens -> rejected", async () => {
  assert.deepEqual(await resolveSessionIdentity(req(), opts()), { status: "absent" });
  assert.deepEqual(await resolveSessionIdentity(req("Basic x"), opts()), { status: "rejected", reason: AUTH_FAILURE.MALFORMED });
  assert.deepEqual(await resolveSessionIdentity(req("Bearer forged"), opts()), { status: "rejected", reason: AUTH_FAILURE.INVALID });
  assert.deepEqual(await resolveSessionIdentity(req("Bearer expired:u1"), opts()), { status: "rejected", reason: AUTH_FAILURE.EXPIRED });
  assert.deepEqual(await resolveSessionIdentity(req("Bearer valid:u1"), {}), {
    status: "rejected",
    reason: AUTH_FAILURE.VERIFIER_UNAVAILABLE,
  });
});

test("identity: mismatched actor_user_id -> actor_mismatch", async () => {
  const r = await resolveSessionIdentity(req("Bearer valid:u1"), opts({ claimedActorUserId: "u2" }));
  assert.deepEqual(r, { status: "rejected", reason: AUTH_FAILURE.ACTOR_MISMATCH });
  assert.equal(authFailureStatus(r.reason), 403);
});

test("identity: matching or omitted actor_user_id -> verified", async () => {
  assert.deepEqual(await resolveSessionIdentity(req("Bearer valid:u1"), opts({ claimedActorUserId: "u1" })), { status: "verified", userId: "u1" });
  assert.deepEqual(await resolveSessionIdentity(req("Bearer valid:u1"), opts()), { status: "verified", userId: "u1" });
});

// ---- resolveActorUserId (migration path) ---------------------------------

test("compat mode: no token keeps the legacy actor_user_id path", async () => {
  assert.deepEqual(await resolveActorUserId(req(), opts({ claimedActorUserId: "u9" })), { ok: true, actorUserId: "u9", source: "legacy" });
  assert.deepEqual(await resolveActorUserId(req(), opts()), { ok: false, reason: AUTH_FAILURE.MISSING });
});

test("compat mode: a presented but unverifiable token never falls back to legacy", async () => {
  for (const h of ["Bearer forged", "Bearer expired:u1", "Basic x", `Bearer valid:u9:${NOW_S - 5}`]) {
    const r = await resolveActorUserId(req(h), opts({ claimedActorUserId: "u9" }));
    assert.equal(r.ok, false, h);
    assert.equal(authFailureStatus(r.reason), 401, h);
  }
  const noVerifier = await resolveActorUserId(req("Bearer valid:u9"), { claimedActorUserId: "u9" });
  assert.deepEqual(noVerifier, { ok: false, reason: AUTH_FAILURE.VERIFIER_UNAVAILABLE });
});

test("compat mode: verified token wins; spoofed actor_user_id is rejected", async () => {
  assert.deepEqual(await resolveActorUserId(req("Bearer valid:u1"), opts()), { ok: true, actorUserId: "u1", source: "session" });
  assert.deepEqual(await resolveActorUserId(req("Bearer valid:u1"), opts({ claimedActorUserId: "admin-1" })), {
    ok: false,
    reason: AUTH_FAILURE.ACTOR_MISMATCH,
  });
});

test("enforce mode: missing token is rejected even with actor_user_id", async () => {
  assert.deepEqual(await resolveActorUserId(req(), opts({ claimedActorUserId: "u1", enforce: true })), { ok: false, reason: AUTH_FAILURE.MISSING });
  assert.deepEqual(await resolveActorUserId(req("Bearer valid:u1"), opts({ enforce: true })), { ok: true, actorUserId: "u1", source: "session" });
});

// ---- Supabase Auth verifier adapter (future) ------------------------------

test("createSupabaseAuthVerifier maps getUser() results and errors", async () => {
  const ok = createSupabaseAuthVerifier({ auth: { getUser: async () => ({ data: { user: { id: "auth-1" } }, error: null }) } });
  assert.deepEqual(await verifySessionToken("t", { verifier: ok }), { ok: true, userId: "auth-1", expiresAt: null });
  const bad = createSupabaseAuthVerifier({ auth: { getUser: async () => ({ data: { user: null }, error: { message: "invalid JWT" } }) } });
  assert.equal((await verifySessionToken("t", { verifier: bad })).reason, AUTH_FAILURE.INVALID);
});

// ---- Isolation / compatibility guard -------------------------------------

test("sessionAuth is not imported by any endpoint yet (actor_user_id path unchanged)", () => {
  const files = [
    ...fs.readdirSync(API_DIR).filter((f) => f.endsWith(".js")).map((f) => path.join(API_DIR, f)),
    ...fs.readdirSync(path.join(API_DIR, "_lib")).filter((f) => f.endsWith(".js") && f !== "sessionAuth.js").map((f) => path.join(API_DIR, "_lib", f)),
  ];
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /sessionAuth/, path.relative(API_DIR, f));
  }
});
