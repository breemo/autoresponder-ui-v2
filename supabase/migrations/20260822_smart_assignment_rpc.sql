-- Smart Assignment V1 — extends the existing lifecycle RPC with one new
-- action: 'system_assign'.
--
-- MUST be applied AFTER both:
--   20260820_conversation_lifecycle_tracking.sql (already live)
--   20260820_conversation_lifecycle_action_rpc.sql (already live, and
--     already carries the column-ambiguity fix from
--     supabase/migrations/20260820_conversation_lifecycle_action_rpc.sql's
--     own history — this migration's DROP/CREATE below reproduces that
--     fixed body byte-for-byte for accept/solve/reopen, changing nothing
--     about them; see "Why DROP + CREATE, not CREATE OR REPLACE" below).
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change (implementation pass only, per
-- explicit instruction not to run it against live Supabase).
--
-- ---------------------------------------------------------------------
-- Why DROP + CREATE, not CREATE OR REPLACE
-- ---------------------------------------------------------------------
-- apply_conversation_lifecycle_action's RETURNS TABLE needs two new
-- output columns (system_assigned_user_id, system_assigned_at) so a
-- caller can read back what 'system_assign' just wrote. Postgres does not
-- allow CREATE OR REPLACE FUNCTION to change an existing function's
-- RETURNS TABLE column list — that requires dropping and recreating the
-- function. This is still ONE function, same name, same overall design;
-- nothing about accept/solve/reopen's behavior changes.
--
-- The two new INPUT parameters (p_target_user_id, p_expected_updated_at)
-- are both appended at the end with DEFAULT NULL, and are simply never
-- supplied by the three existing callers (api/claim-conversation.js,
-- api/conversation-status.js — both call this by NAMED parameters via
-- Supabase's .rpc(), so omitting a trailing optional parameter is already
-- safe and requires no change to either file).
--
-- ---------------------------------------------------------------------
-- 'system_assign' — what it does and does not do
-- ---------------------------------------------------------------------
-- Writes system_assigned_user_id/system_assigned_at (a RECOMMENDATION,
-- never ownership — see api/claim-conversation.js's 'accept' action,
-- completely unchanged, for the actual ownership write) and appends one
-- conversation_events row with event_type = 'system_assigned',
-- actor_user_id = NULL (no human caused this), target_user_id = the
-- selected employee. Like every other action here, this function
-- performs ZERO eligibility/permission decisions of its own — the caller
-- (api/smart-assign-conversation.js) has already computed the target
-- employee before calling this; this function only performs the
-- atomic, conditional write.
--
-- Idempotency / re-escalation (the two requirements that shape the WHERE
-- clause below):
--   1. A FRESH transition into waiting_human (e.g. a conversation that
--      was solved, reopened, and escalated again) must get a fresh
--      recommendation, even though system_assigned_user_id is already
--      non-null from the previous cycle — so this action does NOT gate
--      on "system_assigned_user_id IS NULL" the way you might expect.
--   2. Duplicate delivery of the SAME transition (e.g. a webhook retry)
--      must NOT overwrite system_assigned_at a second time or insert a
--      second event.
-- Both are satisfied together with p_expected_updated_at: the caller
-- passes the conversation_state row's own updated_at value AS OF the
-- moment the transition it is reacting to occurred (the webhook
-- payload's record.updated_at — see api/smart-assign-conversation.js).
-- The UPDATE below is conditioned on cs.updated_at = p_expected_updated_at.
-- The first successful call for a given transition advances updated_at
-- (to now()) as part of its own write, so a SECOND delivery of that same
-- transition carries the OLD (now stale) updated_at value and matches
-- zero rows — a safe no-op, not a duplicate event. A genuinely NEW
-- transition later carries a NEW updated_at value (set by whatever
-- takeover/n8n write caused it), so it is processed fresh and correctly
-- overwrites the old recommendation. p_expected_updated_at is optional
-- (defaults NULL, meaning "don't fence" — accept/solve/reopen never pass
-- it and are unaffected); api/smart-assign-conversation.js always
-- supplies it for 'system_assign'.
--
-- Also still gated on conversation_status = 'waiting_human' AND
-- assigned_user_id IS NULL, exactly like 'accept' — a conversation that
-- was accepted, or left waiting_human, between the webhook firing and
-- this call being processed must not receive a stale recommendation.

begin;

drop function if exists public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text);

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
  v_row public.conversation_state%rowtype;
  v_outcome text;
  v_event_type text;
  v_target_user_id uuid;
  -- Who the conversation_events row attributes this to. Defaults to the
  -- caller-supplied actor for accept/solve/reopen (unchanged); forced to
  -- NULL for system_assign regardless of what p_actor_user_id was passed
  -- as, per "actor_user_id = NULL" for a system-selected recommendation —
  -- the function enforces this itself rather than trusting the caller to
  -- always remember to pass null.
  v_actor_user_id uuid;
