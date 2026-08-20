-- Stage 7B (follow-up) — transactional lifecycle actions.
--
-- MUST be applied AFTER 20260820_conversation_lifecycle_tracking.sql
-- (already live) — this function reads/writes columns and inserts into a
-- table that migration creates (solved_by/solved_at/reopened_by/
-- reopened_at on conversation_state, and conversation_events itself).
-- Named with the same date prefix as that migration since both were
-- authored the same day; ordering is expressed here in this comment
-- rather than in the filename, since every migration in this repo is
-- applied manually (SQL editor / your own tooling), never by an
-- automated runner that relies on filename sort order.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change (implementation pass only, per
-- explicit instruction not to run it against live Supabase).
--
-- ---------------------------------------------------------------------
-- Why this exists
-- ---------------------------------------------------------------------
-- The initial Stage 7B implementation (api/claim-conversation.js,
-- api/conversation-status.js) wrote the conversation_state change and the
-- conversation_events row as two separate Supabase REST calls — not
-- atomic, so a transient failure on the second call could leave
-- conversation_state saying "solved"/"accepted"/"reopened" with no
-- matching permanent history row. This migration adds ONE Postgres
-- function that performs both writes inside a single transaction (a
-- plpgsql function body executes as part of its caller's transaction —
-- if anything inside it errors, every effect it had, including the
-- UPDATE, is rolled back automatically), closing that gap without
-- inventing any new architecture beyond what Postgres itself already
-- provides. The calling API files are updated in this same change to
-- call this function instead of doing the two writes separately.
--
-- ---------------------------------------------------------------------
-- Scope — exactly the three actions Stage 7B covers, nothing else
-- ---------------------------------------------------------------------
-- 'accept' | 'solve' | 'reopen' only. No Smart Assignment, no
-- system_assigned_user_id/system_assigned_at writes — those remain
-- entirely untouched, exactly as in the original Stage 7B pass.
-- 'takeover' (conversation_status -> waiting_human, no ownership/event
-- concept) is NOT one of these three and is intentionally not handled by
-- this function; api/conversation-status.js keeps doing that as a plain
-- direct UPDATE, unchanged.
--
-- ---------------------------------------------------------------------
-- This function is NOT a permission/role authorization layer
-- ---------------------------------------------------------------------
-- It performs zero PERMISSION checks of its own — Inbox permission and
-- must_change_password stay exactly where they already live, in the
-- calling API files, and always run BEFORE this function is called.
-- p_client_id/p_actor_user_id are supplied by that already-authorized
-- caller, never taken from an unauthenticated source. This function is
-- only ever meant to be invoked by this app's server-side service-role
-- Supabase client (see api/_lib/supabaseServer.js) — the REVOKE/GRANT
-- statements below make that the actual enforced behavior, not just a
-- convention: EXECUTE is revoked from anon/authenticated (Postgres grants
-- EXECUTE to PUBLIC by default on function creation, which would
-- otherwise make this directly callable from the browser via
-- supabase.rpc(...) with arbitrary parameters — a real hole this
-- explicitly closes) and granted only to service_role.
--
-- OWNERSHIP, however, IS enforced inside this function's UPDATE
-- statements themselves, not only by an earlier SELECT in the caller —
-- that earlier check is a read that happened before this statement runs
-- and cannot by itself close a race between two concurrent requests. Both
-- 'accept' and 'solve' encode their ownership rule directly in the
-- UPDATE's WHERE clause, so Postgres' own row-locking is what actually
-- decides the outcome, atomically, the same way it already did for
-- 'accept' before this function existed:
--
-- 'accept': WHERE conversation_status = 'waiting_human' AND
-- assigned_user_id IS NULL — unchanged from the original plain UPDATE.
-- Postgres row-locks the target row on the first UPDATE to reach it; a
-- concurrent second call's WHERE clause simply no longer matches once the
-- first commits — exactly one caller can ever win.
--
-- 'solve': WHERE conversation_status <> 'waiting_human' OR
-- assigned_user_id = p_actor_user_id — the same rule
-- api/conversation-status.js's existing early check already encodes
-- (only the assigned owner may close a waiting_human conversation; every
-- other status has no ownership restriction), now enforced at UPDATE time
-- so a race between that earlier read and this write (e.g. a concurrent
-- reassignment) cannot let an unauthorized close through.

begin;

create or replace function public.apply_conversation_lifecycle_action(
  p_client_id uuid,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_action text
)
returns table (
  outcome text,                    -- 'ok' | 'conflict' | 'forbidden' | 'not_found'
  conversation_state_id uuid,
  conversation_id uuid,
  sender_id text,
  conversation_status text,
  current_step text,
  assigned_user_id uuid,
  assigned_at timestamptz,
  solved_by uuid,
  solved_at timestamptz,
  reopened_by uuid,
  reopened_at timestamptz,
  updated_at timestamptz
)
language plpgsql
as $$
declare
  v_row public.conversation_state%rowtype;
  v_outcome text;
  v_event_type text;
  v_target_user_id uuid;
