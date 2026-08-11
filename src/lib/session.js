// Centralized browser-session lifetime for the custom (non-Supabase-Auth)
// login system. This is deliberately separate from `users.last_login_at`,
// which is just an audit timestamp — this controls how long a logged-in
// browser session stays valid before requiring re-login, regardless of
// whether the user is active in the tab.
//
// Applies uniformly to both the Admin and Client portals.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const SESSION_EXPIRY_KEY = "session_expires_at";

export function writeSessionExpiry() {
  localStorage.setItem(SESSION_EXPIRY_KEY, String(Date.now() + SESSION_TTL_MS));
}

export function clearSessionExpiry() {
  localStorage.removeItem(SESSION_EXPIRY_KEY);
}

// Returns true if the stored session has expired. A session with no expiry
// stamp at all (e.g. one written before this feature existed) is treated as
// NOT yet expired by the caller — see AuthContext.jsx, which grandfathers it
// into a fresh window instead of forcing an immediate logout on deploy.
export function readSessionExpiry() {
  const raw = localStorage.getItem(SESSION_EXPIRY_KEY);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isSessionExpired(expiresAt) {
  return typeof expiresAt === "number" && Date.now() >= expiresAt;
}
