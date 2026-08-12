// src/context/AuthContext.jsx
import React, { createContext, useContext, useState, useEffect } from "react";
import { writeSessionExpiry, clearSessionExpiry, readSessionExpiry, isSessionExpired } from "../lib/session.js";

// Rehydrates whatever shape Login.jsx stored in localStorage — no field
// list is enforced here. For a "client" role user, that object also
// carries client_id, client_role ("owner" | "agent" | "it"), is_active,
// permissions_overrides, and must_change_password, resolved from
// client_users/users (see src/pages/Login.jsx). Effective permissions are
// resolved via src/lib/permissions.js — see hasUserPermission().
export const AuthContext = createContext(null);

// Hook لاستخدام السياق بسهولة
export function useAuth() {
  return useContext(AuthContext);
}

function clearStoredSession() {
  localStorage.removeItem("user");
  clearSessionExpiry();
}

// Reads/validates the stored session synchronously. Used as useState's lazy
// initializer (runs once, during the very first render) rather than inside
// a useEffect. This matters: AdminRoute/ClientRoute decide whether to
// render <Navigate to="/"> during render itself, before any effect has a
// chance to run. If `user` starts as null and only gets populated by an
// effect after mount, a hard refresh of any protected route (e.g.
// /admin/client/:id) sees `user === null` on that first render and
// immediately redirects to login/blanks out — even though a valid session
// exists in localStorage. Resolving it synchronously up front eliminates
// that race entirely.
function loadStoredUser() {
  const stored = localStorage.getItem("user");
  if (!stored) return null;

  try {
    const parsedUser = JSON.parse(stored);

    let expiresAt = readSessionExpiry();
    if (expiresAt === null) {
      // Session predates the expiration feature — grandfather it into a
      // fresh window instead of forcing an immediate logout on deploy.
      writeSessionExpiry();
      expiresAt = readSessionExpiry();
    }

    if (isSessionExpired(expiresAt)) {
      clearStoredSession();
      return null;
    }

    return parsedUser;
  } catch (e) {
    clearStoredSession();
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(loadStoredUser);

  // Re-check periodically so a session that expires while the tab stays
  // open still logs the user out (not just on refresh/reopen).
  useEffect(() => {
    const interval = setInterval(() => {
      const expiresAt = readSessionExpiry();
      if (expiresAt !== null && isSessionExpired(expiresAt)) {
        clearStoredSession();
        setUser(null);
      }
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}
