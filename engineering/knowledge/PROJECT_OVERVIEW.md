# Project Overview

> Verified from repository inspection on 2026-08-10. See [[ARCHITECTURE]] for system structure, [[DATABASE]] for schema.

## What this project is

Auto Responder is a multi-tenant SaaS platform for automating customer-messaging replies across Telegram, Facebook Messenger, Instagram, and WhatsApp. It has two portals in one React SPA:

- **Admin portal** (`/admin/*`) — manage clients (tenants), subscription plans, features/integrations catalog, cross-client message monitoring, and WhatsApp connection servers.
- **Client portal** (`/client/*`) — a tenant's own dashboard: conversations/inbox, leads captured from chats, auto-reply rules, quick-reply buttons, channel integrations, and account settings.

## Core domain concepts (verified via code usage, see [[DATABASE]])

- **Client** — a tenant/business using the platform (`clients` table). Linked to a `Plan` and to one `users` row for login.
- **Plan** — a subscription tier (`plans`) with numeric limits (messages, AI replies, auto replies, integrations) and a flag (`allow_self_edit`) controlling whether the client can edit their own feature settings.
- **Subscription** — a client's plan enrollment over time (`subscriptions`), with `trial`/`paid` type, status, start/end dates, and usage counters.
- **Feature** — a channel or capability definition (`features`, e.g. `telegram`, `facebook`, `instagram`, `whatsapp`, `whatsapp_evolution`, `ai_auto_reply`), each with a dynamic set of config `fields`.
- **Plan → Feature** — which features a plan unlocks (`plan_features` join table).
- **Client Feature Integration** — a client's per-feature configuration and on/off state (`client_feature_integrations`), e.g. bot tokens, webhook channel keys, AI reply mode.
- **Message / Conversation** — inbound/outbound chat messages (`messages`) grouped into conversations, with live status tracked in `conversation_state`.
- **Lead** — contact info captured during a conversation (`leads`).
- **Auto Reply** — keyword-trigger → canned response rules per client (`auto_replies`).
- **Quick Reply** — predefined reply buttons/templates per client (`quick_reply_templates`).
- **WhatsApp Server / Instance** — a pool of self-hosted "Evolution API" WhatsApp gateway servers (`whatsapp_servers`) and the per-client WhatsApp numbers provisioned on them (`client_whatsapp`).

## Stack at a glance (details in linked docs)

- Frontend: React 18 + Vite + Tailwind CSS SPA — see [[FRONTEND]]
- Data layer: Supabase (Postgres + auto-generated REST API), accessed directly from the browser — see [[SUPABASE]], [[DATABASE]]
- Automation/AI: an external n8n workflow handles inbound platform webhooks, auto-reply matching, and AI replies — see [[N8N_WORKFLOWS]], [[AI_ENGINE]]
- One custom backend endpoint (Vercel serverless function) proxies WhatsApp instance management to n8n — see [[BACKEND]], [[API]]
- Hosting/build: Vercel — see [[DEPLOYMENT]]

## Not verifiable from this repository

- Product roadmap / business goals beyond what's inferable from the code — see `engineering/knowledge/ROADMAP.md` (not modified by this task).
- Team, ownership, or release history.
