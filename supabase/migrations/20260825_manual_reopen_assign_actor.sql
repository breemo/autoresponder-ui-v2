-- Manual Reopen — corrected final semantics: clicking Reopen means "I am
-- reopening and taking this conversation." The employee performing the
-- action becomes BOTH system_assigned_user_id and assigned_user_id
-- immediately — no Smart Assignment step, no separate Claim afterward.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change (implementation pass only, per
-- explicit instruction not to run it against live Supabase).
--
-- Additive only. Does not edit 20260825_manual_reopen_waiting_human.sql
-- (already executed) or any earlier migration — this migration CREATE OR
-- REPLACEs apply_conversation_lifecycle_action again, with the exact same
-- public signature and RETURNS TABLE shape as before (unchanged), so
-- CREATE OR REPLACE is valid.
--
-- ---------------------------------------------------------------------
-- Why this supersedes 20260825_manual_reopen_waiting_human.sql's own
-- 'reopen' semantics (not a bug in that migration — a product decision
-- made after reviewing its live test)
-- ---------------------------------------------------------------------
-- That migration correctly fixed conversation_status = 'waiting_human'
-- (Human Mode) instead of 'active', but still cleared assigned_user_id,
-- requiring a second explicit Claim after every manual reopen. Live
-- review determined this doesn't match the real semantics of the action:
-- an employee clicking Reopen on a conversation they are looking at IS
-- the act of taking ownership — there is no Smart Assignment step to
-- suggest someone else, and forcing a redundant Claim adds friction
-- without adding any real fairness/ownership benefit (unlike the
-- Claim-after-system_assign flow, where a *different* employee than the
-- one suggested may legitimately want to accept). This migration changes
-- ONLY the 'reopen' branch's field targets to reflect that; accept/solve/
-- system_assign, resolve_conversation, event atomicity, multi-account
-- (id + client_id) targeting, and the conversation_state compatibility
-- dual-write mechanism are all unchanged, copied byte-for-byte from
-- 20260825_manual_reopen_waiting_human.sql.
--
-- ---------------------------------------------------------------------
-- Architectural roles — unchanged, respected by this migration
-- ---------------------------------------------------------------------
-- conversations = authoritative CURRENT state (this migration's target).
-- conversation_events = authoritative lifecycle HISTORY — exactly ONE
-- 'reopened' event is inserted per manual reopen, same as before. No
-- synthetic 'system_assigned'/'accepted' events are created — those
-- actions did not happen; the 'reopened' event's own actor_user_id
-- already explains who the new owner is, without duplicating history.
-- target_user_id for the 'reopened' event is left at its existing
-- behavior (null) — the event schema's own documented meaning for
-- target_user_id is "who the event is about, WHEN DIFFERENT FROM
-- actor_user_id" (see conversation_events.target_user_id's column
-- comment in 20260820_conversation_lifecycle_tracking.sql); since actor
-- and new-owner are the same person here, actor_user_id alone already
-- fully captures it, and inventing a redundant target_user_id would not
-- match any existing reopen-event convention.
-- conversation_state = temporary LEGACY compatibility SNAPSHOT only —
-- kept in sync with the same current-state fields, no new historical
-- responsibility added to it.
--
-- ---------------------------------------------------------------------
-- Not touched (verified, not assumed)
-- ---------------------------------------------------------------------
-- resolve_conversation and its same-day/new-day customer-return
-- semantics (Rule 3/4) are a structurally separate function, not edited
-- by this migration at all — automatic customer return after Close
-- keeps clearing both assignment fields and setting conversation_status
-- = 'active', exactly as previously approved.

begin;

