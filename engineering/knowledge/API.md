# API

> Verified from repository inspection on 2026-08-10. See [[BACKEND]] for implementation, [[DATABASE]] for the tables behind the Supabase API, [[N8N_WORKFLOWS]] for the inbound webhook.

This project does not have a conventional single custom API layer. There are three distinct API surfaces in use:

## 1. First-party endpoint: `POST /api/create-whatsapp-instance`

The only custom API route in this repo (see [[BACKEND]]). Called from `src/pages/client/WhatsAppEvolutionSection.jsx`.

- **Request body** (JSON), verified shapes as sent by the frontend:
  - `{ action: "create_instance", client_id, display_name }`
  - `{ action: "connect_instance", client_id, whatsapp_id, instance_name }`
  - `{ action: "sync_instances", client_id }`
  - `{ action: "delete_instance", client_id, whatsapp_id, instance_name }`
- **Response**: whatever the upstream n8n webhook returns, relayed verbatim (status + JSON body). Observed fields consumed by the frontend: `success`, `message`, `data` (array or object; may include `qr_code`/`qrCode`/`base64`).
- No request authentication is performed by this endpoint (see [[BACKEND]]).

## 2. Supabase REST API (PostgREST) — primary data API

The frontend talks **directly** to Supabase's auto-generated REST API via `@supabase/supabase-js` (`src/lib/supabaseClient.js`) for essentially all CRUD across every table in [[DATABASE]]. There is no custom wrapper API — every page calls `supabase.from("<table>").select/insert/update/delete(...)` directly. See [[SUPABASE]] for client setup and access-control notes.

## 3. n8n inbound webhooks (external, not part of this repo's deployable code)

Defined inside the n8n workflow file (see [[N8N_WORKFLOWS]]), hosted on the separate n8n instance:

- `POST inbound/:platform/:channelKey` — generic inbound-message webhook used by Telegram/WhatsApp Evolution/etc. integrations, keyed by the `channelKey` stored in a client's `client_feature_integrations.config`.
- `POST facebook-verify` / `GET facebook-verify` — Facebook Messenger webhook verification + receiving endpoint, which then forwards the payload to the generic inbound webhook above.

These are not reachable from this repository's own deployment — they are endpoints exposed by the n8n instance itself.

## Not verifiable from this repository

- Any OpenAPI/Swagger spec (none exists).
- Full list of n8n webhook paths beyond the two above (only what's present in the workflow JSON was inspected).
