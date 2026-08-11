-- Mandatory first-password-change support.
--
-- New users (Owner accounts created by AdminClients.jsx, and team members
-- added/reset via api/client-users.js) are created with a system-generated
-- temporary password and must_change_password = true. The Client Portal
-- route guard (App.jsx ClientRoute) redirects such a user to /client/account
-- until they set their own password via api/change-password.js, which then
-- clears the flag.
--
-- Existing users are unaffected: the column default (false) already gives
-- every pre-existing row the correct backfilled value with no separate
-- UPDATE needed — nobody who could already log in normally is newly forced
-- through this flow.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo.

alter table public.users
  add column if not exists must_change_password boolean not null default false;
