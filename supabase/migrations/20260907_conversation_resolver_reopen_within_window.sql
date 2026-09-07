-- Conversation Resolver — auto-reopen a conversation that was closed < 2h ago.
--
-- Supersedes ONLY the closed-conversation branch of
-- 20260828_conversation_resolver_inactivity_timeout.sql (LIVE in
-- production). That version NEVER auto-reopened a closed conversation:
-- with no open conversation it always INSERTed a brand-new one
-- (resolution 'new_after_closed'). Live incident UC10 confirmed the
-- consequence — a Facebook customer who replied ~11 minutes after an
-- employee manually closed the conversation:
--   old  13d0ab75-061c-45c3-96b9-0d24e1b011a7  closed_at  2026-09-07 05:52:53Z
--   new  05932dfe-2c17-4f24-a475-254c30682153  started_at 2026-09-07 06:03:45Z
--   (same client, same channel_identity_id, same sender_id, same channel_key)
-- got a SECOND conversation instead of a continuation. Similar cases were
-- seen on Telegram and historically on WhatsApp/Facebook within
-- seconds/minutes of a manual close.
--
-- Run manually against Supabase (SQL editor / your own tooling). This file
-- is NOT executed automatically by this repo and was NOT run as part of
-- this change.
--
-- Depends on (all already live):
--   20260823_conversation_model_redesign_stage_a.sql
--   20260828_conversation_resolver_inactivity_timeout.sql   (redefined here)
--   20260828_conversations_last_message_at_trigger.sql      (feeds the open-branch check)
--   20260825_conversation_lifecycle_v2.sql                  (conversation_events.conversation_state_id nullable)
--
-- ---------------------------------------------------------------------
-- Final approved CLOSED-conversation rule (this migration implements it)
-- ---------------------------------------------------------------------
-- Customer inbound, NO open conversation, a prior CLOSED one exists:
--
--   now - closed_at  <  2 hours
--     -> AUTO-REOPEN THE SAME conversation (do NOT create a new row).
--        conversation_status = 'active', current_step = null, closed_at = null.
--        Clear human ownership + recommendation:
--          assigned_user_id / assigned_at               -> null
--          system_assigned_user_id / system_assigned_at -> null
--        PRESERVE historical solved_by/solved_at and reopened_by/reopened_at
--          (conversation_events is the authoritative lifecycle history —
--           a solve that happened, happened).
--        MUST NOT become 'waiting_human'. MUST NOT stay claimed by the
--          previously-assigned employee.
--        AI/Auto resumes per the channel account reply_mode — downstream
--          check_human_stop only halts automation on 'waiting_human'/'closed'.
--        is_new_conversation = false  -> NO new-conversation Welcome.
--        resolution = 'reopened_after_close', event_type = 'reopened'.
--        A 'reopened' conversation_events row is written (actor_user_id NULL,
--          metadata.reason = 'customer_returned_within_window').
--
--   now - closed_at  >=  2 hours
--     -> create a NEW 'active' conversation (resolution 'new_after_closed').
--        The old conversation stays historical.
--
--   Calendar date / same-business-day / midnight play NO part — only the
--   2h gap from closed_at matters. utc_plus_3_business_day() stays unused.
--
-- Everything else is BYTE-IDENTICAL to
-- 20260828_conversation_resolver_inactivity_timeout.sql:
--   * Section 0 (normalize/validate) + per-(client,platform,sender)
--     pg_advisory_xact_lock.
--   * Section 1 (contact + channel-identity resolution).
--   * Section 2 OPEN branch (active | waiting_human): < 2h since
--     last_message_at -> same conversation, untouched; >= 2h -> close the
--     stale one (system 'closed' event, reason=inactivity_timeout) and
--     open a fresh 'active' one. A stale waiting_human is closed and NOT
--     inherited.
--   * Signature + RETURNS TABLE shape — no n8n / API change needed.
--
-- Only NEW `resolution` / `event_type` VALUES are introduced. Verified: no
-- consumer branches on them — n8n keys Welcome, legacy-reset and the human
-- hard-stop on is_new_conversation and conversation_status only.
--
-- ---------------------------------------------------------------------
-- conversation_state (legacy, best-effort — conversations stays authoritative)
-- ---------------------------------------------------------------------
-- The prior resolver deliberately never touched conversation_state. This
-- one adds ONE best-effort mirror UPDATE, on the auto-reopen path only, so
-- the transitional legacy snapshot does not keep showing a stale employee
-- / claim for a conversation the resolver just handed back to automation
-- (api/_lib/conversationsList.js still falls back to conversation_state for
-- assignment fields while Lifecycle V2 finishes rolling out). Matched
-- strictly by (client_id, conversation_id); a missing row is a no-op.
--
-- ---------------------------------------------------------------------
-- Concurrency / security — unchanged
-- ---------------------------------------------------------------------
-- Same per-(client, platform, sender) pg_advisory_xact_lock, held to
-- COMMIT/ROLLBACK. Same SECURITY INVOKER, service_role-only EXECUTE. The
-- auto-reopen is a single UPDATE on an already-existing row that moves it
-- INTO the partial-unique index predicate
-- (conversations_one_open_per_channel_identity_idx); under the advisory
-- lock no concurrent call can have created another open row for this
-- identity, and the "no open conversation" SELECT immediately above
-- guarantees none exists right now. The unique_violation EXCEPTION block
-- on the new-row path is kept as an unreachable-but-deterministic backstop.

