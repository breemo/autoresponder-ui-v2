-- Multilingual foundation: persisted UI language preference.
--
-- UI language only (ar/en) — completely separate from AI reply language,
-- customer conversation language, welcome-message content, Auto Reply
-- content, or any other business/customer data. Nothing here changes what
-- language a client's customers are served in; it only controls which
-- language the Admin/Client Portal itself renders in for a given account.
--
-- Two columns, following the existing schema conventions in this repo:
--
-- 1. clients.default_language — the account-wide default (Client Settings
--    page: "اللغة الافتراضية / Default Language"). Applies to every
--    teammate who hasn't set a personal preference of their own.
--
-- 2. client_users.language — the per-employee override (My Account page).
--    Deliberately added to client_users, NOT users: this is a per-*
--    -membership* preference, exactly like the role/is_active/
--    permissions_overrides columns already on this table (see
--    20260811_client_users_role_status_permissions.sql). users has no
--    other per-client concept on it, and someone's UI language is a
--    property of how they use THIS client's portal, not a global property
--    of their login row. Nullable: no value = "no personal preference set"
--    = fall through to the client default, then to the system fallback.
--
-- Resolution order (implemented in src/context/LanguageContext.jsx):
--   1. client_users.language for the acting membership, if set.
--   2. clients.default_language, if set.
--   3. System fallback = 'ar'.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change. The application already handles
-- these columns not existing yet: Login.jsx's language fetch and both
-- LanguageContext.jsx persistence functions are wrapped so a missing
-- column degrades to the system fallback / a local-only (non-persisted)
-- language switch, never a broken login or a crash.
--
-- NOTE: public.client_users.language has already been added manually to
-- the live database. This file is still kept fully idempotent (IF NOT
-- EXISTS columns, existence-checked constraints via DO blocks) so it is
-- safe to run — a no-op — against an environment where it's already
-- applied, and works cleanly on a fresh dev database where it isn't.

begin;

alter table public.clients
  add column if not exists default_language text null;

alter table public.client_users
  add column if not exists language text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_default_language_check'
  ) then
    alter table public.clients
      add constraint clients_default_language_check
      check (default_language is null or default_language in ('ar', 'en'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'client_users_language_check'
  ) then
    alter table public.client_users
      add constraint client_users_language_check
      check (language is null or language in ('ar', 'en'));
  end if;
end $$;

commit;
