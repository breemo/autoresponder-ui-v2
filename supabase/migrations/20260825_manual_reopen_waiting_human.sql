-- Manual Reopen fix — corrects apply_conversation_lifecycle_action's
-- 'reopen' action to return a manually-reopened conversation to
-- 'waiting_human' (Human Mode) instead of 'active' (normal AI flow).
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change (implementation pass only, per
-- explicit instruction not to run it against live Supabase).
--
-- Additive only. Does not edit 20260825_conversation_lifecycle_v2.sql (or
-- any earlier already-executed migration) — this migration CREATE OR
-- REPLACEs apply_conversation_lifecycle_action with the exact same public
-- signature and RETURNS TABLE shape as that migration (no change to
-- either), so CREATE OR REPLACE is valid here (unlike the DROP+CREATE
-- used previously only because a RETURNS TABLE column was being added).
--
-- ---------------------------------------------------------------------
-- Confirmed problem this migration fixes (manual live test)
-- ---------------------------------------------------------------------
-- 'reopen' predates Human Mode / Conversation Lifecycle V2 — it was
-- originally "reset a bot-closed conversation back to normal AI flow",
-- and was never updated when Close/Reopen started being used on
-- human-handled (system_assigned/claimed/solved) conversations too.
-- Setting conversation_status = 'active' on manual reopen meant: (a) the
-- Portal rendered the "never touched by a human" button set (Transfer to
-- Agent / open composer to any teammate — see ClientMessages.jsx's
-- `conversationStatus !== "waiting_human" && conversationStatus !==
-- "closed"` / `canControlConversation = !isWaitingHuman || isOwnedByMe`),
-- and (b) AutoResponder_WhatsApp_V2.json's check_human_stop guard (gated
-- on conversation_status === 'closed' || 'waiting_human') would no longer
-- block automation for that conversation's next inbound message — a live
-- violation of the already-approved "automation must not resume merely
-- because an employee reopened it" rule.
--
-- ---------------------------------------------------------------------
-- Scope — ONLY the 'reopen' branch's conversation_status target changes
-- ---------------------------------------------------------------------
-- Every other action (accept/solve/system_assign), every other field
-- 'reopen' already touched (current_step -> null, closed_at -> null,
-- assigned_user_id/assigned_at -> null, reopened_by/reopened_at ->
-- actor/now()), the multi-account-safe (id+client_id) targeting, the
-- conversation_events atomicity, and the conversation_state compatibility
-- dual-write mechanism are all copied byte-for-byte from
-- 20260825_conversation_lifecycle_v2.sql. system_assigned_user_id/
-- system_assigned_at and solved_by/solved_at remain untouched by 'reopen'
-- (preserved), exactly as before — this migration does not add any new
-- field writes, only changes one value. resolve_conversation (same-day/
-- new-day customer return) is not touched by this migration at all —
-- Rule 3's own "clear both assignment fields, conversation_status =
-- 'active'" behavior for a CUSTOMER's automatic same-day return remains
-- exactly as previously approved; that is a structurally separate code
-- path from this RPC's manual 'reopen' action and is not affected by
-- this change.
--
-- The employee who clicks Reopen does NOT become assigned_user_id — it
-- stays null, same as before, so the conversation returns to an
-- unclaimed waiting_human state requiring an explicit Claim (preserves
-- the existing first-to-accept fairness model already used everywhere
-- else in this app).

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
    -- MANUAL EMPLOYEE REOPEN — fixed by this migration. Returns to
    -- 'waiting_human' (Human Mode), NOT 'active' (normal AI flow), so
    -- automation stays blocked by the existing check_human_stop guard and
    -- the Portal renders the correct waiting_human/unclaimed button set.
    -- closed_at cleared so resolve_conversation's Rule 1/2 sees this
    -- conversation as open again. assigned_user_id/assigned_at cleared —
    -- the reopening employee does NOT become the owner; an explicit Claim
    -- is still required, preserving first-to-accept fairness.
    -- system_assigned_user_id/system_assigned_at and solved_by/solved_at
    -- remain untouched (preserved), exactly as the prior version already
    -- did — this migration changes no other field's behavior.
    update public.conversations as cv
      set conversation_status = 'waiting_human',
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

    -- Idempotency fence: unchanged from the prior version, still keyed
    -- against conversation_state.updated_at (still what the Database
    -- Webhook hands back as record.updated_at). Only blocks when a
    -- matching legacy row EXISTS and its updated_at disagrees — a
    -- missing legacy row never blocks the authoritative action.
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
    -- row if it is CURRENTLY the one representing this exact conversation;
    -- never re-derives eligibility from conversation_state's own columns.
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
      -- Kept synchronized with the corrected authoritative value above.
      update public.conversation_state as cs
        set conversation_status = 'waiting_human',
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
    -- authoritative v_conv.id (= p_conversation_id).
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
  'Conversation Lifecycle V2 (manual-reopen fix): transactional accept/solve/reopen/system_assign, authoritative on public.conversations (targeted strictly by id+client_id — never by sender_id). Manual reopen returns the conversation to waiting_human (Human Mode), not active, so automation stays blocked and the reopening employee does not auto-claim it. public.conversation_state kept synchronized as a temporary best-effort compatibility dual-write. Same public signature and RETURNS TABLE shape as 20260825_conversation_lifecycle_v2.sql — no caller needs to change. NOT an authorization/eligibility layer. service_role EXECUTE only.';

-- CREATE OR REPLACE preserves existing grants when the signature is
-- unchanged, but re-affirmed explicitly for defensive clarity/consistency
-- with every other RPC migration in this repo.
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from public;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from anon;
revoke all on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) from authenticated;
grant execute on function public.apply_conversation_lifecycle_action(uuid, uuid, uuid, text, uuid, timestamptz) to service_role;

commit;