begin;

-- DROP + CREATE (same pattern as
-- 20260828_conversation_resolver_inactivity_timeout.sql) so the identical
-- RETURNS TABLE is re-established cleanly. Nothing in the database depends
-- on this function — it is only ever called as a PostgREST RPC by n8n.
drop function if exists public.resolve_conversation(uuid, text, text, text, timestamptz);

create function public.resolve_conversation(
  p_client_id uuid,
  p_platform text,
  p_sender_id text,
  p_channel_key text default null,
  p_now timestamptz default now()
)
returns table (
  contact_id uuid,
  channel_identity_id uuid,
  conversation_id uuid,
  conversation_status text,
  current_step text,
  is_new_contact boolean,
  is_new_channel_identity boolean,
  is_new_conversation boolean,
  resolution text,          -- 'existing_open' | 'new_after_timeout' | 'new_after_closed' | 'first_conversation' | 'reopened_after_close'
  event_type text           -- 'closed' (auto-closed a stale conversation) | 'reopened' (auto-reopened one closed < 2h ago) | null
)
language plpgsql
as $$
declare
  c_inactivity_timeout constant interval := interval '2 hours';

  v_now timestamptz;
  v_platform text;
  v_sender_id text;
  v_channel_key text;

  v_contact_id uuid;
  v_created_new_contact boolean := false;
  v_speculative_contact_id uuid;

  v_channel_identity_id uuid;
  v_is_new_contact boolean := false;
  v_is_new_channel_identity boolean := false;
  v_is_new_conversation boolean := false;

  v_existing_channel_identity_row public.contact_channel_identities%rowtype;
  v_open_conversation public.conversations%rowtype;
  v_latest_conversation public.conversations%rowtype;
  v_had_prior_conversation boolean := false;

  v_last_activity timestamptz;
  v_prior_conversation_id uuid;
  v_prior_status text;

  v_resolution text;
  v_event_type text;
