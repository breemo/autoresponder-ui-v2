# Architecture

> Verified from repository inspection on 2026-08-10. See [[PROJECT_OVERVIEW]] for domain concepts.

## System components

1. **Frontend SPA** (`src/`, deployed on Vercel — see [[DEPLOYMENT]])
   React app that talks **directly to Supabase** from the browser (via the anon key) for almost all reads/writes, and to one first-party endpoint (`/api/create-whatsapp-instance`) for WhatsApp instance orchestration.

2. **Supabase** (external, hosted)
   Postgres database exposed through its auto-generated REST API (PostgREST). System of record for every entity in [[DATABASE]]. No Supabase Auth is used — login is custom (see [[SUPABASE]]).

3. **n8n workflow** (external, hosted separately from this repo — see [[N8N_WORKFLOWS]])
   Receives inbound platform webhooks (Telegram/Facebook/WhatsApp Evolution), resolves the owning client, stores messages directly into Supabase via its REST API, matches auto-reply rules or calls OpenAI for AI replies (see [[AI_ENGINE]]), sends the reply back to the origin platform, and updates conversation state. This runs independently of the frontend and of `api/`.

4. **WhatsApp Evolution API servers** (external, self-hosted, one or more)
   Registered per-server in the `whatsapp_servers` table. Both the Vercel function and the n8n workflow talk to these for instance creation, QR-code connection, and sync.

5. **OpenAI API** (external)
   Called only from the n8n workflow (not from this repo's frontend or `api/` code) to generate AI auto-replies.

## Request/data flows (verified)

**Inbound customer message (any channel):**
Platform → n8n webhook (`inbound/:platform/:channelKey`) → resolve `client_feature_integrations` by channel key/platform → insert row into `messages` → check `auto_replies` for a trigger match → if none and the client's plan+feature+`reply_mode` allow it, build a prompt from recent `messages` history and call OpenAI → send reply via the platform's API (Telegram `sendMessage` / Facebook Graph API) → insert outbound `messages` row → upsert `conversation_state`.

**Admin/Client portal CRUD:**
Browser → Supabase REST API directly (via `src/lib/supabaseClient.js`). There is no custom backend API layer for reading/writing clients, plans, features, messages, leads, auto-replies, quick replies, etc. — see [[SUPABASE]] and [[DATABASE]].

**WhatsApp number provisioning:**
Client UI → `POST /api/create-whatsapp-instance` (Vercel serverless function, see [[BACKEND]]) → forwards to the n8n gateway webhook (`N8N_EVOLUTION_GATEWAY_URL`) → n8n calls the assigned Evolution API server and writes to `client_whatsapp`.

## Authentication & authorization model

- No Supabase Auth / JWT session. Login (`src/pages/Login.jsx`) queries the `users` table directly for a matching `email` + `password` row (plaintext comparison in the query) and stores the result in `localStorage`.
- Role gating (`admin` vs `client`) is enforced only client-side, in React Router route guards (`AdminRoute`/`ClientRoute` in `src/App.jsx`) that read the locally-stored user object.
- Whether server-side authorization (e.g. Supabase Row Level Security) is configured is **Unknown / Not available in repository** — no SQL/migration/policy files exist in this repo; RLS, if any, would be configured directly in the Supabase project.

## Not verifiable from this repository

- Any infrastructure diagram, environment topology, or hosting account details beyond what's in `vercel.json` and code-referenced URLs.
- Whether the n8n instance and Evolution API servers are containerized, their scaling, or their uptime/ops setup.
