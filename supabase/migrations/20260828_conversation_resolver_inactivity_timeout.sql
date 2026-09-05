-- Conversation Resolver — inactivity-timeout lifecycle (replaces Stage B Rules 1-5).
--
-- Run this manually against the Supabase project (SQL editor / your own
-- tooling) — it is NOT executed automatically by this repo, and was NOT
-- run as part of this change.
--
-- Depends on (all already live per prior instruction):
--   - 20260823_conversation_model_redesign_stage_a.sql  (contacts,
--     contact_channel_identities, conversations, conversation_events
--     event_type vocabulary incl. 'closed')
--   - 20260823_conversation_resolver_stage_b.sql        (the function this
--     one redefines; its Section 1 contact/channel-identity resolution is
--     reproduced here UNCHANGED)
--   - 20260825_conversation_lifecycle_v2.sql            (relaxed
--     conversation_events.conversation_state_id to NULL — re-asserted
--     defensively below in case it is not yet applied)
-- Apply together with / after
--   20260828_conversations_last_message_at_trigger.sql  (keeps
--     conversations.last_message_at accurate — this function reads it).
--
-- ---------------------------------------------------------------------
-- What changes vs Stage B
-- ---------------------------------------------------------------------
-- Session identity is now based purely on INACTIVITY SINCE THE LAST ACTUAL
-- MESSAGE (2 hours). Calendar date, "same business day", midnight, and
-- created_at play NO part in conversation identity.
--
--   A) open (active | waiting_human), last message < 2h ago
--      -> SAME conversation, returned untouched (Stage B Rule 1/2 kept).
--
--   B) open (active | waiting_human), last message >= 2h ago
--      -> close the old conversation (conversation_status='closed',
--         closed_at=now), record a 'closed' conversation_events row
--         (actor_user_id NULL, metadata.reason='inactivity_timeout'),
--         create a NEW 'active' conversation, return the new one.
--      -> a stale waiting_human is closed the same way; the new
--         conversation is 'active' and does NOT inherit waiting_human.
--
--   C) crossing midnight is irrelevant — only the 2h gap matters
--      (23:30 -> 00:15 = SAME; 23:30 -> 01:31 = NEW).
--
--   D) no open conversation but a prior CLOSED/solved one exists
--      -> ALWAYS create a NEW conversation. The resolver NEVER
--         auto-reopens a closed conversation. Manual Reopen stays a
--         separate explicit employee action
--         (apply_conversation_lifecycle_action 'reopen', unchanged).
--
--   E) REMOVED concepts: 'same_day_return', 'new_day_conversation',
--      'new_conversation_data_anomaly', 'customer_returned',
--      utc_plus_3_business_day() is no longer called (left in place,
--      unused — drop later if desired).
--
-- Welcome is still NOT decided here. Callers use `is_new_conversation`
-- (true) as the Welcome signal — see the n8n build spec. `is_new_contact`
-- / `is_new_channel_identity` are still returned (unchanged) but must no
-- longer drive Welcome.
--
-- Signature and RETURNS TABLE column set/order/names are BYTE-IDENTICAL to
-- Stage B — no caller (n8n `resolve_conversation_v2` / `prepare_conversation`)
-- needs a shape change. Only the *values* of `resolution` and `event_type`
-- change:
--   resolution : 'existing_open' | 'new_after_timeout' | 'new_after_closed' | 'first_conversation'
--   event_type : 'closed' when this call auto-closed a stale conversation, else null
--
-- ---------------------------------------------------------------------
-- Concurrency / security — unchanged from Stage B
-- ---------------------------------------------------------------------
-- Same per-(client, platform, sender) pg_advisory_xact_lock. Same
-- SECURITY INVOKER, service_role-only EXECUTE. The close-old + insert-new
-- pair runs inside the caller's transaction under that lock, so the
-- partial unique index conversations_one_open_per_channel_identity_idx is
-- never violated (old row leaves the index predicate as 'closed' before
-- the new 'active' row enters it). The unique_violation EXCEPTION blocks
-- are kept as unreachable-but-deterministic backstops.

begin;

