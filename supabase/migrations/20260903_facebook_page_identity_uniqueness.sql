-- Multi-tenant safety — a Meta (Facebook Page / Instagram account)
-- identity may belong to exactly ONE client.
--
-- ---------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------
-- AutoResponder_Final's `client_feature` node resolves the owning tenant
-- for an inbound Meta webhook purely by matching the page/account id
-- against client_feature_integrations.config, with LIMIT 1:
--
--   facebook :  ...?config->>pageId=eq.<channelKey>&features.slug=eq.facebook&limit=1
--   instagram:  ...?config->>instagram_account_id=eq.<channelKey>&features.slug=eq.instagram&limit=1
--
-- Nothing in this schema currently prevents two clients from storing the
-- same config->>pageId. When that happens the LIMIT-1 lookup returns
-- whichever row Postgres orders first, so one tenant's customer messages
-- are silently routed to — and answered with the AI / Welcome config of —
-- a different tenant. This was observed live (Facebook Page
-- 738298739648065 resolving to the wrong client).
--
-- The application layer now rejects a save that would claim a
-- page/account already assigned to another client (see
-- api/client-integrations.js -> providerIdentityTakenByOtherClient,
-- returning 409 FACEBOOK_PAGE_ALREADY_ASSIGNED /
-- INSTAGRAM_ACCOUNT_ALREADY_ASSIGNED). This migration adds the matching
-- database guarantee so the invariant also holds against concurrent
-- writes, direct SQL, and any future writer.
--
-- ---------------------------------------------------------------------
-- RUN ORDER — this file is NOT auto-executed and was NOT run against
-- production as part of this change.
-- ---------------------------------------------------------------------
-- The offending duplicate(s) MUST be resolved before the CREATE UNIQUE
-- INDEX statements below can succeed — a unique index cannot be built
-- over an already-duplicated key and will error out (that is the
-- intended fail-explicit behaviour; no data is touched). This migration
-- deletes / rewrites nothing.
--
-- 1. Identify duplicates (read-only):
--
--    select config->>'pageId'              as page_id,
--           array_agg(cfi.id)              as integration_ids,
--           array_agg(cfi.client_id)       as client_ids,
--           array_agg(cfi.created_at)      as created_ats
--      from public.client_feature_integrations cfi
--      join public.features f on f.id = cfi.feature_id
--     where f.slug = 'facebook'
--       and coalesce(config->>'pageId', '') <> ''
--     group by config->>'pageId'
--    having count(*) > 1;
--
--    (same query with 'instagram' / config->>'instagram_account_id' for IG)
--
-- 2. For each duplicate, keep the row on the client that legitimately
--    owns the Page and NULL out the stale key on the other client's
--    config (a targeted jsonb edit — never a row delete), e.g.:
--
--    update public.client_feature_integrations
--       set config = config - 'pageId'
--     where id = '<wrong-client integration id>';
--
-- 3. Then run this migration.
--
-- ---------------------------------------------------------------------
-- Uniqueness contract
-- ---------------------------------------------------------------------
-- ONE contract — "a Meta page/account identity maps to a single client" —
-- enforced on every table that can currently hold that identity while the
-- system is mid-transition from the legacy config jsonb
-- (client_feature_integrations, the live runtime source of truth read by
-- n8n) to the dedicated client_facebook table (schema exists per
-- 20260824/20260825, not yet wired into routing). These are not two
-- competing contracts: each index only enforces "at most one row per
-- page_id" within its own table, and the same page legitimately appearing
-- once in each table during a backfill is fine. When client_facebook
-- becomes the routing source of truth, a follow-up migration drops the
-- jsonb expression indexes and keeps the dedicated-column one.

begin;

-- ---------------------------------------------------------------------
-- Pre-flight: surface any cross-client duplicate as a WARNING so the
-- operator sees exactly which identity blocks the index (the CREATE
-- statements below then fail explicitly on the same data).
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select coalesce(config->>'pageId', config->>'instagram_account_id') as ident,
           count(distinct client_id) as clients
      from public.client_feature_integrations
     where coalesce(config->>'pageId', config->>'instagram_account_id', '') <> ''
     group by 1
    having count(distinct client_id) > 1
  loop
    raise warning
      'Meta identity % is claimed by % clients — resolve the duplicate before this migration will apply (see the header).',
      r.ident, r.clients;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Legacy / live runtime source of truth: client_feature_integrations.config
-- Partial expression unique indexes — only rows that actually carry the
-- key are indexed; an empty string is treated as "unset" (matching the
-- not-blank discipline the dedicated tables already use for channel_key).
-- ---------------------------------------------------------------------
create unique index if not exists client_feature_integrations_facebook_page_id_key
  on public.client_feature_integrations ((config->>'pageId'))
  where config ? 'pageId' and btrim(coalesce(config->>'pageId', '')) <> '';

create unique index if not exists client_feature_integrations_instagram_account_id_key
  on public.client_feature_integrations ((config->>'instagram_account_id'))
  where config ? 'instagram_account_id' and btrim(coalesce(config->>'instagram_account_id', '')) <> '';

-- ---------------------------------------------------------------------
-- Dedicated table (present per 20260824_multi_account_stage1_foundation
-- + 20260825_client_facebook_page_fields; guarded in case it is not yet
-- live in a given environment). Global partial unique on page_id — the
-- existing client_facebook_client_channel_key_key index is only
-- (client_id, channel_key), i.e. per-client, so it does NOT cover this.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_facebook' and column_name = 'page_id'
  ) then
    execute $ix$
      create unique index if not exists client_facebook_page_id_key
        on public.client_facebook (page_id)
        where page_id is not null
    $ix$;
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------
-- Explicitly NOT done here
-- ---------------------------------------------------------------------
-- - No row is deleted, moved, or rewritten. Duplicate cleanup is a
--   manual, reviewed step (see the header) — this file only adds the
--   guarantee once the data is clean.
-- - n8n is not changed: its config->>pageId / config->>instagram_account_id
--   lookup is already an exact match and stays as-is; the LIMIT 1 is now
--   safe because at most one row can carry a given identity.
-- - No RLS change on any table.
-- - client_telegram is intentionally out of scope (its routing key is a
--   per-client channelKey/bot token, not a globally-shared provider id).