begin
  if p_action not in ('accept', 'solve', 'reopen') then
    raise exception 'apply_conversation_lifecycle_action: unsupported action %', p_action;
  end if;

  if p_action = 'accept' then
    -- Unchanged atomic-claim WHERE clause -- see the header comment.
    update public.conversation_state
      set assigned_user_id = p_actor_user_id,
          assigned_at = now()
      where client_id = p_client_id
        and conversation_id = p_conversation_id
        and conversation_status = 'waiting_human'
        and assigned_user_id is null
      returning * into v_row;

    if found then
      v_outcome := 'ok';
      v_event_type := 'accepted';
      v_target_user_id := p_actor_user_id;
    else
      -- Either doesn't exist for this client, or exists but is no longer
      -- claimable (already taken / not waiting_human) -- distinguish the
      -- two so the caller can return 404 vs 409 exactly as before.
      select * into v_row from public.conversation_state
        where client_id = p_client_id and conversation_id = p_conversation_id
        limit 1;
      v_outcome := case when v_row.id is null then 'not_found' else 'conflict' end;
    end if;

  elsif p_action = 'solve' then
    -- Ownership enforced HERE, atomically, in the UPDATE's own WHERE
    -- clause -- not only by the caller's earlier SELECT-based check
    -- (api/conversation-status.js still does that too, as a friendly
    -- early rejection, but it is a read that happened before this
    -- statement and cannot by itself prevent a race). This is the exact
    -- same rule that check already encodes: a waiting_human conversation
    -- may only be closed by its assigned owner (assigned_user_id IS NULL
    -- -- nobody has claimed it yet -- also fails this condition, correctly
    -- blocking everyone, same as before); every other status has no
    -- ownership restriction, matching existing behavior unchanged.
    -- assigned_user_id/assigned_at are deliberately absent from the SET
    -- list -- preserved exactly as the pre-existing close behavior
    -- already did.
    update public.conversation_state
      set conversation_status = 'closed',
          current_step = 'done',
          solved_by = p_actor_user_id,
          solved_at = now(),
          updated_at = now()
      where client_id = p_client_id
        and conversation_id = p_conversation_id
        and (conversation_status <> 'waiting_human' or assigned_user_id = p_actor_user_id)
      returning * into v_row;

    if found then
      v_outcome := 'ok';
      v_event_type := 'solved';
      v_target_user_id := null;
    else
      -- Either doesn't exist for this client, or exists but this actor is
      -- not allowed to close it right now (waiting_human, owned by
      -- someone else or by no one yet) -- distinguish the two so the
      -- caller can return 404 vs 403 exactly as the pre-existing
      -- SELECT-based check already did.
      select * into v_row from public.conversation_state
        where client_id = p_client_id and conversation_id = p_conversation_id
        limit 1;
      v_outcome := case when v_row.id is null then 'not_found' else 'forbidden' end;
    end if;

  elsif p_action = 'reopen' then
    -- solved_by/solved_at are deliberately absent from this SET list --
    -- they remain the permanent record of the previous solve, exactly as
    -- the pre-existing reopen behavior already left them (reopen has
    -- never touched them). assigned_user_id/assigned_at ARE cleared here,
    -- preserving the pre-existing reopen behavior unchanged.
    update public.conversation_state
      set conversation_status = 'active',
          current_step = null,
          assigned_user_id = null,
          assigned_at = null,
          reopened_by = p_actor_user_id,
          reopened_at = now(),
          updated_at = now()
      where client_id = p_client_id
        and conversation_id = p_conversation_id
      returning * into v_row;

    if found then
      v_outcome := 'ok';
      v_event_type := 'reopened';
      v_target_user_id := null;
    else
      v_outcome := 'not_found';
    end if;
  end if;

  if v_outcome = 'ok' then
    insert into public.conversation_events (
      client_id, conversation_state_id, conversation_id, sender_id,
      event_type, actor_user_id, target_user_id
    ) values (
      p_client_id, v_row.id, v_row.conversation_id, v_row.sender_id,
      v_event_type, p_actor_user_id, v_target_user_id
    );
  end if;

  return query
    select
      v_outcome,
      v_row.id,
      v_row.conversation_id,
      v_row.sender_id,
      v_row.conversation_status,
      v_row.current_step,
      v_row.assigned_user_id,
      v_row.assigned_at,
      v_row.solved_by,
      v_row.solved_at,
      v_row.reopened_by,
      v_row.reopened_at,
      v_row.updated_at;
end;
$$;

comment on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text) is
  'Stage 7B: transactional accept/solve/reopen. Performs the conversation_state update and its matching conversation_events insert in one transaction. NOT an authorization layer -- callers (api/claim-conversation.js, api/conversation-status.js) must already have authorized the actor/action before calling this. service_role EXECUTE only -- see the REVOKE/GRANT statements below.';

-- See the header comment above for why this is required, not optional:
-- Postgres grants EXECUTE to PUBLIC by default on function creation.
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text) from public;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text) from anon;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text) to service_role;

commit;
