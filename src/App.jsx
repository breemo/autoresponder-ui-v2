// src/App.jsx
import React from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { LanguageProvider } from "./context/LanguageContext.jsx";
import "./lib/i18n.js";
import { PERMISSIONS, hasUserPermission } from "./lib/permissions.js";
import AdminPlanFeatures from "./pages/admin/AdminPlanFeatures.jsx";

// Layouts
import AdminLayout from "./layouts/AdminLayout.jsx";
import ClientLayout from "./layouts/ClientLayout.jsx";

// Login
import Login from "./pages/Login.jsx";

// Admin pages
import AdminDashboard from "./pages/admin/AdminDashboard.jsx";
import AdminClients from "./pages/admin/AdminClients.jsx";
import AdminPlans from "./pages/admin/AdminPlans.jsx";
import AdminMessages from "./pages/admin/AdminMessages.jsx";
import AdminAutoReplies from "./pages/admin/AdminAutoReplies.jsx";
import AdminSettings from "./pages/admin/AdminSettings.jsx";
import AdminClientSettings from "./pages/admin/AdminClientSettings.jsx";
import AdminFeatures from "./pages/admin/AdminFeatures.jsx";
import AdminWhatsappServers from "./pages/admin/AdminWhatsappServers";
import AdminSystemSettings from "./pages/admin/AdminSystemSettings.jsx";

// Client pages
import ClientDashboard from "./pages/client/ClientDashboard.jsx";
import ClientMessages from "./pages/client/ClientMessages.jsx";
import ClientAutoReplies from "./pages/client/ClientAutoReplies.jsx";
import ClientSettings from "./pages/client/ClientSettings.jsx";
import ClientIntegrations from "./pages/client/ClientIntegrations.jsx";
import ClientFeatureSettings from "./pages/client/ClientFeatureSettings.jsx";
import ClientLeads from "./pages/client/ClientLeads.jsx";
import ClientQuickReplies from "./pages/client/ClientQuickReplies.jsx";
import ClientTeam from "./pages/client/ClientTeam.jsx";
import ClientAccount from "./pages/client/ClientAccount.jsx";

const ACCOUNT_PATH = "/client/account";

function AdminRoute({ children }) {
  const { user } = useAuth();
  if (!user || user.role !== "admin") return <Navigate to="/" replace />;
  return <AdminLayout>{children}</AdminLayout>;
}

// `permission` is optional — routes with no permission requirement (e.g. the
// client dashboard, or the Account page itself) stay reachable by any
// active client_users member. Routes that declare one redirect unauthorized
// users back to /client instead of rendering, so a restricted page can't be
// reached by typing its URL directly — hiding the nav link alone is not
// enough.
//
// Mandatory first-password-change gate: while must_change_password is true,
// every client route except the Account page itself redirects there. This
// is enforced here (route level), not just as a UI message, so it can't be
// bypassed by navigating straight to another client URL.
function ClientRoute({ children, permission }) {
  const { user } = useAuth();
  const location = useLocation();

  if (!user || user.role !== "client") return <Navigate to="/" replace />;

  if (user.must_change_password && location.pathname !== ACCOUNT_PATH) {
    return <Navigate to={ACCOUNT_PATH} replace />;
  }

  if (permission && !hasUserPermission(user, permission)) return <Navigate to="/client" replace />;

  return <ClientLayout>{children}</ClientLayout>;
}

export default function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Login />} />

          <Route
            path="/admin"
            element={<AdminRoute><AdminDashboard /></AdminRoute>}
          />
          <Route
            path="/admin/clients"
            element={<AdminRoute><AdminClients /></AdminRoute>}
          />
          <Route
            path="/admin/features"
            element={<AdminRoute><AdminFeatures /></AdminRoute>}
          />
          <Route
            path="/admin/messages"
            element={<AdminRoute><AdminMessages /></AdminRoute>}
          />
          <Route
            path="/admin/auto-replies"
            element={<AdminRoute><AdminAutoReplies /></AdminRoute>}
          />
          <Route
            path="/admin/plans"
            element={<AdminRoute><AdminPlans /></AdminRoute>}
          />
          <Route
            path="/admin/settings"
            element={<AdminRoute><AdminSettings /></AdminRoute>}
          />
          <Route
            path="/admin/client/:id"
            element={<AdminRoute><AdminClientSettings /></AdminRoute>}
          />
          <Route
            path="/admin/plan-features/:planId"
            element={<AdminRoute><AdminPlanFeatures /></AdminRoute>}
          />

          <Route
            path="/client"
            element={<ClientRoute permission={PERMISSIONS.DASHBOARD}><ClientDashboard /></ClientRoute>}
          />
          <Route
            path="/client/messages"
            element={<ClientRoute permission={PERMISSIONS.INBOX}><ClientMessages /></ClientRoute>}
          />
          <Route
            path="/client/leads"
            element={<ClientRoute permission={PERMISSIONS.LEADS}><ClientLeads /></ClientRoute>}
          />
          <Route
            path="/client/auto-replies"
            element={<ClientRoute permission={PERMISSIONS.AUTO_REPLIES}><ClientAutoReplies /></ClientRoute>}
          />

          <Route
            path="/client/quick-replies"
            element={<ClientRoute permission={PERMISSIONS.AUTO_REPLIES}><ClientQuickReplies /></ClientRoute>}
          />

          <Route
            path="/client/settings"
            element={<ClientRoute permission={PERMISSIONS.SETTINGS}><ClientSettings /></ClientRoute>}
          />
          <Route
            path="/client/integrations"
            element={<ClientRoute permission={PERMISSIONS.INTEGRATIONS}><ClientIntegrations /></ClientRoute>}
          />
          <Route
            path="/client/feature-settings"
            element={<ClientRoute permission={PERMISSIONS.AI_SETTINGS}><ClientFeatureSettings /></ClientRoute>}
          />
          <Route
            path="/client/team"
            element={<ClientRoute permission={PERMISSIONS.TEAM_MANAGEMENT}><ClientTeam /></ClientRoute>}
          />
          <Route
            path={ACCOUNT_PATH}
            element={<ClientRoute><ClientAccount /></ClientRoute>}
          />

          <Route
              path="/admin/settings/whatsapp-servers"
              element={
                <AdminRoute>
                  <AdminWhatsappServers />
                </AdminRoute>
              }
            />
          <Route
              path="/admin/settings/system"
              element={
                <AdminRoute>
                  <AdminSystemSettings />
                </AdminRoute>
              }
            />

        </Routes>
      </Router>
      </LanguageProvider>
    </AuthProvider>
  );
}
