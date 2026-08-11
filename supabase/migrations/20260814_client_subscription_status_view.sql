-- Read-model / UX helper for "is this client's subscription currently
-- active", for the Client Portal only — read-only view, no data changes,
-- safe to (re)create.
--
-- Architecture note: n8n already contains the authoritative subscription /
-- plan entitlement logic (whether the client has a subscription, whether
-- it's active/expired, whether the plan allows sending, supports AI, etc.),
-- checked early in its own processing workflows against this same
-- Supabase data. This view does NOT feed into or replace that — it exists
-- solely so the web app can show an informational status (a banner, a
-- disabled button) without querying `subscriptions` ad hoc in multiple
-- places. It is intentionally not used by any server-side API for
-- authorization or entitlement decisions — those defer to n8n.
--
-- A client's "current" subscription is its most recent subscriptions row
-- (existing app code already assumes at most one status='active' row per
-- client at a time — see AdminClientSettings.jsx's saveSubscription(),
-- which cancels any existing active row before inserting a new one).
--
-- is_active is computed as status in ('active','trial') AND the row hasn't
-- passed its end_date. This deliberately differs from the simpler
-- `status === 'active'` check already used for display in
-- AdminClientSettings.jsx — nothing in this app currently auto-transitions
-- a subscription's status to 'expired' when end_date passes, so an
-- end_date-aware check is the only correct way to detect real expiry here.
-- That admin-page display convention is left untouched by this migration.
--
-- Used by (UI only):
--   - src/components/SubscriptionBanner.jsx (client-portal banner)
--   - src/pages/client/ClientIntegrations.jsx (informational button state)
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo.

create or replace view public.client_subscription_status as
select distinct on (s.client_id)
  s.client_id,
  s.id as subscription_id,
  s.status,
  s.subscription_type,
  s.end_date,
  (
    s.status in ('active', 'trial')
    and (s.end_date is null or s.end_date >= now())
  ) as is_active
from public.subscriptions s
order by s.client_id, s.created_at desc;

-- The frontend (SubscriptionBanner.jsx, ClientIntegrations.jsx) reads this
-- view directly via the anon key, same as every other table in this app.
-- Explicit grant so it's readable even if the project's default privileges
-- don't already extend to new views. This only exposes the columns
-- selected above (client_id, status, end_date, is_active) — no other
-- subscription/billing detail.
grant select on public.client_subscription_status to anon, authenticated;
