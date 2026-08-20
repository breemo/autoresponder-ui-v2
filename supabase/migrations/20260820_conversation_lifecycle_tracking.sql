-- Phase 2 — Human Takeover + Smart Assignment + Conversation Lifecycle
-- Tracking: database foundation (Stage 7A).
--
-- Adds the current-state fields conversation_state was still missing for a
-- full lifecycle picture, plus two new append-only tables
-- (conversation_events, conversation_notes) that will power the future
-- Conversation Card / Customer History / Employee Performance Analytics
-- features. This migration is schema-only: nothing in this repo writes to
-- any of the new columns/tables yet — no application, API, or n8n
-- behavior changes as a result of running this.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change (schema-design pass only, per
-- explicit instruction not to run it against live Supabase).
--
-- ---------------------------------------------------------------------
-- System assignment vs. actual acceptance — the core semantic this
-- migration exists to represent
-- ---------------------------------------------------------------------
-- assigned_user_id / assigned_at (EXISTING, added by
-- 20260816_conversation_state_assignment.sql) KEEP THEIR CURRENT MEANING
-- UNCHANGED and are not touched by this migration: the employee who
-- actually accepted/took ownership of the conversation, and when.
--
-- system_assigned_user_id / system_assigned_at (NEW, below) are a
-- SEPARATE concept: who a future automatic-assignment step proposed for
-- the conversation, and when — before anyone has actually accepted it.
-- The two are deliberately independent: a conversation can have a
-- system_assigned_user_id with assigned_user_id still null (proposed, not
-- yet accepted by anyone), and the employee who ultimately accepts
-- (assigned_user_id) does not have to be the same person the system
-- proposed — automatic assignment is a suggestion/starting point, not a
-- lock; first-to-accept still wins. See the Phase 2 design report for the
-- full business rationale.
--
-- Verified LIVE conversation_state schema this migration was written
-- against (not re-derived from application code):
--   id uuid PK default gen_random_uuid()
--   client_id uuid not null
--   sender_id text not null
--   platform text not null
--   conversation_id uuid not null   -- NOT unique; see part 2 below
--   current_step text null
--   context jsonb null
--   updated_at timestamptz null default now()
--   conversation_status text null default 'active'
--   assigned_user_id uuid null
--   assigned_at timestamptz null
--   UNIQUE (client_id, sender_id) -- conversation_state_unique
--   RLS disabled, no triggers
-- None of the above existing columns, constraints, indexes, or RLS
-- setting are changed by this migration.

begin;

-- ===========================================================================
-- 1. conversation_state — additive lifecycle columns
-- ===========================================================================
--
-- All nullable, all additive. Existing rows are untouched — every new
-- column simply starts null for every row that already exists, exactly
-- like assigned_user_id/assigned_at did in 20260816. No existing column,
-- constraint, index, or RLS setting is modified — in particular
-- assigned_user_id/assigned_at's meaning and their existing (no explicit
-- ON DELETE clause, i.e. Postgres default NO ACTION) foreign key behavior
-- are left exactly as-is; this migration does not ALTER that column at
-- all.
--
-- New user-reference columns below use ON DELETE SET NULL rather than
-- mirroring assigned_user_id's own (default NO ACTION) FK. This is not a
-- response to an established different convention actually in use
-- elsewhere — inspection found none: no code path in this app deletes
-- public.users rows today (accounts are deactivated via
-- client_users.is_active, never hard-deleted; api/client-users.js's
-- delete action removes a client_users membership row, not the
-- underlying users row). SET NULL is therefore a defensive default for a
-- deletion path that doesn't currently exist: if a users row were ever
-- deleted in the future, an assignment/solve/reopen record degrades to
-- "attributed to someone no longer in the system" rather than either
-- silently cascading away lifecycle history or blocking the deletion
-- outright.
alter table public.conversation_state
  add column if not exists system_assigned_user_id uuid null references public.users(id) on delete set null,
  add column if not exists system_assigned_at timestamptz null,
  add column if not exists solved_by uuid null references public.users(id) on delete set null,
  add column if not exists solved_at timestamptz null,
  add column if not exists reopened_by uuid null references public.users(id) on delete set null,
  add column if not exists reopened_at timestamptz null;

comment on column public.conversation_state.system_assigned_user_id is
  'Who Smart Assignment proposed for this conversation — NOT final ownership. See assigned_user_id for who actually accepted it.';
comment on column public.conversation_state.system_assigned_at is
  'When Smart Assignment proposed system_assigned_user_id.';
comment on column public.conversation_state.solved_by is
  'Who performed the resolving Close action.';
comment on column public.conversation_state.solved_at is
  'When the conversation was marked solved (recorded at the same moment as Close, per the Phase 2 design decision to keep Close/Solved as a single action rather than splitting them).';