begin
  if p_action not in ('accept', 'solve', 'reopen', 'system_assign') then
    raise exception 'apply_conversation_lifecycle_action: unsupported action %', p_action;
  end if;

  v_actor_user_id := p_actor_user_id;

  -- Every RETURNS TABLE output column above that shares a name with a
  -- real conversation_state column (conversation_id, sender_id,
  -- conversation_status, current_step, assigned_user_id, assigned_at,
  -- system_assigned_user_id, system_assigned_at, solved_by, solved_at,
  -- reopened_by, reopened_at, updated_at) becomes an implicit PL/pgSQL
  -- output variable in scope for the whole function body, so every
  -- UPDATE/SELECT below qualifies every WHERE-clause column reference
  -- with the `cs` alias (client_id included, for uniform/defensive
  -- style) to avoid the exact "column reference is ambiguous" failure
  -- (Postgres 42702) fixed in the previous migration. SET-clause targets
  -- and the conversation_events INSERT's target column list are left
  -- unqualified — those positions are always resolved as table columns
  -- by the SQL grammar itself, never ambiguous.
  if p_action = 'accept' then
    update public.conversation_state as cs
      set assigned_user_id = p_actor_user_id,
          assigned_at = now()
      where cs.client_id = p_client_id
        and cs.conversation_id = p_conversation_id
        and cs.conversation_status = 'waiting_human'
        and cs.assigned_user_id is null
      returning cs.* into v_row;

    if found then
      v_outcome := 'ok';
      v_event_type := 'accepted';
      v_target_user_id := p_actor_user_id;
    else
      select cs.* into v_row from public.conversation_state as cs
        where cs.client_id = p_client_id and cs.conversation_id = p_conversation_id
        limit 1;
      v_outcome := case when v_row.id is null then 'not_found' else 'conflict' end;
    end if;

  elsif p_action = 'solve' then
    update public.conversation_state as cs
      set conversation_status = 'closed',
          current_step = 'done',
          solved_by = p_actor_user_id,
          solved_at = now(),
          updated_at = now()
      where cs.client_id = p_client_id
        and cs.conversation_id = p_conversation_id
        and (cs.conversation_status <> 'waiting_human' or cs.assigned_user_id = p_actor_user_id)
      returning cs.* into v_row;

    if found then
      v_outcome := 'ok';
      v_event_type := 'solved';
      v_target_user_id := null;
    else
      select cs.* into v_row from public.conversation_state as cs
        where cs.client_id = p_client_id and cs.conversation_id = p_conversation_id
        limit 1;
      v_outcome := case when v_row.id is null then 'not_found' else 'forbidden' end;
    end if;

  elsif p_action = 'reopen' then
    update public.conversation_state as cs
      set conversation_status = 'active',
          current_step = null,
          assigned_user_id = null,
          assigned_at = null,
          reopened_by = p_actor_user_id,
          reopened_at = now(),
          updated_at = now()
      where cs.client_id = p_client_id
        and cs.conversation_id = p_conversation_id
      returning cs.* into v_row;

    if found then
      v_outcome := 'ok';
      v_event_type := 'reopened';
      v_target_user_id := null;
    else
      v_outcome := 'not_found';
    end if;

  elsif p_action = 'system_assign' then
    if p_target_user_id is null then
      raise exception 'apply_conversation_lifecycle_action: system_assign requires p_target_user_id';
    end if;

    v_actor_user_id := null; -- no human actor for a system recommendation

    update public.conversation_state as cs
      set system_assigned_user_id = p_target_user_id,
          system_assigned_at = now(),
          updated_at = now()
      where cs.client_id = p_client_id
        and cs.conversation_id = p_conversation_id
        and cs.conversation_status = 'waiting_human'
        and cs.assigned_user_id is null
        and (p_expected_updated_at is null or cs.updated_at = p_expected_updated_at)
      returning cs.* into v_row;

    if found then
      v_outcome := 'ok';
      v_event_type := 'system_assigned';
      v_target_user_id := p_target_user_id;
    else
      -- Doesn't exist for this client, or is no longer eligible for a
      -- recommendation right now (already accepted, no longer
      -- waiting_human, or this is a stale/duplicate delivery of a
      -- transition already processed — see the header comment). Every
      -- one of these is a safe, silent no-op; 'skipped' is not an error.
      select cs.* into v_row from public.conversation_state as cs
        where cs.client_id = p_client_id and cs.conversation_id = p_conversation_id
        limit 1;
      v_outcome := case when v_row.id is null then 'not_found' else 'skipped' end;
    end if;
  end if;

  if v_outcome = 'ok' then
    insert into public.conversation_events (
      client_id, conversation_state_id, conversation_id, sender_id,
      event_type, actor_user_id, target_user_id
    ) values (
      p_client_id, v_row.id, v_row.conversation_id, v_row.sender_id,
      v_event_type, v_actor_user_id, v_target_user_id
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
      v_row.system_assigned_user_id,
      v_row.system_assigned_at,
      v_row.solved_by,
      v_row.solved_at,
      v_row.reopened_by,
      v_row.reopened_at,
      v_row.updated_at;
end;
$$;

comment on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) is
  'Stage 7B + Smart Assignment V1: transactional accept/solve/reopen/system_assign. Performs the conversation_state update and its matching conversation_events insert in one transaction. NOT an authorization/eligibility layer -- callers (api/claim-conversation.js, api/conversation-status.js, api/smart-assign-conversation.js) must already have authorized the actor/action or computed the target employee before calling this. service_role EXECUTE only -- see the REVOKE/GRANT statements below.';

-- Re-affirmed after the drop/create above — CREATE FUNCTION does not
-- carry over grants from a dropped function, so this is required, not
-- just a safety net, this time.
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from public;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from anon;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from authenticated;
grant execute on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) to service_role;

commit;
