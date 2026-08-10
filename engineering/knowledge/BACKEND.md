# Backend

> Verified from repository inspection on 2026-08-10. See [[API]] for the endpoint contract, [[ARCHITECTURE]] for how it fits the system.

## Scope

This repository contains **exactly one** backend/server-side source file: `api/create-whatsapp-instance.js`. There is no Express/Node server, no other API route, and no server-side framework in this repo. All other data access happens directly from the frontend against Supabase's REST API (see [[SUPABASE]]) or externally inside the n8n workflow (see [[N8N_WORKFLOWS]]).

## `api/create-whatsapp-instance.js`

- A Vercel serverless function (ESM default export `handler(req, res)`), auto-deployed from the `api/` directory by Vercel's file-system routing convention — see [[DEPLOYMENT]].
- Accepts `POST` only (returns `405` otherwise).
- Behavior: reads `process.env.N8N_EVOLUTION_GATEWAY_URL`, forwards the entire incoming JSON body as-is via `fetch` (POST, `Content-Type: application/json`) to that URL, and relays back the upstream response body/status. On network/parse failure it returns a `500` with `{ success: false, message }`.
- It performs **no business logic itself** — it is a thin proxy. The actual routing by `action` (`create_instance`, `connect_instance`, `sync_instances`, `delete_instance` — as sent by `src/pages/client/WhatsAppEvolutionSection.jsx`) happens inside the n8n workflow it forwards to.
- No authentication/authorization check is present in this handler — any caller who can reach the endpoint can invoke it (client_id is taken from the request body, not derived from a verified session).

## Not verifiable from this repository

- The n8n-side logic that interprets the forwarded `action` values.
- Rate limiting, logging, or monitoring around this function.
