// src/layouts/AdminLayout.jsx
import React from "react";
import SharedDashboardLayout from "./SharedDashboardLayout.jsx";

export default function AdminLayout({ children }) {
  return <SharedDashboardLayout panel="admin">{children}</SharedDashboardLayout>;
}
