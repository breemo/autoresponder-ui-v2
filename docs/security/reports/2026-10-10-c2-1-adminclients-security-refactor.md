# Execution Report — C2.1: AdminClients User Operations (Security Refactor)

| Field | Value |
|---|---|
| Date | 2026-10-10 |
| Worktree / branch | `autoresponder-ui-v2-security` / `security/auth-hardening` |
| Starting commit | `c9fa4c5` — `security: verify login credentials server-side` |
| Change state | **Uncommitted** (commit awaits approval) |
| Session note | Implementation was interrupted by a usage limit after the server module, router branch and page change were written. It was resumed without restarting: the diff was reviewed, the code was found complete and in scope, then tests, validation and this report were added |
| Final status | **PASS** (code-only scope). The `users` table is **not** secured until the separately approved DB phase |

---

## 1. Executive Summary

- `src/pages/admin/AdminClients.jsx` no longer reads, inserts or deletes `users` rows in the browser. The create-client and delete-client flows now run server-side in `api/_lib/adminClients.js`, reached via the existing admin endpoint: `POST /api/system-settings?resource=clients`. **No new Vercel Function** (still 12).
- The flows are a 1:1 port: same queries, order, validation, messages, subscription logic, owner membership, rollback order, admin-entered initial password with `must_change_password: true`, and the **existing email-matching delete semantics**.
- The server path requires the service-role key and **fails closed** (503). Responses contain only `success` / `code` / `client_id`. Logs contain only the failing step and the DB error code.
- **Production bundle check:** `from("users")` occurs **0** times in `dist/assets/*.js`. No routed browser code touches `users` any more. The three legacy pages (`Clients.jsx`, `ClientUsers.jsx`, `ManageUsers.jsx`) were not modified, as instructed; they are not routed, so they are not in the bundle.
- **The admin gate still trusts the client-supplied `actor_user_id`** (role re-read server-side). It is not authentication. S3 remains open.
- **`users` is NOT secured yet:** anon/authenticated grants are unchanged until a separately approved DB phase.
- Full suite **1323 / 1325**; the 2 failures pre-date this work. 33 new tests pass. Build passes.

## 2. Files Changed

| File | Status | Change |
|---|---|---|
| `api/_lib/adminClients.js` | **Created** | `handleAdminClients`, `createClient`, `deleteClient`, `subscriptionPeriod`, `ADMIN_CLIENTS_ERROR` |
| `api/system-settings.js` | Modified (+12) | Import + header doc + `POST ?resource=clients` dispatch placed **after** the `resolveActingAdmin` 401 gate and **before** the existing GET/POST settings branches |
| `src/pages/admin/AdminClients.jsx` | Modified (+33 / −140) | `useAuth()` for `user.id`; `callAdminClientsApi()`; `addClient` / `deleteClient` call the API; logs only the error code. List loading, status toggle and all JSX unchanged |
| `api/_lib/__tests__/adminClients.test.js` | **Created** | 33 regression tests |
| `docs/security/reports/2026-10-10-c2-1-adminclients-security-refactor.md` | **Created** | This report |

**Not modified:** `src/pages/Clients.jsx`, `src/pages/ClientUsers.jsx`, `src/pages/ManageUsers.jsx` (test-guarded), DB, n8n, env, `vercel.json`. Preserved untracked: `docs/security/security-*.md`, `docs/security/reports/2026-10-10-adminclients-users-dependency-review.md`, `engineering/reports/`.

## 3. Security Changes

| Change | State |
|---|---|
| Browser no longer performs U1–U5 (`users` lookup ×2, insert, delete ×2) or the related `client_users` / `subscriptions` / `clients` writes of the create/delete flows | **Active once deployed** |
| Create/delete gated by the existing platform-admin check (`users.role === "admin"`, not `must_change_password`). Previously these writes had **no** check at all | **Active once deployed** — still `actor_user_id`-based (unverified) |
| Service-role key required; 503 if absent (no anon-key fallback) | **Active once deployed** |
| Request cannot choose the owner's `role` (always `client`) or membership role (always `owner`) | **Active once deployed** |
| Delete target email is re-read from the `clients` row by id, never taken from the request, so a caller cannot target an arbitrary user email | **Active once deployed** |
| Input type/size validation (strings, ≤ 320 chars, password ≤ 1024, `subscription_type ∈ {trial, paid}`) | **Active once deployed** |
| No passwords, emails, raw errors or keys in responses or logs | **Active once deployed** |
| Revoking anon/authenticated grants on `users` | **Not done** — separate DB phase |
| Verified sessions (S3) | **Not done** |

**Privilege-escalation review:** the new server path cannot create admins and cannot delete by a caller-chosen email. It runs only for an `actor_user_id` whose DB role is `admin`. Today the same operations are available to anyone holding the public anon key with no check, so this introduces no new escalation path. The residual risk is the existing S3 class (admin UUID spoofing), documented in §6.

