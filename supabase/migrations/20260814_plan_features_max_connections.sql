-- Generic, per-feature connection limit for plans (Client Portal stabilization pass).
--
-- Reuses the existing plan_features join table instead of adding four
-- hardcoded per-channel columns (whatsapp_limit, facebook_limit, ...) —
-- since every channel (WhatsApp Evolution, Facebook, Telegram, Instagram)
-- is already a row in `features` unlocked per plan via `plan_features`,
-- one generic nullable integer column here covers all of them uniformly
-- and requires zero schema change to add limits for a new channel later.
--
-- null = unlimited (the default for every existing plan_features row —
-- this migration does not change any existing client's behavior).
--
-- Currently actively enforced only for WhatsApp Evolution
-- (api/create-whatsapp-instance.js, against the client_whatsapp count),
-- since it's the only channel with a real multi-connection table today.
-- Facebook/Telegram/Instagram remain capped at one connection per client by
-- the existing client_feature_integrations model (one row per client+feature)
-- — this column is forward-compatible for when/if those channels grow a
-- similar multi-connection table.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo.

alter table public.plan_features
  add column if not exists max_connections integer null;