comment on column public.conversation_state.reopened_by is
  'Who most recently reopened this conversation.';
comment on column public.conversation_state.reopened_at is
  'When this conversation was most recently reopened.';

-- New index only (the existing PK on id and the existing UNIQUE
-- (client_id, sender_id) -- conversation_state_unique -- are untouched by
-- this migration, per the verified live schema at the top of this file).
-- Supports Smart Assignment's primary balancing criterion: "how many
-- currently active/waiting_human conversations does employee X actually
-- own right now" is exactly
--   select count(*) from conversation_state
--   where client_id = $1 and conversation_status = 'waiting_human' and assigned_user_id = $2
-- -- this index matches that filter left-to-right (client_id equality,
-- conversation_status equality, assigned_user_id equality/grouping).
create index if not exists conversation_state_client_status_assigned_idx
  on public.conversation_state (client_id, conversation_status, assigned_user_id);

-- ===========================================================================
-- 2. conversation_events — append-only lifecycle/event log
-- ===========================================================================
--
-- conversation_state_id (NOT conversation_id) is the stable FK target.
-- conversation_state has no unique constraint on conversation_id — only on
-- (client_id, sender_id), i.e. one conversation_state row per
-- client/customer, with conversation_id itself being mutable "current
-- conversation context" on that row, not a stable per-thread identity.
-- conversation_id is still stored on every event row as a point-in-time
-- snapshot (useful for querying "everything that happened while this
-- conversation_id was current"), but deliberately WITHOUT a foreign key
-- against conversation_state.conversation_id, since that column isn't
-- unique and cannot support one.
create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  conversation_state_id uuid not null references public.conversation_state(id) on delete restrict,
  conversation_id uuid not null,
  sender_id text not null,
  event_type text not null,
  actor_user_id uuid null references public.users(id) on delete set null,
  target_user_id uuid null references public.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.conversation_events is
  'Append-only conversation lifecycle audit trail. Never updated or deleted by application code -- every row is a historical fact. Intended to be written/read only by trusted server-side code; RLS is enabled with no policies so the anon/browser key can never touch it directly (see the RLS note below).';
comment on column public.conversation_events.conversation_state_id is
  'Stable FK to conversation_state.id. conversation_state has no unique constraint on conversation_id, so this is the only safe/stable per-conversation reference.';
comment on column public.conversation_events.conversation_id is
  'Point-in-time snapshot of the conversation_id at event time, for querying -- deliberately NOT a foreign key (conversation_state.conversation_id is not unique).';
comment on column public.conversation_events.actor_user_id is
  'Who caused this event. Null for a system/n8n-driven event with no human actor (e.g. an automatic waiting_human escalation).';
comment on column public.conversation_events.target_user_id is
  'Who the event is about, when different from actor_user_id (e.g. a reassignment''s destination employee -- see metadata for full before/after detail).';

-- event_type validation: CHECK constraint, matching this repo's own
-- established convention for small controlled-vocabulary text columns
-- (see client_users_role_check in 20260813_client_users_role_owner_agent_it.sql,
-- messages_message_type_check in 20260818_messages_media_columns.sql)
-- rather than unrestricted text. The vocabulary is small and
-- product-defined (see the Phase 2 design report), and future
-- analytics/reporting on this column benefits from it being a known,
-- closed set rather than free text that could silently drift/typo across
-- call sites. The do-block guard is required because Postgres has no
-- native "ADD CONSTRAINT IF NOT EXISTS" syntax -- this keeps the
-- migration safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'conversation_events_event_type_check'
  ) then
    alter table public.conversation_events
      add constraint conversation_events_event_type_check
      check (event_type in (
        'waiting_human',
        'system_assigned',
        'accepted',
        'reassigned',
        'transferred',
        'solved',
        'reopened',
        'closed',
        'note_added'
      ));
  end if;
end $$;

create index if not exists conversation_events_client_conversation_created_idx
  on public.conversation_events (client_id, conversation_id, created_at);

create index if not exists conversation_events_client_state_created_idx
  on public.conversation_events (client_id, conversation_state_id, created_at);

create index if not exists conversation_events_client_actor_created_idx
  on public.conversation_events (client_id, actor_user_id, created_at);

-- Supports Smart Assignment's fair-rotation tie-breaker: a
-- 'system_assigned' event's target_user_id identifies the employee the
-- system selected, so "when was this employee last system-assigned
-- anything" is
--   select max(created_at) from conversation_events
--   where client_id = $1 and target_user_id = $2 and event_type = 'system_assigned'
-- -- this index matches the client_id/target_user_id filter; created_at is
-- included so the max/ordering itself doesn't need a separate sort.
create index if not exists conversation_events_client_target_created_idx
  on public.conversation_events (client_id, target_user_id, created_at);

