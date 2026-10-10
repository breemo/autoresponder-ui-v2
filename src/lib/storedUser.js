// Security C1 (SEC-4): the browser-cached user object must never carry
// credentials. Login.jsx reads the `users` row with select("*"), which
// includes the plaintext `password` column — so every object that is put
// into localStorage("user") or React auth state goes through
// sanitizeUser() first. AuthContext also re-sanitizes (and rewrites) any
// object cached by an older build on app load.

export const STORED_USER_KEY = "user";

// Credential-bearing fields that must never live in browser storage.
// Lower-cased comparison, so `Password` / `PASSWORD` are stripped too.
export const SENSITIVE_USER_FIELDS = Object.freeze([
  "password",
  "password_hash",
  "current_password",
  "new_password",
  "confirm_password",
  "temp_password",
  "temporary_password",
  "reset_token",
  "password_reset_token",
]);

const SENSITIVE_SET = new Set(SENSITIVE_USER_FIELDS);

export function isSensitiveUserField(key) {
  return typeof key === "string" && SENSITIVE_SET.has(key.toLowerCase());
}

// Returns a shallow copy without credential fields. Non-objects are
// returned unchanged (null stays null).
export function sanitizeUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return user;
  const clean = {};
  for (const [key, value] of Object.entries(user)) {
    if (!isSensitiveUserField(key)) clean[key] = value;
  }
  return clean;
}

export function hasSensitiveUserFields(user) {
  if (!user || typeof user !== "object") return false;
  return Object.keys(user).some(isSensitiveUserField);
}

// The single write path for the cached user. Returns the sanitized object
// so callers can hand the same value to setUser().
export function writeStoredUser(user, storage = globalThis.localStorage) {
  const clean = sanitizeUser(user);
  storage.setItem(STORED_USER_KEY, JSON.stringify(clean));
  return clean;
}