begin
  -- ---------------------------------------------------------------------
  -- 0. Normalize + validate input
  -- ---------------------------------------------------------------------
  v_now := coalesce(p_now, now());
  v_platform := lower(btrim(p_platform));
  v_sender_id := btrim(p_sender_id);
  v_channel_key := nullif(btrim(p_channel_key), '');

  if p_client_id is null then
    raise exception 'resolve_conversation: p_client_id is required';
  end if;
  if coalesce(v_platform, '') = '' then
    raise exception 'resolve_conversation: p_platform must not be blank';
  end if;
  if coalesce(v_sender_id, '') = '' then
    raise exception 'resolve_conversation: p_sender_id must not be blank';
  end if;

  -- Serialize every call for this (client, platform, sender). Held to
  -- COMMIT/ROLLBACK. See Stage B's header for the full rationale.
  perform pg_advisory_xact_lock(
    hashtextextended(p_client_id::text || '|' || v_platform || '|' || v_sender_id, 0)
  );

  -- ---------------------------------------------------------------------
  -- 1. Contact + Channel Identity resolution  (UNCHANGED from Stage B)
  -- ---------------------------------------------------------------------
  -- 1a. Exact channel identity match -- the fast, common path.
  select cci.* into v_existing_channel_identity_row
    from public.contact_channel_identities as cci
    where cci.client_id = p_client_id
      and cci.platform = v_platform
      and cci.sender_id = v_sender_id
      and coalesce(cci.channel_key, '') = coalesce(v_channel_key, '')
    limit 1;

  if found then
    v_contact_id := v_existing_channel_identity_row.contact_id;
    v_channel_identity_id := v_existing_channel_identity_row.id;
    v_is_new_contact := false;
    v_is_new_channel_identity := false;

    update public.contact_channel_identities as cci
      set last_seen_at = v_now,
          updated_at = v_now
      where cci.id = v_channel_identity_id;
  else
    -- 1b. Same (client_id, platform, sender_id), any channel_key -- reuse contact_id.
    select cci.contact_id into v_contact_id
      from public.contact_channel_identities as cci
      where cci.client_id = p_client_id
        and cci.platform = v_platform
        and cci.sender_id = v_sender_id
      order by cci.first_seen_at asc
      limit 1;

    if v_contact_id is null then
      -- 1c. Truly never seen before -- new (speculative) contact.
      insert into public.contacts (client_id, created_at, updated_at)
        values (p_client_id, v_now, v_now)
        returning contacts.id into v_contact_id;

      v_created_new_contact := true;
      v_speculative_contact_id := v_contact_id;
    end if;

    begin
      insert into public.contact_channel_identities as cci (
        client_id, contact_id, platform, sender_id, channel_key,
        first_seen_at, last_seen_at, created_at, updated_at
      ) values (
        p_client_id, v_contact_id, v_platform, v_sender_id, v_channel_key,
        v_now, v_now, v_now, v_now
      )
      returning cci.id into v_channel_identity_id;

      v_is_new_channel_identity := true;
      v_is_new_contact := v_created_new_contact;
    exception
      when unique_violation then
        select cci.* into v_existing_channel_identity_row
          from public.contact_channel_identities as cci
          where cci.client_id = p_client_id
            and cci.platform = v_platform
            and cci.sender_id = v_sender_id
            and coalesce(cci.channel_key, '') = coalesce(v_channel_key, '')
          limit 1;

        if not found then
          raise;
        end if;

        v_channel_identity_id := v_existing_channel_identity_row.id;
        v_contact_id := v_existing_channel_identity_row.contact_id;
        v_is_new_channel_identity := false;
        v_is_new_contact := false;

        if v_created_new_contact and v_speculative_contact_id is distinct from v_contact_id then
          delete from public.contacts as c where c.id = v_speculative_contact_id;
        end if;

        update public.contact_channel_identities as cci
          set last_seen_at = v_now,
              updated_at = v_now
          where cci.id = v_channel_identity_id;
    end;
  end if;

  -- ---------------------------------------------------------------------
  -- 2. Conversation resolution — inactivity timeout + <2h reopen
  -- ---------------------------------------------------------------------
  select cv.* into v_open_conversation
    from public.conversations as cv
    where cv.channel_identity_id = v_channel_identity_id
      and cv.conversation_status in ('active', 'waiting_human')
    limit 1;

  if found then
    -- Inactivity is measured from the last ACTUAL persisted message
    -- (conversations.last_message_at, maintained by the messages trigger),
    -- falling back to started_at for a conversation with no message yet.
    v_last_activity := coalesce(v_open_conversation.last_message_at, v_open_conversation.started_at, v_now);

    if (v_now - v_last_activity) < c_inactivity_timeout then
      -- A: still inside the window -> SAME conversation, returned
      -- completely untouched. A waiting_human conversation stays
      -- waiting_human (the human hard-stop downstream still applies).
      v_is_new_conversation := false;
      v_resolution := 'existing_open';
      v_event_type := null;
    else
      -- B: inactive for >= 2h -> close the old, audit it, open a fresh
      -- 'active' conversation. A stale waiting_human is closed here too
      -- and the NEW conversation does NOT inherit it.
      v_prior_conversation_id := v_open_conversation.id;
      v_prior_status := v_open_conversation.conversation_status;

      update public.conversations as cv
        set conversation_status = 'closed',
            closed_at = v_now,
            current_step = null,
            updated_at = v_now
        where cv.id = v_prior_conversation_id;

      insert into public.conversation_events (
        client_id, conversation_state_id, conversation_id, sender_id,
        event_type, actor_user_id, metadata
      ) values (
        p_client_id, null, v_prior_conversation_id, v_sender_id,
        'closed', null,
        jsonb_build_object(
          'reason', 'inactivity_timeout',
          'timeout_hours', 2,
          'inactive_seconds', floor(extract(epoch from (v_now - v_last_activity)))::bigint,
          'prior_status', v_prior_status,
          'closed_by', 'resolver'
        )
      );

      begin
        insert into public.conversations as cv (
          client_id, contact_id, channel_identity_id, platform,
          conversation_status, current_step, closed_at, started_at, created_at, updated_at
        ) values (
          p_client_id, v_contact_id, v_channel_identity_id, v_platform,
          'active', null, null, v_now, v_now, v_now
        )
        returning cv.* into v_open_conversation;

        v_is_new_conversation := true;
        v_resolution := 'new_after_timeout';
        v_event_type := 'closed';   -- describes what happened to the PRIOR conversation
      exception
        when unique_violation then
          select cv.* into v_open_conversation
            from public.conversations as cv
            where cv.channel_identity_id = v_channel_identity_id
              and cv.conversation_status in ('active', 'waiting_human')
            limit 1;
          if not found then
            raise;
          end if;
          v_is_new_conversation := false;
          v_resolution := 'existing_open';
          v_event_type := null;
      end;
    end if;
  else
    -- D: no OPEN conversation. Look at the most recent conversation of ANY
    -- status to decide: auto-reopen (< 2h) vs new conversation (>= 2h /
    -- none).
    select cv.* into v_latest_conversation
      from public.conversations as cv
      where cv.channel_identity_id = v_channel_identity_id
      order by cv.started_at desc
      limit 1;
    v_had_prior_conversation := found;

    if v_had_prior_conversation
       and v_latest_conversation.conversation_status = 'closed'
       and v_latest_conversation.closed_at is not null
       and (v_now - v_latest_conversation.closed_at) < c_inactivity_timeout
    then
      -- D1: the most recent conversation was CLOSED less than 2h ago ->
      -- AUTO-REOPEN THE SAME conversation. The customer is continuing the
      -- same session. Business-day / midnight play no part.
      update public.conversations as cv
        set conversation_status = 'active',
            current_step = null,
            closed_at = null,
            assigned_user_id = null,
            assigned_at = null,
            system_assigned_user_id = null,
            system_assigned_at = null,
            updated_at = v_now
        where cv.id = v_latest_conversation.id
        returning cv.* into v_open_conversation;

      -- Lifecycle audit trail: system/customer-driven reopen, no human
      -- actor. 'reopened' is an existing allowed conversation_events
      -- event_type. conversation_state_id is NULL (this resolver operates
      -- on public.conversations only; the column is nullable).
      insert into public.conversation_events (
        client_id, conversation_state_id, conversation_id, sender_id,
        event_type, actor_user_id, metadata
      ) values (
        p_client_id, null, v_latest_conversation.id, v_sender_id,
        'reopened', null,
        jsonb_build_object(
          'reason', 'customer_returned_within_window',
          'timeout_hours', 2,
          'closed_for_seconds',
            floor(extract(epoch from (v_now - v_latest_conversation.closed_at)))::bigint,
          'prior_solved_by', v_latest_conversation.solved_by,
          'reopened_by', 'resolver'
        )
      );

      -- Best-effort legacy compatibility mirror (conversations stays
      -- authoritative). Keeps the transitional conversation_state snapshot
      -- from showing a stale employee/claim for a conversation just
      -- handed back to automation. Matched strictly by
      -- (client_id, conversation_id); a missing row is a no-op.
      update public.conversation_state as cs
        set conversation_status = 'active',
            current_step = null,
            assigned_user_id = null,
            assigned_at = null,
            system_assigned_user_id = null,
            system_assigned_at = null,
            updated_at = v_now
        where cs.client_id = p_client_id
          and cs.conversation_id = v_latest_conversation.id;

      v_is_new_conversation := false;
      v_resolution := 'reopened_after_close';
      v_event_type := 'reopened';
    else
      -- D2: no prior conversation at all, or the most recent one was
      -- closed >= 2h ago -> start a NEW 'active' conversation. The old one
      -- stays historical. Manual Reopen remains a separate explicit
      -- employee action (apply_conversation_lifecycle_action 'reopen',
      -- itself window-limited to < 2h since closed_at).
      begin
        insert into public.conversations as cv (
          client_id, contact_id, channel_identity_id, platform,
          conversation_status, current_step, closed_at, started_at, created_at, updated_at
        ) values (
          p_client_id, v_contact_id, v_channel_identity_id, v_platform,
          'active', null, null, v_now, v_now, v_now
        )
        returning cv.* into v_open_conversation;

        v_is_new_conversation := true;
        v_resolution := case
          when v_had_prior_conversation then 'new_after_closed'
          else 'first_conversation'
        end;
        v_event_type := null;
      exception
        when unique_violation then
          select cv.* into v_open_conversation
            from public.conversations as cv
            where cv.channel_identity_id = v_channel_identity_id
              and cv.conversation_status in ('active', 'waiting_human')
            limit 1;
          if not found then
            raise;
          end if;
          v_is_new_conversation := false;
          v_resolution := 'existing_open';
          v_event_type := null;
      end;
    end if;
  end if;

  return query
    select
      v_contact_id,
      v_channel_identity_id,
      v_open_conversation.id,
      v_open_conversation.conversation_status,
      v_open_conversation.current_step,
      v_is_new_contact,
      v_is_new_channel_identity,
      v_is_new_conversation,
      v_resolution,
      v_event_type;
