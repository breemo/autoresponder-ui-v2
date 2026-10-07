// src/layouts/ClientLayout.jsx
import React from "react";
import ClientShell from "./ClientShell.jsx";

// The Client Portal has its own compact shell; the Admin Portal keeps
// SharedDashboardLayout (see AdminLayout.jsx) unchanged.
export default function ClientLayout({ children }) {
  return <ClientShell>{children}</ClientShell>;
}