create or replace function public.apply_conversation_lifecycle_action(
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
  -- Matched by (client_id, conversation_id) — never used to decide WHICH
  -- conversations row to update.
  select cs.* into v_state
    from public.conversation_state as cs
    where cs.client_id = p_client_id
      and cs.conversation_id = p_conversation_id
    limit 1;

  -- ---------------------------------------------------------------------
  -- Step 2: authoritative UPDATE on conversations, per action. Every
  -- WHERE clause below targets conversations.id + client_id only — never
  -- sender_id — matching the multi-account safety requirement.
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
    -- MANUAL EMPLOYEE REOPEN — final approved semantics. Clicking Reopen
    -- itself means "I am reopening and taking this conversation": no
    -- Smart Assignment step, no separate Claim required. p_actor_user_id
    -- becomes BOTH the designated (system_assigned_user_id) and the
    -- actual owner (assigned_user_id) in the same atomic write. Requires
    -- a real actor — unlike the prior version, an anonymous reopen with
    -- no actor can no longer silently leave the conversation genuinely
    -- unowned while claiming a specific owner in current_step-adjacent
    -- fields.
    if p_actor_user_id is null then
      raise exception 'apply_conversation_lifecycle_action: reopen requires p_actor_user_id';
    end if;

    update public.conversations as cv
      set conversation_status = 'waiting_human',
          current_step = null,
          closed_at = null,
          system_assigned_user_id = p_actor_user_id,
          system_assigned_at = now(),
          assigned_user_id = p_actor_user_id,
          assigned_at = now(),
          reopened_by = p_actor_user_id,
          reopened_at = now(),
          updated_at = now()
      where cv.id = p_conversation_id
        and cv.client_id = p_client_id
      returning cv.* into v_conv;

    if found then
      v_outcome := 'ok';
      v_event_type := 'reopened';
      -- target_user_id left null: actor_user_id (= p_actor_user_id)
      -- already fully identifies the new owner; target_user_id's own
      -- documented meaning is "when different from actor_user_id",
      -- which is never the case for this action. See the migration
      -- header for the full reasoning.
      v_event_target_user_id := null;
    else
      v_outcome := 'not_found';
    end if;

  elsif p_action = 'system_assign' then
    if p_target_user_id is null then
      raise exception 'apply_conversation_lifecycle_action: system_assign requires p_target_user_id';
    end if;

    v_actor_user_id := null; -- no human actor for a system recommendation

    -- Idempotency fence: unchanged from the prior version, still keyed
    -- against conversation_state.updated_at.
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
  -- identity (never from conversation_state).
  if v_conv.id is not null then
    select cci.sender_id into v_sender_id
      from public.contact_channel_identities as cci
      where cci.id = v_conv.channel_identity_id;
  end if;

  if v_outcome = 'ok' then
    -- Step 3: best-effort legacy compatibility dual-write. Matched
    -- strictly by (client_id, conversation_id). Historical responsibility
    -- stays with conversation_events, not conversation_state — this is a
    -- CURRENT-STATE snapshot sync only, exactly mirroring what step 2
    -- just wrote to conversations, nothing more.
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
      -- Kept synchronized with the corrected authoritative value above:
      -- both assignment fields now point at the reopening employee.
      update public.conversation_state as cs
        set conversation_status = 'waiting_human',
            current_step = null,
            system_assigned_user_id = p_actor_user_id,
            system_assigned_at = now(),
            assigned_user_id = p_actor_user_id,
            assigned_at = now(),
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

    -- Step 4: append-only event. Exactly ONE row per successful action —
    -- no synthetic additional events are ever inserted here for 'reopen'
    -- (or any other action). conversation_id is ALWAYS the authoritative
    -- v_conv.id (= p_conversation_id).
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
  'Conversation Lifecycle V2 (manual-reopen final semantics): transactional accept/solve/reopen/system_assign, authoritative on public.conversations (targeted strictly by id+client_id — never by sender_id). Manual reopen means "I am taking this conversation": the acting employee becomes BOTH system_assigned_user_id and assigned_user_id immediately, conversation_status becomes waiting_human, no separate Claim is required, and no synthetic system_assigned/accepted events are inserted — only one reopened event, per action. public.conversation_state kept synchronized as a temporary best-effort compatibility snapshot only (no added historical responsibility). Same public signature and RETURNS TABLE shape as every prior version — no caller needs to change. NOT an authorization/eligibility layer. service_role EXECUTE only.';

revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from public;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from anon;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from authenticated;
grant execute on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) to service_role;

commit;
