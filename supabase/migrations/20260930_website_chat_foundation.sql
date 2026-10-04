-- Website Chat — Phase 2 foundation (product schema only).
--
-- Run this manually against EACH Supabase project (SQL editor / your own
-- tooling) — it is NOT executed automatically by this repo. Idempotent; no
-- existing row, column or policy changes. The only change to existing
-- schema is step 2b: the global UNIQUE (client_id, feature_id) on
-- client_feature_integrations is replaced by an equivalent partial unique
-- index that excludes only the website_chat feature (existing features keep
-- the same guarantee). client_feature_integrations.created_at is NOT
-- altered (timestamp or timestamptz both work with this migration and code).
--
-- ---------------------------------------------------------------------
-- Model
-- ---------------------------------------------------------------------
-- * Each Website Chat site is one row in the EXISTING
--   public.client_feature_integrations table (feature slug 'website_chat'),
--   so the existing n8n `client_feature` lookup
--   (config->>channelKey + features.slug) will resolve it in the later n8n
--   phase without new routing. Several rows per client = several sites.
--   config (written only by api/_lib/websiteChatAccounts.js):
--     { "channelKey": "wc_<random>",   -- internal routing key, never sent to browsers
--       "publicKey":  "wcpk_<random>", -- embed-snippet key
--       "keyVersion": 1,
--       "displayName": "Main website",
--       "allowedDomains": ["example.com", "*.example.com"],
--       "reply_mode": "ai" }
-- * public.website_chat_visitors: one row per anonymous visitor/session.
--   Stores only a SHA-256 hash of the visitor bearer token.
--
-- NOTE (separate security task D4): client_feature_integrations is currently
-- readable/writable with the public anon key (pre-existing). That must be
-- fixed before the Website Chat PROD launch. The new visitors table below is
-- server-only (RLS enabled, zero policies, anon/authenticated revoked).

begin;

-- 1. Feature catalogue row (product data). Not attached to any plan here —
--    plans get it (plan_features + max_connections = max sites) through the
--    existing admin screens when the feature is ready to be offered.
insert into public.features (name, slug, description)
select 'Website Chat', 'website_chat', 'Embeddable chat widget for the client''s own website.'
where not exists (select 1 from public.features where slug = 'website_chat');

-- 2. client_feature_integrations: composite key for tenant-safe FKs, and
--    global uniqueness of Website Chat keys (only rows that carry a
--    publicKey, i.e. Website Chat rows, are indexed).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.client_feature_integrations'::regclass
       and conname = 'client_feature_integrations_id_client_id_key'
  ) then
    alter table public.client_feature_integrations
      add constraint client_feature_integrations_id_client_id_key unique (id, client_id);
  end if;
end $$;

create unique index if not exists client_feature_integrations_website_chat_public_key_key
  on public.client_feature_integrations ((config->>'publicKey'))
  where config ? 'publicKey';

create unique index if not exists client_feature_integrations_website_chat_channel_key_key
  on public.client_feature_integrations ((config->>'channelKey'))
  where config ? 'publicKey';

