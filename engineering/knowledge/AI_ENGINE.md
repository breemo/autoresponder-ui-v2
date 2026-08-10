# AI Engine

> Verified from repository inspection on 2026-08-10. See [[N8N_WORKFLOWS]] for the surrounding workflow, [[DATABASE]] for the tables involved.

## Location

There is **no AI code in this repository's frontend (`src/`) or backend (`api/`)**. All AI reply generation happens inside the external n8n workflow (`n8n flow/AutoResponder_Final-railway-6april2026.json`), specifically the `openai_reply` node and its supporting nodes. See [[N8N_WORKFLOWS]].

## Provider & model (verified)

- Provider: OpenAI, called via direct HTTP POST to `https://api.openai.com/v1/chat/completions` from the `openai_reply` node.
- Model: `gpt-4o-mini` (present in the node's request body).
- Request shape observed: single-message `messages` array with one `user`-role message built from a `prompt` field produced upstream.

## Gating logic (verified from node names/connections, not from full code inspection)

AI replies are only attempted when all of the following hold, in this order:
1. No matching rule was found in `auto_replies` for the inbound message (see [[N8N_WORKFLOWS]] flow).
2. The client's subscribed plan includes the `ai_auto_reply` feature (`plan_supports_ai check` queries `clients → plans → plan_features → features.slug = ai_auto_reply`).
3. The client has that feature enabled and configured (`ai_feature_config` reads `client_feature_integrations` for the `ai_auto_reply` feature), gated further by an `If reply_mode = ai` check against the integration's `config.reply_mode` value.

## Context building (verified at a structural level)

- `get_conversation_history` fetches up to 5 recent `messages` rows for the same client + sender, filtered to a recent time window computed by `calculate_time`.
- `Code build_ai_prompt` assembles the actual prompt sent to OpenAI. Its exact template/wording was **not transcribed** into this documentation (see Not verifiable, below).
- `extract_ai_reply` and `normalize_reply` process the OpenAI response before it's sent back to the customer and logged to `messages` with `reply_source = "ai"`.

## Configuration surface visible from the frontend

The `ai_auto_reply` feature's config fields (stored per-client in `client_feature_integrations.config`) are editable through `AdminClientSettings.jsx` / `ClientFeatureSettings.jsx`, described in the UI as controlling "reply tone and business info" — the concrete field names are data-driven from the `features.fields` JSON for that feature, not hardcoded in the frontend, so the exact field set is **Unknown / Not available in repository** without querying the live `features` table.

## Not verifiable from this repository

- The exact system/user prompt template (built inside an n8n Code node, not transcribed here per task scope).
- Token limits, temperature, or other OpenAI request parameters beyond `model` and `messages`.
- Any evaluation, guardrails, or moderation step around AI output.