## 4. Exact Behavior Preserved

**Create** (`action: "create"`):

1. Form check unchanged in the browser (`business_name`, `email`, `password` required → same ⚠️ message). The server re-checks.
2. `normalizedEmail = email.trim().toLowerCase()`.
3. `users` lookup by normalized email → found → `email_in_use_users` → same ⚠️ "users" message; lookup error → generic failure.
4. `clients` lookup by normalized email → found → `email_in_use_clients` → same ⚠️ "clients" message.
5. Insert `clients` `{ business_name: trim, email, plan_id || null }`.
6. If `plan_id`: insert `subscriptions` `{ client_id, plan_id, subscription_type, status: "active", start_date, end_date }`, with trial = +3 days and otherwise +1 month (same `setDate` / `setMonth` math).
7. Insert `users` `{ email, name: business_name.trim(), role: "client", password: <admin-entered>, must_change_password: true }`.
8. Insert `client_users` `{ client_id, user_id, role: "owner" }`.
9. Success message chosen by `form.plan_id` exactly as before; drawer closes; list reloads.
10. Any failure → compensating deletes in the original order **users → subscriptions → clients** (each only if created), results ignored → same ❌ message.

**Delete** (`action: "delete"`), browser confirm dialog unchanged:

1. Target email = the client row's `email`. If it is empty or the client is missing, no user lookup happens.
2. `users` lookup by exact email (`maybeSingle`); errors ignored, as before.
3. If a user matched: delete **all** `client_users` rows for the client, then delete **only that user**. Errors on both are ignored, as before. **Other members' `users` rows are not deleted** (unchanged).
4. Delete the `clients` row; error → same ❌ message; success → same 🗑️ message + reload.

