// Security S3 foundation — verified-session identity for browser-facing APIs.
//
// STATUS: PREPARATION ONLY. Nothing under api/ imports this module yet, and
// it must stay that way until the app issues real authenticated sessions
// (Supabase Auth migration). Today every browser-facing endpoint still
// resolves the actor from the client-supplied `actor_user_id` through
// clientAuthz.js; that path is unchanged and S3 is NOT remediated.
//
// Trust rules this module enforces:
//   - A token is an identity ONLY after a verifier has positively verified
//     it. There is no code path that turns an unverified, malformed,
//     expired or unverifiable token into an identity.
//   - With no verifier configured, a presented token is REJECTED
//     ("verifier_unavailable"), never ignored and never trusted.
//   - When a verified identity and a claimed `actor_user_id` disagree, the
//     request is rejected ("actor_mismatch").
//
// Migration path (see resolveActorUserId):
//   1. now        — module unused; endpoints trust actor_user_id.
//   2. compat     — endpoints call resolveActorUserId({ enforce: false }):
//                   requests WITH a token must verify and match; requests
//                   WITHOUT a token keep the legacy actor_user_id path.
//   3. enforce    — resolveActorUserId({ enforce: true }): a verified token
//                   is mandatory and actor_user_id is ignored or must match.

export const AUTH_FAILURE = Object.freeze({
  MISSING: "missing_token",
  MALFORMED: "malformed_token",
  INVALID: "invalid_token",
  EXPIRED: "expired_token",
  VERIFIER_UNAVAILABLE: "verifier_unavailable",
  ACTOR_MISMATCH: "actor_mismatch",
});

// Upper bound so a hostile header can't make us hash/parse megabytes.
const MAX_TOKEN_LENGTH = 8192;

function readHeader(req, name) {
  const headers = req?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Extracts a Bearer token from the Authorization header. Never reads tokens
// from the query string or body (they leak into logs and history).
//   -> { ok: true, token } | { ok: false, reason: MISSING | MALFORMED }
export function extractBearerToken(req) {
  const raw = readHeader(req, "authorization");
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: false, reason: AUTH_FAILURE.MISSING };
  }

  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(String(raw));
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: AUTH_FAILURE.MALFORMED };
  }
  return { ok: true, token: match[1] };
}

// Verifies a token with an injected verifier.
//
// A verifier is `async (token) => ({ userId, expiresAt? })` and throws or
// returns a falsy/incomplete result on failure (an error carrying
// `authReason: AUTH_FAILURE.EXPIRED` is reported as expired). `expiresAt` is epoch
// seconds; when present it is re-checked here so a verifier that forgets
// expiry still cannot admit an expired session.
//   -> { ok: true, userId, expiresAt } | { ok: false, reason }
export async function verifySessionToken(token, { verifier, nowMs = Date.now() } = {}) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: AUTH_FAILURE.MISSING };
  }
  if (typeof verifier !== "function") {
    return { ok: false, reason: AUTH_FAILURE.VERIFIER_UNAVAILABLE };
  }

  let result;
  try {
    result = await verifier(token);
  } catch (err) {
    return { ok: false, reason: err?.authReason === AUTH_FAILURE.EXPIRED ? AUTH_FAILURE.EXPIRED : AUTH_FAILURE.INVALID };
  }

  const userId = result?.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    return { ok: false, reason: AUTH_FAILURE.INVALID };
  }

  const expiresAt = result.expiresAt ?? null;
  if (expiresAt !== null) {
    if (!Number.isFinite(expiresAt)) return { ok: false, reason: AUTH_FAILURE.INVALID };
    if (nowMs >= expiresAt * 1000) return { ok: false, reason: AUTH_FAILURE.EXPIRED };
  }

  return { ok: true, userId, expiresAt };
}

// Centralized identity resolution from a verified session.
//   -> { status: "verified", userId }
//    | { status: "absent" }                 no Authorization header at all
//    | { status: "rejected", reason }       token present but not acceptable
// If `claimedActorUserId` is given it must equal the verified userId.
export async function resolveSessionIdentity(req, { verifier, claimedActorUserId, nowMs } = {}) {
  const extracted = extractBearerToken(req);
  if (!extracted.ok) {
    return extracted.reason === AUTH_FAILURE.MISSING
      ? { status: "absent" }
      : { status: "rejected", reason: extracted.reason };
  }

  const verified = await verifySessionToken(extracted.token, { verifier, nowMs });
  if (!verified.ok) return { status: "rejected", reason: verified.reason };

  if (claimedActorUserId !== undefined && claimedActorUserId !== null && claimedActorUserId !== "") {
    if (String(claimedActorUserId) !== verified.userId) {
      return { status: "rejected", reason: AUTH_FAILURE.ACTOR_MISMATCH };
    }
  }

  return { status: "verified", userId: verified.userId };
}

// Migration-path decision: which actor id may an endpoint pass to
// resolveActingMembership / resolveActingAdmin?
//   -> { ok: true, actorUserId, source: "session" | "legacy" }
//    | { ok: false, reason }
// `enforce: false` keeps the legacy actor_user_id path ONLY when no token
// was sent at all; a token that was sent but fails is always a rejection.
export async function resolveActorUserId(req, { verifier, claimedActorUserId, enforce = false, nowMs } = {}) {
  const identity = await resolveSessionIdentity(req, { verifier, claimedActorUserId, nowMs });

  if (identity.status === "verified") {
    return { ok: true, actorUserId: identity.userId, source: "session" };
  }
  if (identity.status === "rejected") {
    return { ok: false, reason: identity.reason };
  }
  if (enforce) {
    return { ok: false, reason: AUTH_FAILURE.MISSING };
  }
  return claimedActorUserId
    ? { ok: true, actorUserId: String(claimedActorUserId), source: "legacy" }
    : { ok: false, reason: AUTH_FAILURE.MISSING };
}

// Future verifier for Supabase Auth access tokens. Not wired anywhere: the
// app does not issue Supabase Auth sessions yet. NOTE: the returned userId
// is the auth.users id — mapping it to public.users.id is an open
// migration decision (S2) and must be settled before this is used.
export function createSupabaseAuthVerifier(supabase) {
  return async (token) => {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) throw new Error("invalid session");
    return { userId: data.user.id };
  };
}

export function authFailureStatus(reason) {
  return reason === AUTH_FAILURE.ACTOR_MISMATCH ? 403 : 401;
}