-- ---------------------------------------------------------------------
-- Defensive: ensure conversation_events.conversation_state_id is nullable
-- (done by 20260825_conversation_lifecycle_v2.sql; harmless if already so)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'conversation_events'
      and column_name = 'conversation_state_id'
      and is_nullable = 'NO'
  ) then
    alter table public.conversation_events alter column conversation_state_id drop not null;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Redefine the resolver. DROP + CREATE (same pattern as
-- 20260825_conversation_lifecycle_v2.sql) so the identical RETURNS TABLE
-- is re-established cleanly. Nothing in the database depends on this
-- function (it is only ever called as a PostgREST RPC by n8n).
-- ---------------------------------------------------------------------
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
  resolution text,          -- 'existing_open' | 'new_after_timeout' | 'new_after_closed' | 'first_conversation'
  event_type text           -- 'closed' when this call auto-closed a stale conversation, else null
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
  -- 2. Conversation resolution — inactivity timeout (A / B / C / D / E)
  -- ---------------------------------------------------------------------
  select cv.* into v_open_conversation
    from public.conversations as cv
    where cv.channel_identity_id = v_channel_identity_id
      and cv.conversation_status in ('active', 'waiting_human')
    limit 1;

  if found then
    -- Inactivity is measured from the last ACTUAL persisted message
    -- (conversations.last_message_at, maintained by the messages trigger),
    -- falling back to started_at for a conversation that has no message
    -- row yet.
    v_last_activity := coalesce(v_open_conversation.last_message_at, v_open_conversation.started_at, v_now);

    if (v_now - v_last_activity) < c_inactivity_timeout then
      -- A / F(active): still inside the window -> SAME conversation,
      -- returned completely untouched. No write to this row at all --
      -- assigned_user_id/assigned_at/system_assigned_* are preserved
      -- exactly as they were, and a waiting_human conversation stays
      -- waiting_human (the human hard-stop downstream still applies).
      v_is_new_conversation := false;
      v_resolution := 'existing_open';
      v_event_type := null;
    else
      -- B / F(expired): inactive for >= 2h -> close the old, audit it,
      -- open a fresh 'active' conversation. A stale waiting_human is
      -- closed here too and the NEW conversation does NOT inherit it.
      v_prior_conversation_id := v_open_conversation.id;
      v_prior_status := v_open_conversation.conversation_status;

      update public.conversations as cv
        set conversation_status = 'closed',
            closed_at = v_now,
            current_step = null,
            updated_at = v_now
        where cv.id = v_prior_conversation_id;

      -- Lifecycle audit trail: system-driven close, no human actor.
      -- 'closed' is an existing allowed event_type
      -- (conversation_events_event_type_check). conversation_state_id is
      -- NULL (this resolver operates on public.conversations only; the
      -- column is nullable, re-asserted at the top of this migration).
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
          -- Lost the race on conversations_one_open_per_channel_identity_idx
          -- (unreachable under the advisory lock) -- adopt the winner.
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
    -- D: no OPEN conversation. There may be a prior CLOSED/solved one --
    -- the resolver NEVER auto-reopens it. Any later inbound message
    -- always starts a NEW conversation. Manual Reopen remains a separate
    -- explicit employee action (apply_conversation_lifecycle_action).
    select cv.* into v_latest_conversation
      from public.conversations as cv
      where cv.channel_identity_id = v_channel_identity_id
      order by cv.started_at desc
      limit 1;
    v_had_prior_conversation := found;

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
  'Unified Conversation Resolver (inactivity-timeout lifecycle). Session identity is based purely on time since the last actual persisted message: < 2h -> same open conversation (active or waiting_human), >= 2h -> close the old (record a system ''closed'' event, reason=inactivity_timeout) and open a new ''active'' one. A stale waiting_human is closed and NOT inherited. A closed conversation is NEVER auto-reopened -- any later inbound starts a new conversation; Manual Reopen stays a separate employee action. Calendar date / same-business-day / midnight play no part (removed: same_day_return, new_day_conversation, customer_returned). Does NOT write conversation_state or messages. Welcome is a downstream decision keyed on is_new_conversation. Same signature and RETURNS TABLE shape as Stage B. service_role EXECUTE only.';

revoke all on function public.resolve_conversation(uuid, text, text, text, timestamptz) from public;
revoke all on function public.resolve_conversation(uuid, text, text, text, timestamptz) from anon;
revoke all on function public.resolve_conversation(uuid, text, text, text, timestamptz) from authenticated;
grant execute on function public.resolve_conversation(uuid, text, text, text, timestamptz) to service_role;

commit;

-- ---------------------------------------------------------------------
-- Explicitly NOT done here
-- ---------------------------------------------------------------------
-- - conversation_state: not read, not written, not altered (n8n's legacy
--   upsert_conversation_state node still owns it until Stage C/D).
-- - messages: not touched.
-- - apply_conversation_lifecycle_action / Smart Assignment: unchanged.
-- - utc_plus_3_business_day(): left in place, now unused. Drop in a later
--   cleanup migration if desired.
-- - n8n workflows: not modified. `resolve_conversation_v2` calls this
--   function with the same 4 args and needs no change. `prepare_conversation`
--   MUST switch its should_send_welcome source from is_new_channel_identity
--   to is_new_conversation, and `needs_legacy_reset` MUST switch its
--   condition from the removed resolution strings to is_new_conversation ===
--   true -- see engineering/processes/n8n-ai-agent-build-spec.md.
-- - No SQL in this file was executed against Supabase.

-- ---------------------------------------------------------------------
-- Scheduled auto-close (NOT implemented — requirements only)
-- ---------------------------------------------------------------------
-- This resolver is a safety net: a stale conversation is closed on the
-- NEXT inbound message. To also close conversations that go stale and
-- NEVER receive another message, a scheduled job is required. There is no
-- scheduler in this project today (no pg_cron, no Supabase scheduled
-- Edge Function, no external cron). Required, when approved:
--
--   1. A SECURITY-scoped function, e.g.
--        public.close_stale_conversations(p_older_than interval default interval '2 hours',
--                                         p_limit int default 500)
--      that, for each public.conversations row with
--        conversation_status in ('active','waiting_human')
--        and coalesce(last_message_at, started_at) < now() - p_older_than
--      sets conversation_status='closed', closed_at=now(), current_step=null
--      and inserts a matching 'closed' conversation_events row
--      (actor_user_id NULL, metadata.reason='inactivity_timeout',
--      metadata.closed_by='scheduler'). Batched via p_limit + ORDER BY,
--      idempotent, service_role EXECUTE only.
--   2. A schedule that calls it every ~5-15 minutes: pg_cron
--      (`create extension pg_cron; select cron.schedule(...)`) is the
--      lowest-moving-parts option on Supabase; a Supabase Scheduled Edge
--      Function or an external cron hitting an authenticated endpoint also
--      work.
--   3. It must NOT send any customer message and must NOT touch
--      assigned_user_id / solved_by (those stay whatever they were).
-- Do NOT create or enable a live scheduler as part of this task.