end;
$$;

comment on function public.resolve_conversation(uuid, text, text, text, timestamptz) is
  'Unified Conversation Resolver (inactivity-timeout lifecycle + <2h reopen). Session identity is based purely on elapsed time. OPEN (active|waiting_human): < 2h since last persisted message -> same conversation; >= 2h -> close the stale one (system ''closed'' event, reason=inactivity_timeout) and open a new ''active'' one (stale waiting_human is NOT inherited). NO open + a prior CLOSED conversation: closed < 2h ago -> AUTO-REOPEN the SAME row to ''active'' (clear current_step/closed_at and all assignment/recommendation fields, preserve solved_*/reopened_*, write a ''reopened'' event, is_new_conversation=false, resolution=''reopened_after_close''); closed >= 2h ago -> new ''active'' conversation (resolution ''new_after_closed''). Calendar date / same-business-day / midnight play no part. Does NOT send Welcome (downstream keys it on is_new_conversation). Best-effort mirrors conversation_state on the auto-reopen path only; conversations is authoritative. Same signature and RETURNS TABLE shape as Stage B. service_role EXECUTE only.';

revoke all on function public.resolve_conversation(uuid, text, text, text, timestamptz) from public;
revoke all on function public.resolve_conversation(uuid, text, text, text, timestamptz) from anon;
revoke all on function public.resolve_conversation(uuid, text, text, text, timestamptz) from authenticated;
grant execute on function public.resolve_conversation(uuid, text, text, text, timestamptz) to service_role;

commit;

-- ---------------------------------------------------------------------
-- Explicitly NOT done here
-- ---------------------------------------------------------------------
-- - messages / conversation_events schema: not altered.
-- - conversation_state: only the one best-effort mirror UPDATE described
--   above (auto-reopen path). n8n's legacy upsert_conversation_state node
--   still owns it otherwise.
-- - apply_conversation_lifecycle_action: changed by the sibling migration
--   20260907_manual_reopen_2h_window.sql, not here.
-- - n8n workflows: NOT modified. resolve_conversation_v2 calls this with
--   the same 4 args; prepare_conversation / Welcome Gate / needs_legacy_reset
--   / check_human_stop already key on is_new_conversation and
--   conversation_status only (verified) — an auto-reopen returns
--   is_new_conversation=false and conversation_status='active', so no
--   Welcome and no human hard-stop fire, and automation resumes.
-- - utc_plus_3_business_day(): still unused; drop in a later cleanup.
-- - Scheduled auto-close of conversations that go stale and never receive
--   another message: still NOT implemented (see the note in
--   20260828_conversation_resolver_inactivity_timeout.sql).
-- - No SQL in this file was executed against Supabase.
