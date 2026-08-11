// src/context/AuthContext.jsx
import React, { createContext, useContext, useState, useEffect } from "react";

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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  // تحميل المستخدم من التخزين المحلي
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) {
      try {
        setUser(JSON.parse(stored));
      } catch (e) {
        localStorage.removeItem("user");
      }
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}
