# Frontend

> Verified from repository inspection on 2026-08-10. See [[ARCHITECTURE]] for how the frontend fits the system, [[SUPABASE]] for data access.

## Stack

- React 18.3, bundled with Vite 5 (`vite.config.js`: `base: './'` — required for correct asset paths on Vercel)
- Routing: `react-router-dom` v6 (`BrowserRouter`)
- Styling: Tailwind CSS (v3 config present in `tailwind.config.js`; `@tailwindcss/postcss` v4 also listed as a devDependency — **Unknown / Not available in repository** which major version is actually in effect)
- Charts: `recharts`
- Icons: `@heroicons/react`
- Data client: `@supabase/supabase-js`

## Entry point & app shell

- `src/main.jsx` → mounts `<App />` (`src/App.jsx`) into `#root`, wrapped in `React.StrictMode`.
- `App.jsx` wraps everything in `AuthProvider` (`src/context/AuthContext.jsx`) and `BrowserRouter`.
- `AuthContext` is a simple React Context backed by `localStorage["user"]` — no Supabase Auth session (see [[ARCHITECTURE]]).
- Two role-gated route wrappers defined inline in `App.jsx`: `AdminRoute` and `ClientRoute`, each redirecting to `/` if `user.role` doesn't match, and wrapping children in the shared layout.
- Single shared layout component `src/layouts/SharedDashboardLayout.jsx` (sidebar + header) is used for both portals via thin wrappers `AdminLayout.jsx` / `ClientLayout.jsx` (prop `panel="admin"|"client"`).

## Routes (from `src/App.jsx`)

| Path | Page component |
|---|---|
| `/` | `pages/Login.jsx` |
| `/admin` | `pages/admin/AdminDashboard.jsx` |
| `/admin/clients` | `pages/admin/AdminClients.jsx` |
| `/admin/features` | `pages/admin/AdminFeatures.jsx` |
| `/admin/messages` | `pages/admin/AdminMessages.jsx` |
| `/admin/auto-replies` | `pages/admin/AdminAutoReplies.jsx` |
| `/admin/plans` | `pages/admin/AdminPlans.jsx` |
| `/admin/settings` | `pages/admin/AdminSettings.jsx` |
| `/admin/settings/whatsapp-servers` | `pages/admin/AdminWhatsappServers.jsx` |
| `/admin/client/:id` | `pages/admin/AdminClientSettings.jsx` |
| `/admin/plan-features/:planId` | `pages/admin/AdminPlanFeatures.jsx` |
| `/client` | `pages/client/ClientDashboard.jsx` |
| `/client/messages` | `pages/client/ClientMessages.jsx` |
| `/client/leads` | `pages/client/ClientLeads.jsx` |
| `/client/auto-replies` | `pages/client/ClientAutoReplies.jsx` |
| `/client/quick-replies` | `pages/client/ClientQuickReplies.jsx` |
| `/client/settings` | `pages/client/ClientSettings.jsx` |
| `/client/integrations` | `pages/client/ClientIntegrations.jsx` |
| `/client/feature-settings` | `pages/client/ClientFeatureSettings.jsx` (renders `AdminClientSettings` with the current client's id — reuses the admin page in read/self-edit mode) |

## Page responsibilities (one line each)

- **AdminDashboard** — cross-client stats (message volume, active clients, response rate) and recent-conversation/integration widgets.
- **AdminClients** — CRUD for clients, creates a linked `users` row + optional `subscriptions` row on creation.
- **AdminClientSettings** — per-client feature configuration drawer, subscription management (create/renew/cancel), usage stats.
- **AdminFeatures** — CRUD for the `features` catalog, including dynamic config-field definitions.
- **AdminMessages** — cross-client conversation viewer (groups `messages` by `conversation_id`/thread heuristics).
- **AdminPlanFeatures** — toggles which features belong to a plan (`plan_features`).
- **AdminPlans** — CRUD for subscription plans and their limits.
- **AdminSettings** — static settings hub linking to sub-pages (most cards are placeholders, only the WhatsApp servers link is wired).
- **AdminWhatsappServers** — CRUD for `whatsapp_servers` (Evolution API gateway pool).
- **ClientDashboard** — per-client stats, live conversations, AI-reply-source breakdown, quick links.
- **ClientMessages** — per-client conversation inbox with status update (open/close).
- **ClientAutoReplies** — CRUD for the client's `auto_replies`, enforcing the plan's `auto_replies_limit`.
- **ClientQuickReplies** — CRUD for `quick_reply_templates`.
- **ClientSettings** — business profile fields, welcome/default/closing messages, password change.
- **ClientIntegrations** — enable/configure the client's `client_feature_integrations`; embeds `WhatsAppEvolutionSection.jsx` when the WhatsApp Evolution feature is selected.
- **ClientLeads** — read-only table of captured `leads` with copy/WhatsApp-link actions.
- **ClientFeatureSettings** — resolves the logged-in client's id, then renders `AdminClientSettings`.
- **WhatsAppEvolutionSection** (component, used only inside `ClientIntegrations`) — manages `client_whatsapp` numbers via `/api/create-whatsapp-instance` (create/connect/sync/delete), including QR-code polling.

## Dead / unused code (verified — not imported anywhere in the app)

- `src/pages/AutoReplies.jsx`, `Campaigns.jsx`, `ClientAutoReplies.jsx`, `ClientDashboard.jsx`, `ClientMessages.jsx`, `ClientSettings.jsx`, `ClientUsers.jsx`, `Clients.jsx`, `ManageUsers.jsx`, `Messages.jsx`, `MessagesLog.jsx`, `Plans.jsx`, `Settings.jsx` — legacy root-level page files superseded by `pages/admin/*` and `pages/client/*`; none are referenced by any import in `src/`.
- `src/components/Navbar.jsx` and `src/components/Loader.jsx` — not imported anywhere in `src/`.
- `src/components/FeatureSelector.jsx` — only imported by the orphaned root-level pages above, so it is not reachable from the live app either.

## Language / UX notes

UI copy is predominantly Arabic (with `dir="rtl"` on most pages), mixed with English labels/headings; some pages set `dir="ltr"` for message-log-style layouts.

## Not verifiable from this repository

- Any automated frontend test suite — none found (no test files or test runner config in `package.json`).
- Design system documentation beyond inline Tailwind classes.