-- No event_type index: every query pattern identified so far (a
-- conversation's timeline, a conversation_state's timeline, one
-- employee's activity as actor, one employee's activity as target)
-- already filters by one of the four indexed column groups above first,
-- each far more selective than event_type alone (9 possible values). Add
-- one later only if a real analytics query needs to scan across ALL
-- conversations for one event_type without also filtering by
-- client_id+conversation, client_id+actor, or client_id+target -- no such
-- query exists yet, so this is a deliberate omission, not an oversight.

-- RLS: enabled, with NO policies defined. This table is designed to be
-- written and read exclusively by trusted server-side code (the service
-- role -- see api/_lib/supabaseServer.js), never directly by the
-- browser's anon-keyed Supabase client the rest of this app already uses
-- for conversation_state/messages/leads. With RLS enabled and zero
-- policies, Postgres denies ALL row access to any role subject to RLS
-- (anon, authenticated) by default -- only the service role, which
-- bypasses RLS entirely, can touch this table at all. This is
-- deliberately NOT an auth.uid()-based policy set: this app has no
-- Supabase Auth session, so auth.uid() is always null here and would be
-- meaningless as a policy condition. Enabling RLS with no policies is the
-- strictest, safest state available without inventing an authorization
-- model this app doesn't have -- it can only ever get MORE permissive
-- from here (by adding explicit policies later), never less, so this
-- does not risk broadening anonymous/browser access to anything.
alter table public.conversation_events enable row level security;

-- ===========================================================================
-- 3. conversation_notes — internal-only employee notes
-- ===========================================================================
--
-- Same conversation_state_id-not-conversation_id reasoning as
-- conversation_events above -- see those comments for the full rationale,
-- not repeated here. Notes are never sent to the customer; that is
-- enforced by application code (no outbound send path reads this table),
-- not by anything in this schema -- this migration only prepares storage.
create table if not exists public.conversation_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  conversation_state_id uuid not null references public.conversation_state(id) on delete restrict,
  conversation_id uuid not null,
  author_user_id uuid not null references public.users(id) on delete restrict,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz null
);

comment on table public.conversation_notes is
  'Internal employee notes on a conversation. Never forwarded to the customer by any code path. RLS is enabled with no policies (server-side/service-role access only) -- see the identical reasoning on conversation_events.';
comment on column public.conversation_notes.conversation_state_id is
  'Stable FK to conversation_state.id -- see the identical note on conversation_events.conversation_state_id.';
comment on column public.conversation_notes.conversation_id is
  'Point-in-time snapshot, not a foreign key -- see the identical note on conversation_events.conversation_id.';
comment on column public.conversation_notes.author_user_id is
  'The employee who wrote this note. NOT NULL, so unlike conversation_events.actor_user_id this column cannot use ON DELETE SET NULL; ON DELETE RESTRICT is used instead -- blocks deleting a users row that has authored notes rather than either losing the note or silently orphaning its authorship. As with the conversation_state additions above, no code path in this app currently deletes public.users rows, so this is a defensive default, not a response to an observed real deletion flow.';

-- Prevents an empty or whitespace-only note body. btrim() strips leading/
-- trailing whitespace; comparing the result to '' also catches a
-- whitespace-only body, not just a literally empty string.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'conversation_notes_body_not_blank_check'
  ) then
    alter table public.conversation_notes
      add constraint conversation_notes_body_not_blank_check
      check (btrim(body) <> '');
  end if;
end $$;

create index if not exists conversation_notes_client_conversation_created_idx
  on public.conversation_notes (client_id, conversation_id, created_at);

create index if not exists conversation_notes_client_state_created_idx
  on public.conversation_notes (client_id, conversation_state_id, created_at);

-- RLS: enabled, with NO policies -- identical reasoning to
-- conversation_events above (server-side/service-role access only, no
-- Supabase Auth session to write an auth.uid() policy against, strictly
-- more restrictive than not enabling RLS at all).
alter table public.conversation_notes enable row level security;

commit;

-- ---------------------------------------------------------------------
-- Known limitation, documented rather than silently left unmentioned:
-- there is no schema-level constraint tying conversation_events.client_id
-- / conversation_notes.client_id to the client_id of the conversation_state
-- row conversation_state_id points at. A composite foreign key enforcing
-- that would require a UNIQUE constraint on conversation_state(id,
-- client_id), which conversation_state does not have and which this
-- migration deliberately does not add (out of scope -- "do not change any
-- existing constraints/indexes" and no such requirement was given). Every
-- writer of these two tables (the future Phase 2 API layer) must set
-- client_id consistently with the referenced conversation_state row
-- itself; this is an application-level trust boundary, not a
-- database-enforced invariant, exactly like every other client_id column
-- already in this schema (conversation_state.client_id itself has no FK
-- either).
