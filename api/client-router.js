import { handleClientUsers } from "./_lib/clientUsers.js";
import { handleClientAiBehavior } from "./_lib/clientAiBehavior.js";

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
// Pure, synchronous routing decision — extracted from handler() below so
// it's unit-testable (api/_lib/__tests__/clientRouting.test.js) without
// needing a real Supabase client.
export function resolveClientRoute(req) {
  const resource = req.query?.resource;
  if (resource === "users") return "users";
  if (resource === "ai-behavior") return "ai-behavior";
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

  return res.status(400).json({ success: false, message: "Unknown resource" });
}