-- 2b. Multi-site: allow several Website Chat sites per client while keeping
--     (client_id, feature_id) unique for EVERY OTHER feature.
--
--     Why Website Chat is excluded: one client_feature_integrations row = one
--     website, so a client with two websites has two (client_id, website_chat)
--     rows. Each Website Chat row stays unique through the publicKey /
--     channelKey indexes above, and site creation is serialized + plan-limited
--     by create_website_chat_integration (step 5). Every other feature
--     (Telegram, Facebook, Instagram, WhatsApp Evolution, ai_auto_reply, ...)
--     keeps exactly today's one-row-per-(client_id, feature_id) guarantee,
--     which existing code relies on (.maybeSingle() lookups, n8n
--     whatsapp_evolution `limit=1`).
--
--     The pre-existing global unique (DEV: client_feature_integrations_
--     client_id_feature_id_key; it predates this repo's migrations) is
--     REPLACED, never just dropped:
--       1. resolve the website_chat feature id (inserted in step 1);
--       2. abort if any non-website feature already has duplicate
--          (client_id, feature_id) groups;
--       3. create the replacement partial unique index FIRST (predicate must
--          be immutable, so the environment's actual feature id is embedded
--          as a literal via EXECUTE — DEV and PROD get the same index name
--          with their own id);
--       4. only then remove the old global unique, whether it is a table
--          constraint or a standalone unique index.
--     All inside this migration's single transaction: any failure rolls
--     everything back and the old global unique stays in place.
--
--     Rollback (manual; only valid while every client has at most ONE
--     website_chat row — remove extra sites first):
--       create unique index client_feature_integrations_client_id_feature_id_key
--         on public.client_feature_integrations (client_id, feature_id);
--       -- (or, if it was a constraint originally:
--       --  alter table public.client_feature_integrations
--       --    add constraint client_feature_integrations_client_id_feature_id_key unique (client_id, feature_id);)
--       drop index public.client_feature_integrations_client_feature_non_website_key;
--     If the website_chat feature row is ever deleted and recreated with a
--     new id, new Website Chat rows fall back under the uniqueness rule (one
--     site per client) — fails safe.
do $$
declare
  v_wc_feature_id uuid;
  v_dups integer;
begin
  select id into v_wc_feature_id from public.features where slug = 'website_chat';
  if v_wc_feature_id is null then
    raise exception 'website_chat feature row missing';
  end if;

  select count(*) into v_dups from (
    select client_id, feature_id
      from public.client_feature_integrations
     where feature_id is distinct from v_wc_feature_id
     group by client_id, feature_id
    having count(*) > 1
  ) d;
  if v_dups > 0 then
    raise exception 'client_feature_integrations has % duplicate (client_id, feature_id) groups for non-website features; aborting', v_dups;
  end if;

  -- new protection first
  if to_regclass('public.client_feature_integrations_client_feature_non_website_key') is null then
    execute format(
      'create unique index client_feature_integrations_client_feature_non_website_key
         on public.client_feature_integrations (client_id, feature_id)
         where feature_id <> %L::uuid',
      v_wc_feature_id
    );
  end if;

  -- then retire the global unique (constraint or bare index)
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.client_feature_integrations'::regclass
       and conname = 'client_feature_integrations_client_id_feature_id_key'
  ) then
    alter table public.client_feature_integrations
      drop constraint client_feature_integrations_client_id_feature_id_key;
  elsif to_regclass('public.client_feature_integrations_client_id_feature_id_key') is not null then
    drop index public.client_feature_integrations_client_id_feature_id_key;
  end if;
end $$;

-- 3. Visitors / sessions.
create table if not exists public.website_chat_visitors (
  id uuid primary key default gen_random_uuid(),           -- visitor_id == Conversation V2 sender_id
  client_id uuid not null references public.clients (id) on delete cascade,
  integration_id uuid not null,
  token_hash text not null,                                -- sha256(bearer token), hex; raw token never stored
  token_expires_at timestamptz not null,
  revoked_at timestamptz null,
  key_version integer not null default 1,                  -- config.keyVersion at issuance (key rotation)
  origin_host text null,                                   -- validated parent host at issuance
  created_ip_hash text null,                               -- keyed hash, for the session rate limit
  poll_window_started_at timestamptz null,
  poll_window_count integer not null default 0,
  send_window_started_at timestamptz null,
  send_window_count integer not null default 0,
  send_day_started_at timestamptz null,
  send_day_count integer not null default 0,
  last_client_message_id text null,                        -- duplicate-send guard
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint website_chat_visitors_integration_fk
    foreign key (integration_id, client_id)
    references public.client_feature_integrations (id, client_id) on delete cascade,
  constraint website_chat_visitors_token_hash_key unique (token_hash),
  constraint website_chat_visitors_token_hash_format_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint website_chat_visitors_counts_check
    check (poll_window_count >= 0 and send_window_count >= 0 and send_day_count >= 0)
);

create index if not exists website_chat_visitors_session_rate_idx
  on public.website_chat_visitors (integration_id, created_ip_hash, created_at);
create index if not exists website_chat_visitors_client_idx
  on public.website_chat_visitors (client_id);

alter table public.website_chat_visitors enable row level security;
revoke all on public.website_chat_visitors from anon, authenticated;