**Unchanged:** `fetchData` (`plans`, `clients` + `subscriptions` reads) and `toggleStatus` (`clients.is_active` update) still run in the browser (they don't touch `users`). Existing `system-settings` GET/POST settings and the `overview` resource behave identically (tested).

**Known, minor differences (documented, not product changes):**

| Difference | Impact |
|---|---|
| Subscription dates are computed on the server (Vercel runs in UTC) instead of the admin's browser timezone | Same instant for `start_date`; `end_date` can differ by the DST hour, or by a day when the local and UTC calendar dates differ at month-end (e.g. creating near midnight on the 31st) |
| Delete reads the client's email from the DB rather than from the page's loaded list | Identical unless the email changed after the list loaded; the DB value is authoritative |
| A `clients` lookup error during delete now aborts with ❌ before deleting anything | Previously there was no lookup step; safer |
| An admin whose own `must_change_password` is true, or a session whose user is not an admin, now gets ❌ for create/delete | Same rule as every other admin API (`resolveActingAdmin`) |
| A network/HTTP failure maps to the existing generic ❌ messages | Same messages |

## 5. Test Results

Environment: the worktree's `node_modules` is still broken (tracked pnpm symlink stubs; pre-existing). Tests and build ran in scratchpad copies with `node_modules` junctioned to the main checkout's install: baseline = `git archive c9fa4c5`, changed = working tree. Neither repository was modified by this.

| Command | Baseline (`c9fa4c5`) | With C2.1 |
|---|---|---|
| `npm test` (`node --test api/_lib/__tests__ src/lib/__tests__`) | 1292 · 1290 pass · 2 fail | **1325 · 1323 pass · 2 fail** |
| `node --test api/_lib/__tests__/adminClients.test.js` | — | **33 / 33** |
| `node --test api/_lib/__tests__/adminClients.test.js api/_lib/__tests__/adminOverview.test.js api/_lib/__tests__/systemSettingsWorkflowUrl.test.js api/_lib/__tests__/functionConsolidation.test.js api/_lib/__tests__/authLogin.test.js api/_lib/__tests__/sessionAuth.test.js src/lib/__tests__/storedUser.test.js api/_lib/__tests__/clientRouting.test.js` | — | **128 / 128** |
| `npm run build` | — | **Pass** (exit 0; PWA 100 precache entries) |
| `grep -o 'from("users")' dist/assets/*.js` | — | **0** |

**Failures (both pre-existing, unrelated):** `src/lib/__tests__/clientAiAgent.test.js`: "C: client mode never loads channel configs…" and "C: client mode renders AI Behavior + Integrations link…" (`client mode returns before fetchFeatureSettingsRows`, source-guard drift from the AI Agent redesign).

**During validation:** one new test initially failed because of a bug in the test itself (an `undefined` actor triggered the helper's default `"u-admin"`). The test was corrected to use `null` / `""`. No product code changed.

**Coverage (33 tests):**
- **Create:** create without plan (order, normalization); owner password + `must_change_password`; role not injectable; trial subscription (+3d, order); paid (+1 month); duplicate email in `users` and in `clients` (no writes); 7 invalid inputs → 400 before DB.
- **Create failures:** lookup error; client-insert failure; subscription-insert failure → client rollback; user-insert failure → subscription + client rollback; membership-insert failure → user + subscription + client rollback in order; thrown exception rollback; rollback errors ignored.
- **Delete:** email-matched owner deleted, other member kept; no matching user; users lookup error ignored; `client_users` / `users` delete errors ignored; `clients` delete error → 500; unknown client id; target email not taken from the request; missing `client_id` → 400.
- **Auth and config:** non-admin / unknown / null / empty actor → 401; admin with `must_change_password` → 401; missing service-role key → 503; unknown action → 400.
- **Safety and compatibility:** no secrets in logs; no secrets in responses; existing GET/POST settings unchanged; clients branch after the admin gate; static check that `AdminClients.jsx` has no `users` / `client_users` / `subscriptions` operations, keeps all 8 messages, and keeps the status toggle; legacy pages present; Function count ≤ 12.

## 6. Remaining Risks

| Risk | Severity | Status |
|---|---|---|
| **SEC-1:** `users` (incl. plaintext passwords) still readable/writable with the public anon key | **Critical** | **Open.** No routed browser code needs that access any more; revoke requires a separately approved DB phase |
| **S3:** admin gate trusts `actor_user_id`; anyone who learns an admin's UUID (currently readable via SEC-1) can call create/delete | **Critical** | **Open.** Needs verified sessions (S2/S3) |
| **SEC-3:** owner initial password stored in plaintext (preserved by instruction) | **Critical** | **Open** |
| Existing delete semantics: non-owner members' `users` rows survive deletion with valid credentials; an email-matched user is deleted regardless of role | High (pre-existing) | **Preserved by instruction**; product decision pending |
| Rollback is best-effort and non-transactional (unchanged); a failure mid-rollback can leave orphans | Medium (pre-existing) | A transactional RPC would need a migration |
| Admin create/delete fail with ❌ if `SUPABASE_SERVICE_ROLE_KEY` is missing in the deployed environment | Operational | Verify in DEV first |
| Legacy pages still contain direct `users` code (unrouted, not bundled) | Low | Kept by instruction; delete in a later approved step |
| Other browser pages still write `clients` / `subscriptions` / `plans` / `client_users` (e.g. `toggleStatus`, `LanguageContext`, other admin pages) | High | Out of C2.1 scope; tenant-RLS / admin-API phase |

## 7. Database / n8n Impact

- **Database:** none. No schema, grant, RLS, RPC or record change. Same tables and columns as before, now written by the service-role client instead of anon.
- **n8n:** none. n8n exports reference only `rest/v1/subscriptions` among these tables (see the dependency review); no workflow changed.

## 8. DEV / PROD Impact

- Nothing deployed, committed, pushed or merged. No env var or credential change.
- **Deployment prerequisite:** `SUPABASE_SERVICE_ROLE_KEY` present in the target Vercel environment (already required by C2 login and the admin overview).
- The frontend and API ship in the same Vercel deployment.

## 9. Rollback Instructions

- **Now (uncommitted):**
  ```bash
  git restore api/system-settings.js src/pages/admin/AdminClients.jsx
  rm api/_lib/adminClients.js api/_lib/__tests__/adminClients.test.js
  ```
- **After commit/deploy:** `git revert <C2.1 commit>` or Vercel instant rollback. No DB rollback is needed.

## 10. Next Recommended Security Step

1. Approve the C2.1 commit (suggested: `security: move admin client user operations server-side`).
2. DEV deploy of C1 + C2 + C2.1 (approval). Matrix:
   - Admin and client login.
   - Create client with no plan, trial plan and paid plan; duplicate email in `users` and in `clients`.
   - Delete client; toggle status.
   - New owner's first login and mandatory password change.
   - Confirm in the Network tab that no `/rest/v1/users` request occurs anywhere.
3. **C2 DB phase (separate approval):** in DEV, revoke `SELECT/INSERT/UPDATE/DELETE` on `public.users` from `anon` and `authenticated`. Re-run the matrix and an anon probe (expect 401/403 on `/rest/v1/users`). Then PROD: code first, verify, then revoke. Rollback = re-grant SQL. This closes SEC-1 for `users`.
4. Then SEC-3 (password hashing + forced reset) and S2/S3 (verified sessions) to remove the `actor_user_id` trust.

## 11. Final Status

**PASS** (C2.1 code-only scope)

- AdminClients create/delete moved server-side with behavior preserved; 33 tests; full suite and build green apart from the 2 pre-existing failures.
- `users` table **not yet secured** (grants unchanged); `actor_user_id` still unverified (S3).

**Next action:** approval to commit C2.1, then a DEV deployment and the C2 DB revoke phase, each separately approved.
