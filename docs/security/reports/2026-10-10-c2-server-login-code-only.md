# Execution Report — C2: Server-side Login (Code Only)

| Field | Value |
|---|---|
| Date | 2026-10-10 |
| Worktree | `autoresponder-ui-v2-security` |
| Branch | `security/auth-hardening` |
| Starting commit (C2) | `489abdd` — `security: sanitize stored users and prepare session authorization` (Batch 1, committed in this task) |
| C2 change state | **Uncommitted** working-tree changes (commit awaits approval) |
| Final status | **PARTIAL** — server-side login implemented and tested locally; DB lockdown, deployment and the `/api/auth/login` URL alias are not done |

---

## 1. Executive Summary

- **Batch 1 committed** locally as `489abdd` (C1 + S3 preparation + reporting convention). Not pushed.
- **C2 server-side login implemented (code only).** The browser no longer queries `users` or sends a `password` filter to Supabase during login. `src/pages/Login.jsx` now POSTs `{ email, password }` to a server handler (`api/_lib/authLogin.js`) that verifies credentials with the **service-role** client, applies the same membership/active/language rules as before, and returns a **sanitized** user object.
- Added request validation, per-IP and per-email login rate limiting (in-memory, best-effort), constant-time password comparison, fail-closed behavior when the service-role key is missing, and log hygiene (no passwords, emails or raw errors logged).
- **This is transitional.** The server still compares the **legacy plaintext** `users.password` column. No session or token is issued. All other APIs still trust client-supplied `actor_user_id`. **Server-side login alone does not fix API impersonation (S3) or the public readability of `users` (SEC-1).**
- **Route deviation:** the endpoint is `POST /api/client-router?resource=login`, **not** a new `api/auth/login.js`. A new file would be the 13th Vercel Function, exceeding the Hobby 12-function cap (enforced by `functionConsolidation.test.js`) and breaking deploys. A `/api/auth/login` alias would need a `vercel.json` rewrite on the production login path — left for approval.
- Build passes. Full suite **1290 / 1292**; the 2 failures pre-date this work. 29 new C2 tests, all passing.

## 2. Scope and Git Commits

**Part 1 — Batch 1 commit**

| Item | Value |
|---|---|
| Branch verified | `security/auth-hardening` |
| Commit | `489abdd` `security: sanitize stored users and prepare session authorization` |
| Files | `CLAUDE.md`, `api/_lib/sessionAuth.js`, `api/_lib/__tests__/sessionAuth.test.js`, `docs/security/reports/2026-10-10-c1-s3-execution-report.md`, `src/context/AuthContext.jsx`, `src/lib/__tests__/publicWebsite.test.js`, `src/lib/__tests__/storedUser.test.js`, `src/lib/storedUser.js`, `src/pages/Login.jsx` |
| Not staged (preserved) | `docs/security/security-dependency-map.md`, `security-findings.md`, `security-remediation-roadmap.md`, `security-target-architecture.md`, `engineering/reports/` |
| Push / merge | None |

**Part 2 — C2 (code only, uncommitted)**

In scope: server-side credential verification, sanitized response, validation, rate limiting, fail-closed config, tests, frontend switch.
Out of scope (not done): DB grants/RLS/schema/records, password hashing, Supabase Auth, session issuance, S3 enforcement, n8n, env vars, deployment, push, merge.

## 3. Files Changed

| File | Status | Change |
|---|---|---|
| `api/_lib/authLogin.js` | **Created** | `handleAuthLogin`, `createLoginRateLimiter`, `passwordsMatch`, `toSafeUser`, `validateLoginRequest`, `clientIp`, `LOGIN_ERROR` |
| `api/client-router.js` | Modified | `?resource=login` route → `handleAuthLogin`; header doc updated |
| `src/pages/Login.jsx` | Modified | Removed `supabaseClient` import and all `users`/`client_users` queries and the browser `last_login_at` write; calls the server; maps error codes to existing messages |
| `src/locales/en/translation.json` | Modified | + `login.errorRateLimited` |
| `src/locales/ar/translation.json` | Modified | + `login.errorRateLimited` |
| `api/_lib/__tests__/authLogin.test.js` | **Created** | 29 tests |
| `api/_lib/__tests__/clientRouting.test.js` | Modified | + login route test |
| `src/lib/__tests__/publicWebsite.test.js` | Modified | Login flow guard now asserts the browser does **not** query `users`/`password` and uses the server endpoint |
| `src/lib/__tests__/storedUser.test.js` | Modified | Login source guard follows the renamed variable (`writeStoredUser(user)`) |
| `docs/security/reports/2026-10-10-c2-server-login-code-only.md` | **Created** | This report |

