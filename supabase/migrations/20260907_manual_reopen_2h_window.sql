-- Manual employee Reopen — enforce the 2-hour window + handle the
-- one-open-per-channel-identity invariant with a CONTROLLED outcome.
--
-- Supersedes ONLY the 'reopen' branch of
-- 20260825_manual_reopen_assign_actor.sql (LIVE in production). accept /
-- solve / system_assign, the (id + client_id) multi-account targeting, the
-- conversation_events atomicity and the conversation_state compatibility
-- dual-write are all copied byte-for-byte from that migration.
--
-- Run manually against Supabase (SQL editor / your own tooling). This file
-- is NOT executed automatically by this repo and was NOT run as part of
-- this change.
--
-- ---------------------------------------------------------------------
-- Two confirmed production bugs this fixes
-- ---------------------------------------------------------------------
-- 1. The deployed 'reopen' branch has NO closed_at age restriction — an
--    employee could reopen a conversation closed days ago. Approved rule:
--    manual Reopen is allowed ONLY when
--       conversation_status = 'closed'
--       AND closed_at IS NOT NULL
--       AND now() - closed_at < interval '2 hours'.
--    Outside the window -> return outcome 'expired' (a deterministic
--    non-success), NOT a raised error.
--
-- 2. The deployed 'reopen' branch does an unconditional UPDATE ... SET
--    conversation_status = 'waiting_human'. If the customer already
--    messaged again and the resolver started a fresh session, another
--    OPEN conversation now exists for the same channel_identity_id, and
--    that UPDATE violates the partial unique index
--    conversations_one_open_per_channel_identity_idx -> a raw 23505
--    propagates out of the RPC -> api/_lib/conversationLifecycle.js
--    returns HTTP 500 "فشل في تحديث حالة المحادثة" (UC10 second symptom).
--    Now: detect the other open conversation up front and return outcome
--    'conflict'; the UPDATE is additionally wrapped in
--    EXCEPTION WHEN unique_violation -> 'conflict' as a race backstop.
--
-- ---------------------------------------------------------------------
-- Semantics WITHIN the window — unchanged from
-- 20260825_manual_reopen_assign_actor.sql
-- ---------------------------------------------------------------------
-- "I am reopening and taking this conversation": conversation_status ->
-- 'waiting_human', the acting employee becomes BOTH system_assigned_user_id
-- and assigned_user_id, current_step -> null, closed_at -> null,
-- reopened_by/reopened_at -> actor/now(). Exactly one 'reopened'
-- conversation_events row. No separate Claim required.
--
-- NOTE (intentional): the resolver's AUTOMATIC customer-return reopen
-- (20260907_conversation_resolver_reopen_within_window.sql) resolves to
-- 'active' with NO assignment — a different actor (the customer) and a
-- different intent. This RPC is the EMPLOYEE action and keeps its
-- take-ownership semantics.
--
-- Same public signature and RETURNS TABLE shape as every prior version —
-- no caller needs to change. NOT an authorization/eligibility layer.
-- service_role EXECUTE only.

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
  outcome text,                    -- 'ok' | 'conflict' | 'forbidden' | 'not_found' | 'skipped' | 'expired' | 'already_open'
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
  c_reopen_window constant interval := interval '2 hours';

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
    -- MANUAL EMPLOYEE REOPEN — window-limited + conflict-safe.
    if p_actor_user_id is null then
      raise exception 'apply_conversation_lifecycle_action: reopen requires p_actor_user_id';
    end if;

    -- Load the target FIRST so every outcome is deterministic and no
    -- uncontrolled error (a 23505 from the one-open-per-identity partial
    -- unique index in particular) can reach the caller.
    select cv.* into v_conv
      from public.conversations as cv
      where cv.id = p_conversation_id
        and cv.client_id = p_client_id;

    if not found then
      v_outcome := 'not_found';

    elsif v_conv.conversation_status <> 'closed' or v_conv.closed_at is null then
      -- Not a closed conversation (already open, or closed without a
      -- closed_at) -> nothing to reopen. Deterministic, not an error.
      v_outcome := 'already_open';

    elsif (now() - v_conv.closed_at) >= c_reopen_window then
      -- Reopen window expired: the conversation is historical/archived.
      -- The employee cannot reopen it; a later customer message will
      -- start a new conversation (or, within 2h, the resolver reopens it
      -- automatically — but that path is closed here by definition).
      v_outcome := 'expired';

    elsif exists (
      select 1
      from public.conversations as o
      where o.channel_identity_id = v_conv.channel_identity_id
        and o.id <> v_conv.id
        and o.conversation_status in ('active', 'waiting_human')
    ) then
      -- Another conversation for this same customer/channel is already
      -- open (e.g. the customer messaged again and the resolver started a
      -- fresh session). Reopening this one would violate the
      -- one-open-per-channel-identity invariant -> controlled conflict.
      v_outcome := 'conflict';

    else
      begin
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
          v_event_target_user_id := null;
        else
          v_outcome := 'not_found';
        end if;
      exception
        when unique_violation then
          -- Race: another open conversation appeared between the check
          -- above and this UPDATE. Same controlled conflict outcome — no
          -- 23505 leaves this function.
          v_outcome := 'conflict';
      end;
    end if;

  elsif p_action = 'system_assign' then
    if p_target_user_id is null then
      raise exception 'apply_conversation_lifecycle_action: system_assign requires p_target_user_id';
    end if;

    v_actor_user_id := null; -- no human actor for a system recommendation

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
    -- strictly by (client_id, conversation_id). CURRENT-STATE snapshot
    -- sync only — historical responsibility stays with conversation_events.
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

    -- Step 4: append-only event. Exactly ONE row per successful action.
    -- conversation_id is ALWAYS the authoritative v_conv.id (= p_conversation_id).
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
  'Conversation Lifecycle V2 (manual-reopen 2h window + conflict-safe): transactional accept/solve/reopen/system_assign, authoritative on public.conversations (targeted strictly by id+client_id). Manual reopen is allowed ONLY when the conversation is closed with closed_at within the last 2 hours -> outcome ''expired'' otherwise; if another open conversation already exists for the same channel_identity_id -> outcome ''conflict'' (no raw 23505 ever leaves the function); if the conversation is not closed -> outcome ''already_open''. Within the window the acting employee becomes BOTH system_assigned_user_id and assigned_user_id, status -> waiting_human, exactly one ''reopened'' event, no separate Claim. accept/solve/system_assign and the conversation_state compatibility dual-write are unchanged from 20260825_manual_reopen_assign_actor.sql. Same signature and RETURNS TABLE shape. NOT an authorization/eligibility layer. service_role EXECUTE only.';

revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from public;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from anon;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from authenticated;
grant execute on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) to service_role;

commit;
