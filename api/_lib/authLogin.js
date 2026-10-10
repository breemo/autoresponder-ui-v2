import crypto from "node:crypto";
import { getSupabaseServerClient } from "./supabaseServer.js";

// Security C2 — server-side login (TRANSITIONAL).
//
// Replaces the browser's direct `users` query
// (`.eq("email").eq("password")` with the anon key) in src/pages/Login.jsx.
// Credentials are verified here with the service-role client and only a
// sanitized user/membership object is returned.
//
// What this does NOT do:
//   - It issues no session or token. The browser still keeps the same
//     localStorage user as before, and every other API still trusts the
//     client-supplied actor_user_id (S3 is not remediated).
//   - It still compares the LEGACY PLAINTEXT `users.password` column
//     (SEC-3). Password hashing / Supabase Auth is a later step.
//   - It does not revoke the anon grants on `users` (SEC-1 stays open
//     until that DB change is approved and applied separately).
//
// Dispatched from api/client-router.js (?resource=login) to stay within
// the 12-function Vercel Hobby cap.
//
//   POST /api/client-router?resource=login   { email, password }
//   200 { success: true, user }
//   400 invalid_request | 401 invalid_credentials | 403 no_membership |
//   403 account_disabled | 405 | 429 rate_limited | 500 server_error |
//   503 server_unavailable

const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1024;
// The lookup is by exact email (same as the old browser query); a few rows
// are fetched so duplicate-email rows behave as before (the one whose
// password matches wins).
const MAX_EMAIL_ROWS = 5;

export const LOGIN_ERROR = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  INVALID_CREDENTIALS: "invalid_credentials",
  NO_MEMBERSHIP: "no_membership",
  ACCOUNT_DISABLED: "account_disabled",
  RATE_LIMITED: "rate_limited",
  SERVER_ERROR: "server_error",
  SERVER_UNAVAILABLE: "server_unavailable",
});

// ---- response sanitization -------------------------------------------

// Any column whose name looks like a credential is dropped. The `users`
// row is read with select("*") so the returned shape matches what the
// browser cached before (all non-credential columns); this denylist keeps
// any current or future credential column out of the response.
const SENSITIVE_KEY_PATTERN = /password|passwd|secret|token|hash|api_?key|private_?key|salt/i;
const ALLOWED_FLAG_KEYS = new Set(["must_change_password"]);

export function isSensitiveKey(key) {
  return !ALLOWED_FLAG_KEYS.has(key) && SENSITIVE_KEY_PATTERN.test(key);
}

export function toSafeUser(row) {
  const safe = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!isSensitiveKey(key)) safe[key] = value;
  }
  return safe;
}

// ---- credential comparison -------------------------------------------

