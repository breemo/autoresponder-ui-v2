-- AI Engine V1 -- Business Voice + Authoritative Locations.
--
-- Schema-only, fully additive. Does NOT edit or touch any prior
-- migration, does NOT touch clients.address/business_name/phone/
-- working_hours (still authoritative exactly as before for any client
-- with zero client_locations rows -- see the report's "Backward
-- Compatibility" section). Run this manually against the Supabase
-- project -- it is NOT executed automatically by this repo, and was NOT
-- run as part of this change.
--
-- ---------------------------------------------------------------------
-- Problem being solved
-- ---------------------------------------------------------------------
-- clients.address is a single free-text field with no way to express
-- "this is our only location" vs "this is one known address, there may
-- be others". Confirmed live: the AI answered "no branch in Ramallah"
-- reasoning purely from the presence of a single Nablus address -- an
-- unsupported inference from silence, not from an authoritative denial.
--
-- ---------------------------------------------------------------------
-- Design: two additive pieces, not a redesign of `clients`
-- ---------------------------------------------------------------------
-- 1. clients.locations_list_complete (new column, default false) --
--    client-level, not per-row, because completeness is a property of
--    the WHOLE list, not any individual location. Defaults to false so
--    every existing client is, by construction, in the safe "do not
--    infer a negative" state until a client explicitly asserts
--    otherwise via the new UI -- no existing behavior changes silently.
--
-- 2. client_locations (new table) -- explicit branch/location rows.
--    Zero rows (the default/current state for every existing client) is
--    a fully valid, fully supported state: clients.address/phone/
--    working_hours alone remain authoritative for "what we know", never
--    for "this proves nothing else exists" -- that distinction is
--    carried entirely by locations_list_complete, not by row presence.
--
-- The 2x2 this produces (see the report for the full truth table):
--   0 rows,  complete=false -- today's status quo: known address only,
--            never a proof of completeness (the default/backward-
--            compatible case)
--   0 rows,  complete=true  -- an explicit assertion of NO physical
--            locations at all (a valid case for online-only/service-
--            area businesses)
--   1+ rows, complete=false -- "here is what we know", not exhaustive
--   1+ rows, complete=true  -- the authoritative, exhaustive list;
--            absence of a location the customer asks about MAY now
--            support a confident negative answer
--
-- ---------------------------------------------------------------------
-- Security / isolation -- identical convention to every other
-- client-scoped table added during AI Engine V1 (client_ai_behavior,
-- client_knowledge_documents, client_knowledge_chunks): RLS enabled,
-- zero policies (service-role-API-only). This intentionally does NOT
-- mirror clients' own browser-RLS-writable policy (which predates this
-- migration and isn't defined anywhere in this repo's migration history
-- to safely replicate) -- all reads/writes go through
-- api/_lib/clientLocations.js, never a direct browser Supabase call.

begin;

-- ===========================================================================
-- 1. clients.locations_list_complete
-- ===========================================================================
alter table public.clients
  add column if not exists locations_list_complete boolean not null default false;

comment on column public.clients.locations_list_complete is
  'Whether client_locations (for this client) represents the COMPLETE, authoritative list of every active location -- NOT whether any locations are configured at all. Defaults to false so a client with zero (or partial) configured locations is never treated as proof no other location exists. Set explicitly by the client/admin (see api/_lib/clientLocations.js, action "set_list_complete") -- never inferred from row presence.';

-- ===========================================================================
-- 2. client_locations
-- ===========================================================================
create table if not exists public.client_locations (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  name          text null,
  address       text not null,
  city          text null,
  phone         text null,
  working_hours jsonb null,
  is_primary    boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.client_locations is
  'AI Engine V1 -- explicit branch/location rows for a client, additive alongside clients.address (which remains the "known primary/current address" regardless of how many rows exist here). Whether this list is COMPLETE is tracked separately on clients.locations_list_complete, not implied by row count. Strictly client-scoped; every read/write goes through api/_lib/clientLocations.js (service-role only) -- never a direct browser Supabase call.';
comment on column public.client_locations.working_hours is
  'Same structured jsonb shape as clients.working_hours (see 20260826_ai_engine_v1_phase1_foundation.sql) -- allows one branch''s hours to differ from the client-level default. Null is valid (falls back to no branch-specific hours being asserted).';
comment on column public.client_locations.is_primary is
  'At most one TRUE per client among is_active rows -- enforced by client_locations_one_primary_per_client_idx below, not just application logic.';
comment on column public.client_locations.is_active is
  'Inactive locations (closed branches, etc.) are excluded from the authoritative context supplied to the AI -- see api/_lib/aiContext.js. Deactivating the current primary does not auto-reassign primary to another row.';

create index if not exists client_locations_client_id_idx
  on public.client_locations (client_id);

-- Defense in depth: "primary uniqueness" is validated in
-- api/_lib/clientLocations.js, and enforced here too so it can never be
-- violated even by a future direct/manual write. Scoped to is_active
-- rows only, so deactivating the current primary never blocks setting a
-- new one.
create unique index if not exists client_locations_one_primary_per_client_idx
  on public.client_locations (client_id)
  where is_primary and is_active;

alter table public.client_locations enable row level security;
-- No policies added -- same zero-policy, service-role-API-only
-- convention as client_ai_behavior / client_knowledge_documents /
-- client_knowledge_chunks.

commit;
