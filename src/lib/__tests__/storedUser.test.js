import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STORED_USER_KEY,
  SENSITIVE_USER_FIELDS,
  sanitizeUser,
  hasSensitiveUserFields,
  writeStoredUser,
} from "../storedUser.js";

// Security C1 (SEC-4): no credential may be persisted in browser storage.
// See docs/security/security-remediation-roadmap.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const code = (src) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    dump: () => Object.fromEntries(data),
  };
}

// Shape of the `users` row Login.jsx reads with select("*"), merged with
// the client membership fields.
const loginUser = () => ({
  id: "u-1",
  email: "owner@example.com",
  name: "Owner",
  role: "client",
  password: "PlainText#1",
  must_change_password: false,
  last_login_at: null,
  client_id: "c-1",
  business_name: "Acme",
  client_role: "owner",
  is_active: true,
  permissions_overrides: null,
  ui_language_user: "ar",
  ui_language_client: "en",
});

test("sanitizeUser removes password and keeps every session field", () => {
  const clean = sanitizeUser(loginUser());
  assert.equal("password" in clean, false);
  const expected = loginUser();
  delete expected.password;
  assert.deepEqual(clean, expected);
});

test("sanitizeUser strips every listed credential field, case-insensitively", () => {
  const dirty = { id: "u-1" };
  for (const f of SENSITIVE_USER_FIELDS) dirty[f] = "secret";
  dirty.Password = "secret";
  dirty.PASSWORD_HASH = "secret";
  assert.deepEqual(sanitizeUser(dirty), { id: "u-1" });
});

test("sanitizeUser does not mutate its input and tolerates non-objects", () => {
  const input = loginUser();
  sanitizeUser(input);
  assert.equal(input.password, "PlainText#1");
  assert.equal(sanitizeUser(null), null);
  assert.equal(sanitizeUser(undefined), undefined);
  assert.equal(sanitizeUser("x"), "x");
});

test("must_change_password is a flag, not a credential, and is preserved", () => {
  assert.equal(sanitizeUser({ must_change_password: true }).must_change_password, true);
  assert.equal(hasSensitiveUserFields({ must_change_password: true }), false);
});

test("writeStoredUser persists no credential and returns the sanitized object", () => {
  const storage = memoryStorage();
  const returned = writeStoredUser(loginUser(), storage);
  const raw = storage.dump()[STORED_USER_KEY];
  assert.ok(raw);
  assert.equal(raw.includes("PlainText#1"), false);
  assert.equal(raw.includes('"password"'), false);
  assert.deepEqual(JSON.parse(raw), returned);
  assert.equal(returned.client_id, "c-1");
});

test("legacy cached user (pre-C1) is detected and cleaned on rewrite", () => {
  const storage = memoryStorage({ user: JSON.stringify(loginUser()) });
  const cached = JSON.parse(storage.getItem("user"));
  assert.equal(hasSensitiveUserFields(cached), true);
  writeStoredUser(cached, storage);
  const after = JSON.parse(storage.getItem("user"));
  assert.equal(hasSensitiveUserFields(after), false);
  assert.equal(after.id, "u-1");
  assert.equal(after.role, "client");
});

// ---- Source guards: the write paths actually use the sanitizer ----------

test("Login.jsx stores and sets only the sanitized user", () => {
  const src = code(read("src/pages/Login.jsx"));
  assert.match(src, /import \{ writeStoredUser \} from "\.\.\/lib\/storedUser\.js"/);
  assert.doesNotMatch(src, /localStorage\.setItem\(\s*"user"/);
  assert.match(src, /const storedUser = writeStoredUser\(finalUser\);/);
  assert.match(src, /setUser\(storedUser\)/);
  assert.doesNotMatch(src, /setUser\(finalUser\)/);
});

test("Login.jsx never logs credentials or the raw error object", () => {
  const src = code(read("src/pages/Login.jsx"));
  for (const call of src.match(/console\.\w+\([^)]*\)/g) || []) {
    assert.doesNotMatch(call, /password/i, call);
    assert.doesNotMatch(call, /,\s*err\s*\)/, call);
  }
});

test("AuthContext sanitizes and rewrites a legacy cached user on load", () => {
  const src = code(read("src/context/AuthContext.jsx"));
  assert.match(src, /hasSensitiveUserFields\(parsedUser\)/);
  assert.match(src, /return writeStoredUser\(parsedUser\)/);
  // Expired sessions are still cleared before any rewrite.
  assert.ok(src.indexOf("isSessionExpired(expiresAt)") < src.indexOf("hasSensitiveUserFields(parsedUser)"));
});

test("logout paths still remove the cached user", () => {
  for (const p of ["src/components/Navbar.jsx", "src/layouts/ClientShell.jsx", "src/layouts/SharedDashboardLayout.jsx"]) {
    assert.match(code(read(p)), /localStorage\.removeItem\("user"\)/, p);
  }
});

test("other cached-user writers only spread the (already sanitized) auth user", () => {
  for (const p of ["src/context/LanguageContext.jsx", "src/pages/client/ClientAccount.jsx"]) {
    const src = code(read(p));
    const writes = src.match(/localStorage\.setItem\("user",\s*JSON\.stringify\((\w+)\)\)/g) || [];
    assert.ok(writes.length > 0, p);
    for (const w of writes) assert.match(w, /updatedUser/, `${p}: ${w}`);
    for (const decl of src.match(/const updatedUser = [^;]+;/g) || []) {
      assert.match(decl, /^const updatedUser = \{ \.\.\.user,/, `${p}: ${decl}`);
    }
  }
});
