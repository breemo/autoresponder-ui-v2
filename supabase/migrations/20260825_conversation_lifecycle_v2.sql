-- Conversation Lifecycle V2 — makes `conversations` the authoritative
-- table for assignment/lifecycle actions (system_assign / accept / solve /
-- reopen), keeping `conversation_state` synchronized as a temporary
-- compatibility dual-write only.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change (implementation pass only, per
-- explicit instruction not to run it against live Supabase).
--
-- Additive only. Does not edit 20260820_conversation_lifecycle_action_rpc.sql
-- or 20260822_smart_assignment_rpc.sql — this migration DROPs and
-- re-CREATEs apply_conversation_lifecycle_action with the exact same
-- public signature (same parameter list, same RETURNS TABLE column list
-- and order) so every existing caller (api/conversation-lifecycle.js,
-- api/smart-assign-conversation.js) keeps working unchanged — see the
-- "Why the API layer needs zero changes" note near the bottom.
--
-- ---------------------------------------------------------------------
-- Confirmed problem this migration fixes (clean live test)
-- ---------------------------------------------------------------------
-- apply_conversation_lifecycle_action (both prior versions) only ever
-- wrote public.conversation_state. Employee Close correctly set
-- conversation_state.conversation_status = 'closed', but the matching
-- public.conversations row was left exactly as resolve_conversation had
-- last set it (conversation_status = 'waiting_human', closed_at = NULL).
-- Since resolve_conversation's Rule 1/2 ("existing open conversation")
-- vs. Rule 3/4 (same-day/new-day reopen) decision is entirely driven by
-- conversations.conversation_status/closed_at, a conversation closed via
-- the Portal could never actually reach Rule 3 or Rule 4 — every
-- subsequent customer message just silently rejoined the same "still
-- open" conversations row, regardless of what the employee did.
--
-- ---------------------------------------------------------------------
-- Assignment semantics — unchanged, not redesigned
-- ---------------------------------------------------------------------
-- system_assigned_user_id = who Smart Assignment suggested.
-- assigned_user_id = who actually claimed/accepted.
-- 'accept' still never touches system_assigned_user_id/system_assigned_at
-- (the original recommendation is permanent history, per the original
-- Phase 2 design — a different employee claiming a conversation than the
-- one the system suggested is valid and expected). 'system_assign' still
-- never touches assigned_user_id. Neither field is ever copied into the
-- other anywhere in this migration.
--
-- ---------------------------------------------------------------------
-- Multi-account safety
-- ---------------------------------------------------------------------
-- Every authoritative UPDATE below targets conversations by
-- (id = p_conversation_id, client_id = p_client_id) ONLY — never by
-- sender_id, never by "the latest conversation_state row" for that
-- sender. Two conversations sharing the same (client_id, sender_id,
-- platform) but a different channel_identity_id/receiving account can
-- never have their conversations row touched by each other's lifecycle
-- action, because conversations.id is a stable, unique, never-reused
-- identity (unlike conversation_state.conversation_id, a mutable,
-- last-write-wins snapshot column). The legacy compatibility dual-write
-- (step 3 below) is the only place this migration still touches
-- conversation_state, and it is deliberately scoped to
-- (client_id, conversation_id) matching this exact authoritative
-- conversation_id — if the shared legacy row currently represents a
-- DIFFERENT conversation (the multi-account collision the legacy table
-- cannot represent), that UPDATE simply matches zero rows rather than
-- overwriting the wrong conversation's legacy mirror.
--
-- ---------------------------------------------------------------------
-- Atomicity (Task 8)
-- ---------------------------------------------------------------------
-- One PL/pgSQL function, one implicit transaction, in this exact order:
--   1. validate p_action/p_conversation_id, resolve the best-effort
--      legacy mirror row (conversation_state, matched by
--      client_id+conversation_id) up front.
--   2. authoritative UPDATE on conversations (per action) — determines
--      v_outcome.
--   3. IF v_outcome = 'ok': best-effort compatibility UPDATE on
--      conversation_state (never required to succeed/match — see below).
--   4. IF v_outcome = 'ok': INSERT the matching conversation_events row.
-- All in the same function body/transaction — either everything from
-- step 2 onward commits together, or (on an unhandled exception) nothing
-- does. There is no path where the event is inserted but the
-- authoritative conversations UPDATE did not happen, or vice versa.
--
-- Decision (Task 8's explicit question): if the legacy conversation_state
-- row does not exist for this exact conversation_id, the V2 lifecycle
-- action is NOT failed because of it. Nothing in this app's current API
-- contract requires conversation_state to exist for 'system_assign' or
-- 'accept' to succeed (api/smart-assign-conversation.js and
-- api/conversation-lifecycle.js's handleClaim call the RPC directly, no
-- pre-check). 'solve'/'reopen', called via
-- api/conversation-lifecycle.js's handleStatusChange, DO currently 404
-- before ever reaching this RPC if no conversation_state row exists (an
-- existing, unchanged API-layer check, out of scope for this migration)
-- — so in practice this case mostly arises for 'system_assign'/'accept',
-- exactly the multi-account collision scenario this whole effort exists
-- to route around. Step 3 above is written as a plain best-effort UPDATE
-- (silently matches zero rows if the legacy row is absent or represents a
-- different conversation) rather than an upsert/creation of a new
-- conversation_state row — inventing a new legacy row here is out of
-- scope and would itself be a new, undesigned behavior.
--
-- This decision requires one small additive schema change: conversation_
-- events.conversation_state_id (added not-null in
-- 20260820_conversation_lifecycle_tracking.sql) is relaxed to nullable
-- below, so a lifecycle event can still be recorded — referencing the
-- authoritative conversation_id (this table's own NOT NULL column,
-- unaffected) — even when there is no legacy row to also attribute it to.

begin;

-- ===========================================================================
-- 1. conversation_events.conversation_state_id -- relax to nullable
-- ===========================================================================
-- The FK itself (references conversation_state(id) on delete restrict) is
-- unaffected — a nullable FK column is standard; NULL is never checked
-- against the referenced table. Every existing row already has a non-null
-- value (this migration does not touch existing data), so this is a pure
-- constraint relaxation, safe to run against live data.
alter table public.conversation_events
  alter column conversation_state_id drop not null;

comment on column public.conversation_events.conversation_state_id is
  'Best-effort legacy mirror: the conversation_state row this event was ALSO synchronized to, when one existed for this exact conversation_id at write time (see 20260825_conversation_lifecycle_v2.sql). NULL when no matching legacy row was found -- e.g. the shared legacy row currently represents a different conversation for the same sender (multi-account collision). conversation_id (this table''s own NOT NULL column) is the authoritative reference going forward, not this column.';

-- ===========================================================================
-- 2. apply_conversation_lifecycle_action -- v2, conversations-authoritative
-- ===========================================================================
-- Why DROP + CREATE, not CREATE OR REPLACE: unchanged reasoning from
-- 20260822_smart_assignment_rpc.sql — not needed for a signature change
-- this time (the signature is IDENTICAL), but Postgres does not allow
-- CREATE OR REPLACE to change a function's body-internal variable/logic
-- shape safely across such a substantial rewrite in some tooling, and
-- DROP+CREATE is the same safe pattern already established for this exact
-- function. Same name, same parameter list, same RETURNS TABLE column
-- list/order/types as both prior versions.
drop function if exists public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz);

