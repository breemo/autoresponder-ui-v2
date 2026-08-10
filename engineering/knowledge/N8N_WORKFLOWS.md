# n8n Workflows

> Verified from repository inspection on 2026-08-10. See [[AI_ENGINE]] for the AI-reply step, [[API]] for the webhook contract, [[ARCHITECTURE]] for the overall flow.

## Files in repo

- **Removed on 2026-08-10** — this repo previously contained a backup export of the workflow at `n8n flow/AutoResponder_Final-railway-6april2026.json` (workflow name: `AutoResponder_Final`, 30 nodes, 28 connection entries) plus an empty `n8n flow/test.json`. Both were deleted from the repository because the export contained hardcoded credentials (see security note below) and was confirmed to be a backup/design artifact only — not used by the live production workflow, which runs on a separately hosted n8n instance (URLs referenced elsewhere in the code point to a Railway-hosted instance, e.g. `https://n8n-production-fcd4.up.railway.app/...`, see [[DEPLOYMENT]]). `n8n flow/` is now git-ignored to prevent re-committing similar exports.
- Everything documented below in this file reflects what was inspected in that backup before removal; it has not been re-verified against the live workflow.

## Entry points (webhook nodes)

- `Webhook` — `POST inbound/:platform/:channelKey` — the main inbound-message endpoint for channel integrations (Telegram, WhatsApp Evolution, etc.).
- `facebook-webhook (POST)` and `Webhook GET` — both on path `facebook-verify` — Facebook Messenger's webhook verification (GET) and event delivery (POST).

## Node inventory (by name, verified from the workflow JSON)

Config/setup: `Config` (static JSON: Supabase URL + key — see security finding below), `Code in JavaScript`, `Code in JavaScript1`.

Inbound handling: `client_feature` (looks up `client_feature_integrations` by channel key + platform), `insert message` (writes to `messages`), `HTTP Request` (forwards Facebook payload into the generic inbound webhook using the page's recipient id as the channel key).

Auto-reply path: `auto_replies` (looks up matching rule), `IF Telegram`, `send auto reply Telegram`, `send auto reply Facebook Graph API`, `insert auto reply` (writes the outbound reply to `messages`).

AI-reply path (see [[AI_ENGINE]] for detail): `plan_supports_ai check`, `If plan_supports_ai`, `get_ai_feature_id`, `ai_feature_config`, `If reply_mode = ai`, `get_conversation_history`, `calculate_time`, `Code build_ai_prompt`, `openai_reply`, `extract_ai_reply`, `normalize_reply`.

Conversation state: `get_conversation_state`, `upsert_conversation_state`, `prepare_conversation`, `message_decision`.

Response: `Respond to Webhook1`.

## External services called (verified URLs, no credential values reproduced)

- Supabase REST API — same project used by the frontend (see [[SUPABASE]]), called directly from multiple HTTP Request nodes for `client_feature_integrations`, `messages`, `auto_replies`, `clients`/`plans`/`plan_features`/`features`, `conversation_state`.
- `https://api.telegram.org/bot<token>/sendMessage` — outbound Telegram replies.
- `https://graph.facebook.com/v18.0/me/messages` — outbound Facebook Messenger replies.
- `https://api.openai.com/v1/chat/completions` — AI reply generation (see [[AI_ENGINE]]).

## High-level flow (inferred from node names/order; exact branching logic inside Code nodes was not deep-inspected for this pass)

1. Inbound webhook receives a platform message.
2. Resolve the owning client via `client_feature_integrations` (channel key + platform).
3. Persist the inbound message.
4. Check `auto_replies` for a trigger match; if found, send it via the matching platform node and log the outbound message.
5. If no auto-reply matched, gate on the client's plan/feature/`reply_mode` for AI, pull recent conversation history, build a prompt, call OpenAI, normalize/extract the reply, and send it back.
6. Update `conversation_state` for the thread.

## 🔴 Security incident (resolved by file removal; credential rotation still pending)

A read-only scan of the backup file (before deletion) confirmed exactly **two distinct hardcoded credentials**, both in plaintext, no values reproduced anywhere:

1. **Supabase project key** — defined once in the `Config` node (`parameters.jsonOutput`, key `SUPABASE_KEY`, alongside `SUPABASE_URL`). Reused by expression reference (not re-hardcoded) in the Authorization header of 10 other HTTP Request nodes: `client_feature`, `insert message`, `auto_replies`, `insert auto reply`, `plan_supports_ai check`, `ai_feature_config`, `get_ai_feature_id`, `get_conversation_history`, `get_conversation_state`, `upsert_conversation_state`.
2. **OpenAI API key** — hardcoded in the `openai_reply` node's Authorization header (`parameters.headerParameters.parameters[0].value`).

No other hardcoded secrets were found. Two other dynamic values were checked and ruled out as file-level leaks: the Facebook Graph API node's `access_token` and the Telegram send node's `Bot Token` are both pulled at runtime from the `client_feature_integrations.config` column in Supabase (per-client, DB-stored), not hardcoded in this file.

**Status:** the backup file has been deleted from the repository (see above). Rotating the two credentials above in their respective provider dashboards (OpenAI, Supabase) is a separate, still-pending action — not performed as part of this documentation/cleanup task.

## Not verifiable from this repository

- The exact JavaScript logic inside the Code nodes (`Code in JavaScript`, `Code in JavaScript1`, `Code build_ai_prompt`, `extract_ai_reply`, `normalize_reply`, `calculate_time`, `message_decision`, `prepare_conversation`) was not transcribed into this documentation.
- Whether this exported JSON matches what is currently deployed/active on the n8n instance.
