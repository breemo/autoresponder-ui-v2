-- Phase 3B: Client Users / Team Management
--
-- Adds a single, narrowly-justified column: last_login_at, updated by
-- Login.jsx on every successful login (admin and client). Used by the new
-- Team page to show "last login" per member, per the feature spec.
--
-- No other schema changes are required for Phase 3B. Invitation/onboarding
-- deliberately reuses the existing users.password + client_users.is_active
-- columns instead of adding new invitation-state columns (see the
-- implementation report for the reasoning).
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo.

alter table public.users
  add column if not exists last_login_at timestamptz;
