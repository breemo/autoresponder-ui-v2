// src/context/AuthContext.jsx
import React, { createContext, useContext, useState, useEffect } from "react";

// Rehydrates whatever shape Login.jsx stored in localStorage — no field
// list is enforced here. For a "client" role user, that object also
// carries client_id, client_role ("owner" | "manager" | "agent"),
// is_active, and permissions_overrides, resolved from client_users
// (see src/pages/Login.jsx). Permission enforcement based on these fields
// is not implemented yet (Phase 3A is foundation-only).
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