## 4. Implementation Details

### 4.1 Endpoint contract

`POST /api/client-router?resource=login` — body `{ email, password }`

| Status | Body | Frontend message (existing keys) |
|---|---|---|
| 200 | `{ success: true, user }` | `login.successAdmin` / `login.successClient` |
| 400 | `{ success:false, code:"invalid_request" }` | `login.errorInvalidCredentials` |
| 401 | `invalid_credentials` (wrong password **and** unknown email — identical) | `login.errorInvalidCredentials` |
| 403 | `no_membership` | `login.errorNoMembership` |
| 403 | `account_disabled` | `login.errorAccountDisabled` |
| 405 | `Method not allowed` | `login.errorGeneric` |
| 429 | `rate_limited` + `Retry-After` header | `login.errorRateLimited` (**new** key, en + ar) |
| 500 | `server_error` | `login.errorGeneric` |
| 503 | `server_unavailable` | `login.errorGeneric` |

### 4.2 Server flow (`api/_lib/authLogin.js`)

1. Method check → 405.
2. Validation: `email` and `password` must be strings; email non-blank, ≤ 320 chars; password 1–1024 chars. Objects/arrays (e.g. `{ "$ne": null }`) rejected. JSON-string bodies parsed. → 400 before any DB access.
3. **Fail closed:** requires `SUPABASE_URL`/`VITE_SUPABASE_URL` **and** `SUPABASE_SERVICE_ROLE_KEY`; otherwise 503. Does not use `supabaseServer.js`'s anon-key fallback.
4. Rate-limit check (see 4.3) → 429.
5. `users` lookup with the service-role client: `select("*").eq("email", email).limit(5)` — exact email as before; supports duplicate-email rows the same way the old `.eq("email").eq("password")` did.
6. **Legacy plaintext compare** using SHA-256 digests + `crypto.timingSafeEqual` (constant time). No match → 401 + email failure recorded.
7. `role === "client"`: same `client_users` membership query as before (`client_id, role, is_active, permissions_overrides, clients(id, business_name, email)`); missing/error → 403 `no_membership`; `is_active === false` → 403 `account_disabled`. Best-effort language lookup (`ui_language_user`, `ui_language_client`), never blocks login.
8. Non-client roles (admin) → no membership lookup; routing by `role` unchanged on the client.
9. Success → email counter reset; best-effort `last_login_at` update (moved from the browser to the server).
10. Response user passes through `toSafeUser`: drops any key matching `password|passwd|secret|token|hash|api_key|private_key|salt` (case-insensitive) except `must_change_password`. The browser additionally re-sanitizes via C1's `writeStoredUser`.
11. Logging: only fixed messages + Supabase error `code` / exception name. Never passwords, emails, request bodies or raw errors.

### 4.3 Rate limiting

- In-memory per warm Vercel instance; 15-minute window.
- Per IP (first `x-forwarded-for` hop): 30 attempts.
- Per email (trimmed, lower-cased): 5 **failed** credential checks; reset on success.
- Bounded memory (10 000 keys, expired-first pruning).
- **Limitation:** not global across instances or cold starts; a distributed attacker is only partially throttled. A shared store (DB table / KV) would need infrastructure approval.

### 4.4 Frontend (`src/pages/Login.jsx`)

- Single `fetch("/api/client-router?resource=login", { method: "POST", ... })`.
- Same storage (`writeStoredUser` → sanitized), `writeSessionExpiry()`, `setUser`, success message and `/admin` vs `/client` navigation.
- Network failure → existing `onSubmit` catch → `login.errorGeneric`.
- UI markup unchanged.

### 4.5 What is active vs prepared

| Protection | State |
|---|---|
| Browser no longer sends credential filters to Supabase during login | **Active once deployed** |
| Server-side credential verification (service role, fail closed) | **Active once deployed** |
| Sanitized login response | **Active once deployed** |
| Login rate limiting (per instance) | **Active once deployed** (best-effort) |
| Revoking anon/authenticated access to `users` | **Not done** — blocked (DB change + other browser callers, see §10) |
| Session/token issuance; S3 enforcement (`sessionAuth.js`) | **Not active** — unchanged from Batch 1 |

## 5. Completed / Partial / Blocked

