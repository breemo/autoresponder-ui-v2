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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  // تحميل المستخدم من التخزين المحلي، مع التحقق من انتهاء الجلسة
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) return;

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
        return;
      }

      setUser(parsedUser);
    } catch (e) {
      clearStoredSession();
    }
  }, []);

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