create function public.apply_conversation_lifecycle_action(
  p_client_id uuid,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_target_user_id uuid default null,
  p_expected_updated_at timestamptz default null
)
returns table (
  outcome text,                    -- 'ok' | 'conflict' | 'forbidden' | 'not_found' | 'skipped'
  conversation_state_id uuid,
  conversation_id uuid,
  sender_id text,
  conversation_status text,
  current_step text,
  assigned_user_id uuid,
  assigned_at timestamptz,
  system_assigned_user_id uuid,
  system_assigned_at timestamptz,
  solved_by uuid,
  solved_at timestamptz,
  reopened_by uuid,
  reopened_at timestamptz,
  updated_at timestamptz
)
language plpgsql
as $$
declare
  v_conv public.conversations%rowtype;
  v_state public.conversation_state%rowtype;
  v_sender_id text;
  v_outcome text;
  v_event_type text;
  v_event_target_user_id uuid;
  v_actor_user_id uuid;
begin
  if p_action not in ('accept', 'solve', 'reopen', 'system_assign') then
    raise exception 'apply_conversation_lifecycle_action: unsupported action %', p_action;
  end if;

  if p_conversation_id is null then
    raise exception 'apply_conversation_lifecycle_action: p_conversation_id is required';
  end if;

  v_actor_user_id := p_actor_user_id;

  -- Step 1 (part 2): best-effort legacy mirror, resolved once up front.
  -- Matched by (client_id, conversation_id) — i.e. only a
  -- conversation_state row whose OWN conversation_id snapshot currently
  -- equals this exact authoritative conversation_id. Used below only for
  -- (a) system_assign's idempotency fence and (b) this function's own
  -- output conversation_state_id column — never to decide WHICH
  -- conversations row to update.
  select cs.* into v_state
    from public.conversation_state as cs
    where cs.client_id = p_client_id
      and cs.conversation_id = p_conversation_id
    limit 1;

  -- ---------------------------------------------------------------------
  -- Step 2: authoritative UPDATE on conversations, per action. Every
  -- WHERE clause below re-targets conversations.id in place of the prior
  -- version's conversation_state.conversation_id, keeping the exact same
  -- eligibility conditions (Task 3-6) each action already enforced.
  -- ---------------------------------------------------------------------
  if p_action = 'accept' then
    update public.conversations as cv
      set assigned_user_id = p_actor_user_id,
          assigned_at = now(),
          updated_at = now()
      where cv.id = p_conversation_id
        and cv.client_id = p_client_id
        and cv.conversation_status = 'waiting_human'
        and cv.assigned_user_id is null
      returning cv.* into v_conv;

    if found then
      v_outcome := 'ok';
      v_event_type := 'accepted';
      v_event_target_user_id := p_actor_user_id;
    else
      select cv.* into v_conv from public.conversations as cv
        where cv.id = p_conversation_id and cv.client_id = p_client_id;
      v_outcome := case when v_conv.id is null then 'not_found' else 'conflict' end;
    end if;

  elsif p_action = 'solve' then
    update public.conversations as cv
      set conversation_status = 'closed',
          current_step = 'done',
          closed_at = now(),
          solved_by = p_actor_user_id,
          solved_at = now(),
          updated_at = now()
      where cv.id = p_conversation_id
        and cv.client_id = p_client_id
        and (cv.conversation_status <> 'waiting_human' or cv.assigned_user_id = p_actor_user_id)
      returning cv.* into v_conv;

    if found then
      v_outcome := 'ok';
      v_event_type := 'solved';
      v_event_target_user_id := null;
    else
      select cv.* into v_conv from public.conversations as cv
        where cv.id = p_conversation_id and cv.client_id = p_client_id;
      v_outcome := case when v_conv.id is null then 'not_found' else 'forbidden' end;
    end if;

  elsif p_action = 'reopen' then
    -- No status/ownership gate, matching the original function's own
    -- 'reopen' branch exactly (Task 6: "do not invent new behavior").
    -- closed_at is newly cleared here (conversation_state has no such
    -- column to have ever done this before) -- required so
    -- resolve_conversation's Rule 1/2 sees this conversation as open
    -- again. system_assigned_user_id/system_assigned_at are deliberately
    -- left untouched, exactly as the original 'reopen' branch already did.
    update public.conversations as cv
      set conversation_status = 'active',
          current_step = null,
          closed_at = null,
          assigned_user_id = null,
          assigned_at = null,
          reopened_by = p_actor_user_id,
          reopened_at = now(),
          updated_at = now()
      where cv.id = p_conversation_id
        and cv.client_id = p_client_id
      returning cv.* into v_conv;

    if found then
      v_outcome := 'ok';
      v_event_type := 'reopened';
      v_event_target_user_id := null;
    else
      v_outcome := 'not_found';
    end if;

  elsif p_action = 'system_assign' then
    if p_target_user_id is null then
      raise exception 'apply_conversation_lifecycle_action: system_assign requires p_target_user_id';
    end if;

    v_actor_user_id := null; -- no human actor for a system recommendation

    -- Idempotency fence: the SAME mechanism as the prior version, still
    -- keyed against conversation_state.updated_at, because that is still
    -- what the Database Webhook hands back as record.updated_at (the
    -- webhook trigger itself is unchanged by this migration — still fires
    -- off conversation_state, see api/smart-assign-conversation.js).
    -- Deliberately only blocks when a matching legacy row EXISTS and its
    -- updated_at disagrees (a positively-confirmed stale/duplicate
    -- delivery) -- a MISSING legacy row must never by itself block the
    -- authoritative action (Task 8).
    if v_state.id is not null
       and p_expected_updated_at is not null
       and v_state.updated_at is distinct from p_expected_updated_at
    then
      v_outcome := 'skipped';
    else
      update public.conversations as cv
        set system_assigned_user_id = p_target_user_id,
            system_assigned_at = now(),
            updated_at = now()
        where cv.id = p_conversation_id
          and cv.client_id = p_client_id
          and cv.conversation_status = 'waiting_human'
          and cv.assigned_user_id is null
        returning cv.* into v_conv;

      if found then
        v_outcome := 'ok';
        v_event_type := 'system_assigned';
        v_event_target_user_id := p_target_user_id;
      else
        select cv.* into v_conv from public.conversations as cv
          where cv.id = p_conversation_id and cv.client_id = p_client_id;
        v_outcome := case when v_conv.id is null then 'not_found' else 'skipped' end;
      end if;
    end if;
  end if;

  -- sender_id for output -- resolved from the conversation's own channel
  -- identity (never from conversation_state, which may be absent/stale
  -- for this exact conversation — see the multi-account note above).
  if v_conv.id is not null then
    select cci.sender_id into v_sender_id
      from public.contact_channel_identities as cci
      where cci.id = v_conv.channel_identity_id;
  end if;

  if v_outcome = 'ok' then
    -- Step 3: best-effort legacy compatibility dual-write. Matched
    -- strictly by (client_id, conversation_id) — only touches the legacy
    -- row if it is CURRENTLY the one representing this exact conversation
    -- (see the multi-account safety note above); never re-derives
    -- eligibility from conversation_state's own columns, since the
    -- authoritative decision already happened against conversations in
    -- step 2. A row that doesn't match (absent, or currently pointing at
    -- a different conversation) is silently left untouched -- not an
    -- error, not retried, not fabricated.
    if p_action = 'accept' then
      update public.conversation_state as cs
        set assigned_user_id = p_actor_user_id,
            assigned_at = now(),
            updated_at = now()
        where cs.client_id = p_client_id and cs.conversation_id = p_conversation_id;
    elsif p_action = 'solve' then
      update public.conversation_state as cs
        set conversation_status = 'closed',
            current_step = 'done',
            solved_by = p_actor_user_id,
            solved_at = now(),
            updated_at = now()
        where cs.client_id = p_client_id and cs.conversation_id = p_conversation_id;
    elsif p_action = 'reopen' then
      update public.conversation_state as cs
        set conversation_status = 'active',
            current_step = null,
            assigned_user_id = null,
            assigned_at = null,
            reopened_by = p_actor_user_id,
            reopened_at = now(),
            updated_at = now()
        where cs.client_id = p_client_id and cs.conversation_id = p_conversation_id;
    elsif p_action = 'system_assign' then
      update public.conversation_state as cs
        set system_assigned_user_id = p_target_user_id,
            system_assigned_at = now(),
            updated_at = now()
        where cs.client_id = p_client_id and cs.conversation_id = p_conversation_id;
    end if;

    -- Step 4: append-only event. conversation_id is ALWAYS the
    -- authoritative v_conv.id (= p_conversation_id). conversation_state_id
    -- is v_state.id resolved in Step 1 — the dual-write above never
    -- changes a row's own id, so re-selecting it here would be redundant;
    -- NULL when no matching legacy row existed (see the nullable-column
    -- change above).
    insert into public.conversation_events (
      client_id, conversation_state_id, conversation_id, sender_id,
      event_type, actor_user_id, target_user_id
    ) values (
      p_client_id, v_state.id, v_conv.id, coalesce(v_sender_id, v_state.sender_id, ''),
      v_event_type, v_actor_user_id, v_event_target_user_id
    );
  end if;

  return query
    select
      v_outcome,
      v_state.id,
      v_conv.id,
      coalesce(v_sender_id, v_state.sender_id),
      v_conv.conversation_status,
      v_conv.current_step,
      v_conv.assigned_user_id,
      v_conv.assigned_at,
      v_conv.system_assigned_user_id,
      v_conv.system_assigned_at,
      v_conv.solved_by,
      v_conv.solved_at,
      v_conv.reopened_by,
      v_conv.reopened_at,
      v_conv.updated_at;