| Item | Status |
|---|---|
| Batch 1 commit | **Completed** (`489abdd`) |
| Server login handler + validation + safe errors | **Completed** |
| Service-role client, fail closed | **Completed** |
| Sanitized response, no credential logging | **Completed** |
| Rate limiting | **Partial** — per-instance in-memory only |
| Preserve admin/client routing, membership, active, `must_change_password`, language, messages | **Completed** (test-verified; not browser-tested) |
| Automated tests | **Completed** (29 new) |
| Endpoint at `POST /api/auth/login` | **Blocked / deviated** — Vercel 12-function cap; served at `/api/client-router?resource=login`. Alias needs a `vercel.json` rewrite (approval) or a plan upgrade |
| Revoke `users` grants from anon/authenticated (rest of roadmap C2) | **Blocked** — DB change not permitted in this task; also requires moving the remaining browser `users` callers (§10) |
| Password hashing | **Not started** — out of scope |
| DEV/PROD deployment | **Not done** — not permitted |

## 6. Database Impact

None. No schema, grant, RLS, RPC or record changes. The handler reads `users` / `client_users` / `clients` and writes only `users.last_login_at` (the browser wrote the same column before). The service-role key is required at runtime; it is already read by `api/_lib/supabaseServer.js`.

## 7. n8n Impact

None. No workflow changes; n8n does not call the login path. Shared `client-router` resources (`users`, `ai-behavior`, `locations`, `password`) are untouched.

## 8. DEV / PROD Impact

- Nothing deployed, pushed or merged. No Vercel env var changes.
- **Deployment prerequisite:** `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_URL` or `VITE_SUPABASE_URL`) must be present in the target Vercel environment. **If absent, every login returns 503 and nobody can log in** (fail-closed by design). Verify in DEV before any PROD deploy.
- Frontend and API must deploy together (same Vercel deployment — they do).
- Existing logged-in sessions are unaffected (no storage format change).

## 9. Build and Test Results

Environment: the worktree's `node_modules` is still broken (pnpm symlinks tracked as text files — pre-existing, see Batch 1 report). Validation ran in scratchpad copies — baseline = `git archive 489abdd`, changed = working tree — with `node_modules` junctioned to the main checkout's install (identical dependencies). Neither repository was modified by this.

| Command | Baseline (`489abdd`) | With C2 |
|---|---|---|
| `npm test` (`node --test api/_lib/__tests__ src/lib/__tests__`) | 1262 tests · 1260 pass · 2 fail | **1292 tests · 1290 pass · 2 fail** |
| `node --test api/_lib/__tests__/authLogin.test.js api/_lib/__tests__/sessionAuth.test.js src/lib/__tests__/storedUser.test.js api/_lib/__tests__/clientRouting.test.js api/_lib/__tests__/functionConsolidation.test.js api/_lib/__tests__/knowledgeDocumentsAuth.test.js api/_lib/__tests__/systemSettingsWorkflowUrl.test.js src/lib/__tests__/publicWebsite.test.js` | — | **101 / 101 pass** |
| `npm run build` | — | **Pass** (exit 0; PWA 100 precache entries) |
| Bundle check: `grep 'eq("password"' dist/assets/*.js` | — | **0 files** (browser bundle no longer contains the password query) |

**Failures**

| Test | File | Cause | New? |
|---|---|---|---|
| `C: client mode never loads channel configs and cannot open/save a channel drawer` | `src/lib/__tests__/clientAiAgent.test.js` | `client mode returns before fetchFeatureSettingsRows` — source guard drift after AI Agent redesign | **Pre-existing** |
| `C: client mode renders AI Behavior + Integrations link instead of channel cards; stats hidden` | `src/lib/__tests__/clientAiAgent.test.js` | Same | **Pre-existing** |

No new failures. Three existing guard tests were intentionally updated because they pinned the old browser query (§3).

**C2 test coverage (29):** admin login; client login with membership/business name/language/`must_change_password`; language failure non-blocking; `last_login_at` server write on success only; wrong password vs unknown email identical 401; exact-email matching; no membership; membership error; inactive membership; 405; 11 malformed bodies (incl. NoSQL-style object) rejected before DB; JSON-string body; per-email limit with `Retry-After`; case-insensitive email limit; per-IP limit; counter reset on success; window expiry; bounded memory; IP extraction; users lookup error → 500; thrown exception → 500; fail-closed 503 for three missing-credential env shapes; router dispatch; no secret/email/raw-error logging; `toSafeUser`; `passwordsMatch`; static check that `Login.jsx` has no `users`/`password` query.

## 10. Remaining Security Risks