// Constant-time comparison of the legacy plaintext password. Hashing both
// sides first makes the buffers equal-length so timingSafeEqual applies.
export function passwordsMatch(stored, supplied) {
  if (typeof stored !== "string" || typeof supplied !== "string" || stored.length === 0) return false;
  const a = crypto.createHash("sha256").update(stored, "utf8").digest();
  const b = crypto.createHash("sha256").update(supplied, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- rate limiting ---------------------------------------------------

// In-memory, per-instance limiter. On Vercel each warm instance keeps its
// own counters, so this is best-effort brute-force throttling, not a
// global guarantee (a shared store would need new infrastructure).
//   - every attempt counts against the client IP
//   - only FAILED credential checks count against the email
//   - a successful login clears the email counter
export function createLoginRateLimiter({
  windowMs = 15 * 60 * 1000,
  maxAttemptsPerIp = 30,
  maxFailuresPerEmail = 5,
  maxKeys = 10000,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();

  function live(key) {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    if (now() >= bucket.resetAt) {
      buckets.delete(key);
      return null;
    }
    return bucket;
  }

  function prune() {
    for (const key of buckets.keys()) live(key);
    // Still full of live keys: drop the oldest entries (Map keeps insertion order).
    while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
  }

  function bump(key) {
    const bucket = live(key);
    if (bucket) {
      bucket.count += 1;
      return;
    }
    if (buckets.size >= maxKeys) prune();
    buckets.set(key, { count: 1, resetAt: now() + windowMs });
  }

  function retryAfter(bucket) {
    return Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000));
  }

  return {
    check(ip, email) {
      const ipBucket = live(`ip:${ip}`);
      if (ipBucket && ipBucket.count >= maxAttemptsPerIp) return { limited: true, retryAfterSec: retryAfter(ipBucket) };
      const emailBucket = live(`email:${email}`);
      if (emailBucket && emailBucket.count >= maxFailuresPerEmail) return { limited: true, retryAfterSec: retryAfter(emailBucket) };
      return { limited: false };
    },
    recordAttempt(ip) {
      bump(`ip:${ip}`);
    },
    recordFailure(email) {
      bump(`email:${email}`);
    },
    reset(email) {
      buckets.delete(`email:${email}`);
    },
  };
}

const defaultRateLimiter = createLoginRateLimiter();

export function clientIp(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

// ---- request handling ------------------------------------------------

function parseBody(req) {
  const body = req.body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" ? body : null;
}

export function validateLoginRequest(body) {
  const email = body?.email;
  const password = body?.password;
  if (typeof email !== "string" || typeof password !== "string") return null;
  if (email.trim().length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return null;
  return { email, password };
}

// Fail closed: login must run on the service-role client. supabaseServer.js
// would otherwise silently fall back to the anon key.
function resolveSupabase(deps) {
  if (deps.supabase) return deps.supabase;
  const env = deps.env || process.env;
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    return getSupabaseServerClient();
  } catch {
    return null;
  }
}

function fail(res, status, code) {
  return res.status(status).json({ success: false, code });
}

export async function handleAuthLogin(req, res, deps = {}) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const credentials = validateLoginRequest(parseBody(req));
  if (!credentials) return fail(res, 400, LOGIN_ERROR.INVALID_REQUEST);
  const { email, password } = credentials;

  const supabase = resolveSupabase(deps);
  if (!supabase) {
    console.error("auth login: service-role Supabase credentials are not configured");
    return fail(res, 503, LOGIN_ERROR.SERVER_UNAVAILABLE);
  }

  const limiter = deps.rateLimiter || defaultRateLimiter;
  const ip = clientIp(req);
  const emailKey = email.trim().toLowerCase();
  const limit = limiter.check(ip, emailKey);
  if (limit.limited) {
    res.setHeader?.("Retry-After", String(limit.retryAfterSec));
    return fail(res, 429, LOGIN_ERROR.RATE_LIMITED);
  }
  limiter.recordAttempt(ip);

  try {
    const { data: rows, error } = await supabase.from("users").select("*").eq("email", email).limit(MAX_EMAIL_ROWS);
    if (error) {
      console.error("auth login: users lookup failed", error.code || "");
      return fail(res, 500, LOGIN_ERROR.SERVER_ERROR);
    }

    const user = (rows || []).find((row) => passwordsMatch(row.password, password));
    if (!user) {
      limiter.recordFailure(emailKey);
      return fail(res, 401, LOGIN_ERROR.INVALID_CREDENTIALS);
    }

    // Same membership resolution as the previous browser login.
    let finalUser = toSafeUser(user);

    if (user.role === "client") {
      const { data: membership, error: membershipError } = await supabase
        .from("client_users")
        .select("client_id, role, is_active, permissions_overrides, clients(id, business_name, email)")
        .eq("user_id", user.id)
        .maybeSingle();

      if (membershipError || !membership) return fail(res, 403, LOGIN_ERROR.NO_MEMBERSHIP);
      if (membership.is_active === false) return fail(res, 403, LOGIN_ERROR.ACCOUNT_DISABLED);

      finalUser = {
        ...finalUser,
        client_id: membership.client_id,
        business_name: membership.clients?.business_name || null,
        client_role: membership.role,
        is_active: membership.is_active,
        permissions_overrides: membership.permissions_overrides,
      };

      // Best-effort UI language — never blocks login (columns may be absent).
      try {
        const { data: langRow } = await supabase
          .from("client_users")
          .select("language, clients(default_language)")
          .eq("user_id", user.id)
          .maybeSingle();
        finalUser.ui_language_user = langRow?.language || null;
        finalUser.ui_language_client = langRow?.clients?.default_language || null;
      } catch {
        finalUser.ui_language_user = null;
        finalUser.ui_language_client = null;
      }
    }

    limiter.reset(emailKey);

    // Best-effort last-login stamp (previously written from the browser).
    try {
      await supabase.from("users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
    } catch {
      // never blocks login
    }

    return res.status(200).json({ success: true, user: toSafeUser(finalUser) });
  } catch (err) {
    console.error("auth login: unexpected failure", err?.name || "Error");
    return fail(res, 500, LOGIN_ERROR.SERVER_ERROR);
  }
}
