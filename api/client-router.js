import { handleClientUsers } from "./_lib/clientUsers.js";
import { handleClientAiBehavior } from "./_lib/clientAiBehavior.js";
import { handleClientLocations } from "./_lib/clientLocations.js";
import { handleChangePassword } from "./_lib/changePassword.js";
import { handleAuthLogin } from "./_lib/authLogin.js";

// Vercel Hobby Function-count consolidation — merges the former top-level
// api/client-users.js (Team Management) and api/client-ai-behavior.js
// (AI Behavior settings) under one deployed Vercel Function. Behavior,
// auth, and response shapes are completely unchanged from both originals
// (see api/_lib/clientUsers.js and api/_lib/clientAiBehavior.js) — only
// the routing/file layer and public URL are new. See the deployment-
// failure inspection report for why these two were grouped (both are
// client-scoped-actor endpoints, frontend-only callers) and why
// api/client-integrations.js was deliberately left out of this merge
// (its one frontend caller, ClientIntegrations.jsx, has unrelated pending
// local changes that must not be touched by this fix).
//
// Selected via ?resource= because both domains are already POST+action-
// body shaped internally (client-ai-behavior is method-shaped, not
// action-shaped, but the same query param cleanly disambiguates both) —
// no request body field needed to change for either caller, only the URL.
//
// Shape:
//   GET  /api/client-router?resource=users&actor_user_id=...
//   POST /api/client-router?resource=users     { action, actor_user_id, ... }
//     -> former api/client-users.js, unchanged
//   GET  /api/client-router?resource=ai-behavior&actor_user_id=&client_id=
//   POST /api/client-router?resource=ai-behavior { actor_user_id, client_id?, ... }
//     -> former api/client-ai-behavior.js, unchanged
//   GET  /api/client-router?resource=locations&actor_user_id=&client_id=
//   POST /api/client-router?resource=locations { action, actor_user_id, client_id?, ... }
//     -> api/_lib/clientLocations.js (AI Engine V1 — Business Voice +
//     Authoritative Locations; new, not a merge of a former top-level file)
//   POST /api/client-router?resource=password { user_id, current_password,
//        new_password, confirm_password }
//     -> former api/change-password.js, unchanged (api/_lib/changePassword.js).
//        Own trust model: re-verifies the caller's current password, no
//        actor_user_id / team_management check.
//   POST /api/client-router?resource=login { email, password }
//     -> api/_lib/authLogin.js (Security C2: server-side credential check,
//        replaces the browser's direct `users` query). Own trust model: no
//        actor_user_id; returns a sanitized user only, issues no session.
// Pure, synchronous routing decision — extracted from handler() below so
// it's unit-testable (api/_lib/__tests__/clientRouting.test.js) without
// needing a real Supabase client.
export function resolveClientRoute(req) {
  const resource = req.query?.resource;
  if (resource === "users") return "users";
  if (resource === "ai-behavior") return "ai-behavior";
  if (resource === "locations") return "locations";
  if (resource === "password") return "password";
  if (resource === "login") return "login";
  return null;
}

export default async function handler(req, res) {
  const route = resolveClientRoute(req);

  if (route === "users") {
    return handleClientUsers(req, res);
  }
  if (route === "ai-behavior") {
    return handleClientAiBehavior(req, res);
  }
  if (route === "locations") {
    return handleClientLocations(req, res);
  }
  if (route === "password") {
    return handleChangePassword(req, res);
  }
  if (route === "login") {
    return handleAuthLogin(req, res);
  }

  return res.status(400).json({ success: false, message: "Unknown resource" });
}
