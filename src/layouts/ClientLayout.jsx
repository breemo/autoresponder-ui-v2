// src/layouts/ClientLayout.jsx
import React from "react";
import SharedDashboardLayout from "./SharedDashboardLayout.jsx";

export default function ClientLayout({ children }) {
  return <SharedDashboardLayout panel="client">{children}</SharedDashboardLayout>;
}