-- 4. Atomic per-visitor rate windows + duplicate-send guard.
--    Limits are passed in by api/_lib/websiteChatLimits.js (kept in code).
--    Returns: 'ok' | 'rate_limited' | 'duplicate' | 'not_found'.
create or replace function public.website_chat_visitor_hit(
  p_visitor_id uuid,
  p_kind text,                       -- 'poll' | 'send'
  p_minute_max integer,
  p_day_max integer default null,    -- send only
  p_client_message_id text default null
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v public.website_chat_visitors%rowtype;
  v_now timestamptz := now();
begin
  select * into v from public.website_chat_visitors where id = p_visitor_id for update;
  if not found then
    return 'not_found';
  end if;

  if p_kind = 'poll' then
    if v.poll_window_started_at is null or v_now - v.poll_window_started_at >= interval '60 seconds' then
      v.poll_window_started_at := v_now;
      v.poll_window_count := 0;
    end if;
    if v.poll_window_count >= p_minute_max then
      return 'rate_limited';
    end if;
    update public.website_chat_visitors
       set poll_window_started_at = v.poll_window_started_at,
           poll_window_count = v.poll_window_count + 1,
           last_seen_at = v_now
     where id = p_visitor_id;
    return 'ok';
  end if;

  if p_kind = 'send' then
    if p_client_message_id is not null and v.last_client_message_id = p_client_message_id then
      return 'duplicate';
    end if;
    if v.send_window_started_at is null or v_now - v.send_window_started_at >= interval '60 seconds' then
      v.send_window_started_at := v_now;
      v.send_window_count := 0;
    end if;
    if v.send_day_started_at is null or v_now - v.send_day_started_at >= interval '1 day' then
      v.send_day_started_at := v_now;
      v.send_day_count := 0;
    end if;
    if v.send_window_count >= p_minute_max or (p_day_max is not null and v.send_day_count >= p_day_max) then
      return 'rate_limited';
    end if;
    update public.website_chat_visitors
       set send_window_started_at = v.send_window_started_at,
           send_window_count = v.send_window_count + 1,
           send_day_started_at = v.send_day_started_at,
           send_day_count = v.send_day_count + 1,
           last_client_message_id = coalesce(p_client_message_id, v.last_client_message_id),
           last_seen_at = v_now,
           updated_at = v_now
     where id = p_visitor_id;
    return 'ok';
  end if;

  raise exception 'website_chat_visitor_hit: unknown kind %', p_kind;
end;
$$;

revoke all on function public.website_chat_visitor_hit(uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.website_chat_visitor_hit(uuid, text, integer, integer, text) to service_role;

-- 5. Atomic, race-safe site creation with the plan limit
--    (plan_features.max_connections for the website_chat feature = max
--    sites; NULL / no plan = unlimited, same convention as
--    api/client-integrations.js checkConnectionLimit). Performs NO
--    authorization — the caller (api/_lib/websiteChatAccounts.js) has
--    already resolved and authorized the actor and derived p_client_id.
create or replace function public.create_website_chat_integration(
  p_client_id uuid,
  p_feature_id uuid,
  p_config jsonb,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_plan_id uuid;
  v_limit integer;
  v_count integer;
  v_row public.client_feature_integrations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('website_chat_create|' || p_client_id::text, 0));

  select plan_id into v_plan_id from public.clients where id = p_client_id;
  if v_plan_id is not null then
    select max_connections into v_limit
      from public.plan_features
     where plan_id = v_plan_id and feature_id = p_feature_id;
  end if;

  select count(*) into v_count
    from public.client_feature_integrations
   where client_id = p_client_id and feature_id = p_feature_id;

  if v_limit is not null and v_count >= v_limit then
    return jsonb_build_object('outcome', 'limit_reached', 'plan_limit', v_limit);
  end if;

  insert into public.client_feature_integrations (client_id, feature_id, is_active, config)
  values (p_client_id, p_feature_id, p_is_active, p_config)
  returning * into v_row;

  return jsonb_build_object('outcome', 'created', 'plan_limit', v_limit, 'integration', to_jsonb(v_row));
end;
$$;

revoke all on function public.create_website_chat_integration(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_website_chat_integration(uuid, uuid, jsonb, boolean) to service_role;

commit;

-- Verify:
--   select id, slug from public.features where slug = 'website_chat';
--   select relrowsecurity from pg_class where oid = 'public.website_chat_visitors'::regclass;