| Risk | Severity | Status |
|---|---|---|
| **SEC-1:** `users` (incl. plaintext passwords) still readable with the public anon key | **Critical** | **Open.** C2's DB half (revoke grants) not done. Login no longer *needs* anon access, but other browser code still does |
| **SEC-3:** passwords stored and compared in **plaintext** (login, `changePassword.js`, `clientUsers.js` temp passwords) | **Critical** | **Open.** The new server login still compares the legacy plaintext column — explicitly transitional |
| **S3 / SEC-6:** APIs trust client-supplied `actor_user_id`; no session issued at login | **Critical** | **Open.** Server-side login does **not** fix impersonation |
| Remaining browser `users` access blocking the grant revoke: `src/pages/admin/AdminClients.jsx` (select id by email, **insert user with password**, delete), plus `src/pages/Clients.jsx`, `src/pages/ClientUsers.jsx`, `src/pages/ManageUsers.jsx` (`select("*")` + delete; these three appear unrouted in `App.jsx` — confirm and remove) | High | **Open** — must move server-side before revoking grants |
| Rate limiting is per-instance in-memory | Medium | Accepted for transition; shared store needs approval |
| IP key relies on `x-forwarded-for` (set by Vercel at the edge); per-email limit still applies regardless | Low | Accepted |
| Fail-closed 503 if the service-role key is missing in the deployed environment → total login outage | Operational | Mitigate by verifying the env var in DEV before PROD |
| `supabaseServer.js` anon-key fallback for other endpoints | High | Open (unchanged) |

## 11. Regression and Compatibility Assessment

- **Unchanged:** login UI, messages for every pre-existing case, admin → `/admin`, client → `/client`, membership requirement, inactive-member block, `must_change_password` (still returned → existing route gate), language preferences, session expiry, cached user shape (minus credential fields), logout.
- **Changed behavior:**
  - New 429 message after repeated failures (`login.errorRateLimited`).
  - Missing service-role config now yields a generic error instead of silently working on the anon key.
  - `last_login_at` is written by the server (awaited) instead of the browser (fire-and-forget).
  - A Supabase outage during the user lookup now shows `errorGeneric` instead of `errorInvalidCredentials`.
- **API/n8n:** no existing endpoint behavior changed; `sessionAuth.js` remains unused.
- **Not verified in a running browser or against a real database.** Recommended DEV matrix: admin login; client owner/agent login; inactive member; unlinked client; wrong password; 6× wrong password → 429; first-login `must_change_password` flow; language persistence; hard refresh; logout; confirm `localStorage.user` has no `password` and the Network tab shows no `/rest/v1/users` request during login.

## 12. Rollback Plan

- **Before commit (now):**
  ```bash
  git restore api/client-router.js src/pages/Login.jsx src/locales/en/translation.json src/locales/ar/translation.json \
    api/_lib/__tests__/clientRouting.test.js src/lib/__tests__/publicWebsite.test.js src/lib/__tests__/storedUser.test.js
  rm api/_lib/authLogin.js api/_lib/__tests__/authLogin.test.js
  ```
- **After commit / deploy:** `git revert <C2 commit>` or Vercel instant rollback to the previous deployment. No DB rollback needed (no DB changes).
- **Batch 1** (`489abdd`) is independent and can stay; to undo it: `git revert 489abdd`.

## 13. Recommended Next Steps

1. Review and approve the C2 commit (suggested message: `security: verify login credentials server-side`).
2. Decide the route: keep `?resource=login`, or approve a `vercel.json` rewrite for `/api/auth/login`.
3. Confirm `SUPABASE_SERVICE_ROLE_KEY` exists in the DEV Vercel environment; deploy C1+C2 to DEV only after approval; run the §11 matrix.
4. Move `AdminClients.jsx` user create/lookup/delete server-side; confirm and delete the unrouted legacy pages (`Clients.jsx`, `ClientUsers.jsx`, `ManageUsers.jsx`).
5. Then (approval required) revoke anon/authenticated grants on `users` in DEV, retest, then PROD — closes SEC-1.
6. Plan password hashing + forced reset (SEC-3) and the Supabase Auth migration / session issuance (S2) to activate `sessionAuth.js` (S3).
7. Repair worktree `node_modules`; fix the 2 pre-existing `clientAiAgent.test.js` failures separately.

## 14. Final Status

**PARTIAL**

- Batch 1: **committed** (`489abdd`), not pushed.
- C2 server-side login: **implemented and tested locally — PASS**; uncommitted pending approval.
- C2 database lockdown (revoke `users` access): **BLOCKED** (DB change not permitted; remaining browser callers).
- `/api/auth/login` path: **deviated** (Vercel function cap) — awaiting a routing decision.
- SEC-1, SEC-3 and S3 remain **open critical risks**.

**Next action:** approval to commit C2, plus a decision on the login route alias.
