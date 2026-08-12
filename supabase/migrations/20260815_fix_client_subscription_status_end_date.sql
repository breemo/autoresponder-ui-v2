-- Fixes client_subscription_status.is_active's end_date comparison.
--
-- The original definition (20260814_client_subscription_status_view.sql)
-- used `end_date >= now()`, which flips a subscription to inactive partway
-- through its expiration DAY, the moment the exact timestamp passes. The
-- intended business rule is that a subscription stays active for the
-- entire end_date calendar day and only becomes expired the following day.
--
-- This has ALREADY been applied manually, directly on the live Supabase
-- view, per the project owner. This migration brings the repository's
-- source-of-truth definition back in sync with what's actually running —
-- re-running it is a safe no-op against an already-corrected live view
-- (CREATE OR REPLACE VIEW is idempotent).
--
-- No change to the architecture: this remains a read-only, informational
-- view for the Client Portal (SubscriptionBanner, dashboard subscription
-- card, UI-only button hints). It is not read by any server-side API for
-- authorization/entitlement decisions — n8n remains the sole authoritative
-- source for subscription/plan entitlement at message-processing time.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) if you want the repository definition to be what's
-- literally executed again in the future — it is not executed
-- automatically by this repo, and the live view is already correct.

create or replace view public.client_subscription_status as
select distinct on (s.client_id)
  s.client_id,
  s.id as subscription_id,
  s.status,
  s.subscription_type,
  s.end_date,
  (
    s.status in ('active', 'trial')
    and (s.end_date is null or s.end_date::date >= current_date)
  ) as is_active
from public.subscriptions s
order by s.client_id, s.created_at desc;

grant select on public.client_subscription_status to anon, authenticated;