end;
$$;

comment on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) is
  'Conversation Lifecycle V2: transactional accept/solve/reopen/system_assign, authoritative on public.conversations (targeted strictly by id+client_id — never by sender_id — see the multi-account safety note in 20260825_conversation_lifecycle_v2.sql), with public.conversation_state kept synchronized as a temporary best-effort compatibility dual-write. Same public signature and RETURNS TABLE shape as the prior (conversation_state-authoritative) version — no caller needs to change. NOT an authorization/eligibility layer -- callers (api/conversation-lifecycle.js, api/smart-assign-conversation.js) must already have authorized the actor/action or computed the target employee before calling this. service_role EXECUTE only -- see the REVOKE/GRANT statements below.';

-- Re-affirmed after the drop/create above — CREATE FUNCTION does not
-- carry over grants from a dropped function.
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from public;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from anon;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from authenticated;
grant execute on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) to service_role;

commit;

-- ---------------------------------------------------------------------
-- Why the API layer needs zero changes
-- ---------------------------------------------------------------------
-- api/smart-assign-conversation.js reads result.outcome and
-- result.system_assigned_user_id — both present, unchanged names/types,
-- now sourced from conversations instead of conversation_state.
-- api/conversation-lifecycle.js's handleClaim reads result.outcome,
-- result.assigned_user_id, result.conversation_status, result.assigned_at,
-- result.conversation_id — all present, unchanged. handleStatusChange
-- (close/reopen) reads result.outcome, result.updated_at,
-- result.conversation_status, result.current_step, result.solved_by,
-- result.solved_at, result.assigned_user_id, result.assigned_at,
-- result.reopened_by, result.reopened_at — all present, unchanged. No
-- caller reads result.conversation_state_id or result.sender_id today,
-- so their (unchanged) semantics/source is a documentation-only note, not
-- a compatibility risk either way.
--
-- api/conversation-lifecycle.js's pre-checks (handleStatusChange's
-- `current` lookup, the close-ownership check) still read
-- conversation_state directly — untouched by this migration, and still
-- correct, because Step 3 above keeps conversation_state's
-- assigned_user_id/conversation_status synchronized with every 'ok'
-- outcome from this RPC.
--
-- api/conversation-lifecycle.js's 'takeover' action (a direct
-- conversation_state UPDATE, not routed through this RPC — see that
-- file's own comment: "no ownership/acceptance concept and no
-- conversation_events entry") is UNCHANGED and OUT OF SCOPE for this
-- migration, per the explicit instruction not to redesign assignment
-- semantics beyond system_assign/accept/solve/reopen. Flagged, not
-- fixed: after this migration, a manual Takeover still only updates
-- conversation_state.conversation_status, not conversations — so
-- conversations.conversation_status (what resolve_conversation and
-- AutoResponder_WhatsApp_V2's check_human_stop guard both actually read)
-- would NOT reflect a Takeover. This is a pre-existing gap, not
-- introduced by this migration, and requires its own explicit follow-up
-- decision (whether 'takeover' should become a fifth RPC action) before
-- being fixed.
