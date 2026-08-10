# Database

> Verified from repository inspection on 2026-08-10. See [[SUPABASE]] for how the client connects, [[PROJECT_OVERVIEW]] for domain meaning.

## Important caveat

This repository contains **no SQL schema, migration files, or `supabase/` directory**. Everything below is **inferred from Supabase client calls** (`.from("table").select("columns")`, `.insert(...)`, `.update(...)`) across `src/pages/**/*.jsx`. Column types, defaults, constraints, indexes, and full column lists are **Unknown / Not available in repository** — only columns actually referenced in code are listed. Treat this as an observed, non-authoritative map of the schema.

## Tables (observed) and columns referenced in code

### `users`
Login credentials. Columns seen: `id`, `email`, `password` (compared in plaintext by `Login.jsx` — see security note below), `name`, `role` (`"admin"` | `"client"`).

### `clients`
Tenant record. Columns seen: `id`, `business_name`, `email`, `plan_id`, `is_active`, `created_at`, `phone`, `address`, `business_description`, `welcome_message`, `default_reply`, `closing_message`.
- `plan_id` → `plans.id`

### `client_users`
Join table linking a `users` row to a `clients` row. Columns seen: `client_id`, `user_id`.

### `plans`
Subscription tiers. Columns seen: `id`, `name`, `price`, `description`, `allow_self_edit`, `auto_replies_limit`, `ai_replies_limit`, `integrations_limit`, `messages_limit`.

### `subscriptions`
A client's plan enrollment over time. Columns seen: `id`, `client_id`, `plan_id`, `subscription_type` (`"trial"` | `"paid"`), `status` (`"active"`, `"cancelled"`, others referenced in UI: `"trial"`, `"expired"`, `"suspended"`, `"upgraded"`), `start_date`, `end_date`, `closed_at`, `created_at`, `messages_used`, `ai_replies_used`, `auto_replies_used`.
- `client_id` → `clients.id`, `plan_id` → `plans.id`

### `features`
Catalog of channels/capabilities. Columns seen: `id`, `name`, `slug` (e.g. `telegram`, `facebook`, `instagram`, `whatsapp`, `whatsapp_evolution`, `ai_auto_reply`), `description`, `fields` (JSON object mapping field name → input type, e.g. `password`/`number`/`url`/`text`), `created_at`.

### `plan_features`
Join table: which features a plan unlocks. Columns seen: `plan_id`, `feature_id`.
- `plan_id` → `plans.id`, `feature_id` → `features.id`

### `client_feature_integrations`
Per-client configuration/state of a feature. Columns seen: `id`, `client_id`, `feature_id`, `is_active`, `config` (JSON object of field values, e.g. `channelKey`, `Bot Token`, `Page Access Token`, `reply_mode`), `created_at`.
- `client_id` → `clients.id`, `feature_id` → `features.id`

### `messages`
Chat messages (inbound + outbound). Columns seen: `id`, `client_id`, `conversation_id`, `sender` (also referenced as `sender_id`/`from`/`psid` depending on payload shape), `message` (also referenced defensively as `text`/`body`/`content`/`reply_text`/`reply`/`response`/`answer`), `channel` / `platform`, `direction` (values seen: `in`/`inbound`/`inbound`-like and `out`/`outbound`, normalized in the UI), `reply_source` (`ai` | `auto` | `system` | `quick_reply` | `human`), `is_read`, `created_at`.
- `client_id` → `clients.id`

### `conversation_state`
Live status per conversation. Columns seen: `client_id`, `conversation_id`, `sender_id`, `platform`, `conversation_status` (values seen: `active`, `open`, `closed`, `lead_captured`, `waiting_human`), `current_step`, `updated_at`.
- `client_id` → `clients.id`

### `leads`
Contact info captured from a conversation. Columns seen: `id`, `client_id`, `conversation_id`, `name`, `phone`, `sender_id`, `created_at`.
- `client_id` → `clients.id`

### `auto_replies`
Keyword-trigger reply rules. Columns seen: `id`, `client_id`, `trigger_text`, `reply_text`, `is_active`, `created_at`.
- `client_id` → `clients.id`

### `quick_reply_templates`
Predefined quick-reply buttons. Columns seen: `id`, `client_id`, `title`, `payload`, `action_type`, `display_order`, `is_active`, `hide_after_payloads` (array), `created_at`.
- `client_id` → `clients.id`

### `whatsapp_servers`
Pool of self-hosted WhatsApp Evolution API gateway servers. Columns seen: `id`, `name`, `base_url`, `api_key`, `gateway_webhook_url`, `events_webhook_url`, `webhook_url` (legacy/alias), `integration` (e.g. `WHATSAPP-BAILEYS`), `priority`, `max_instances` (also `max_clients` alias), `is_active`.

### `client_whatsapp`
Per-client WhatsApp numbers/instances provisioned on a server. Columns seen: `id`, `client_id`, `server_id`, `instance_name`, `display_name`, `instance_id`, `channel_key`, `phone`, `status` / `connection_status`, `qr_code`, `created_at`, `updated_at`.
- `client_id` → `clients.id`, `server_id` → `whatsapp_servers.id`

## Security-relevant observation (not a secret — a design note)

`Login.jsx` authenticates by querying `users` with `.eq("email", email).eq("password", password)` from the browser — i.e. plaintext password comparison performed client-side via the Supabase anon key, with no hashing visible anywhere in the repo. Whether Supabase Row Level Security restricts this table is Unknown / Not available in repository (see [[SUPABASE]]).

## Not verifiable from this repository

- Primary/foreign key constraints, indexes, defaults, and full column lists (only code-referenced columns are documented above).
- Any tables that exist in Supabase but are never referenced by this frontend or the n8n workflow.
