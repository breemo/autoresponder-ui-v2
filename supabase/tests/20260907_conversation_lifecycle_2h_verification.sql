-- ===========================================================================
-- Manual verification harness for the 2-hour conversation lifecycle.
-- ===========================================================================
-- Covers Stage 2 of the Auto Responder stabilization:
--   supabase/migrations/20260907_conversation_resolver_reopen_within_window.sql
--   supabase/migrations/20260907_manual_reopen_2h_window.sql
--
-- NOT a migration. Nothing here persists: the whole script runs inside a
-- transaction that is ROLLED BACK at the end (and any failed assertion
-- raises, which also rolls back). Safe to run on STAGING (strongly
-- preferred) after applying both migrations above. Running on production
-- is technically safe (rollback) but discouraged — it briefly holds the
-- per-(client,platform,sender) advisory lock for the synthetic test
-- sender ids only.
--
-- HOW TO RUN (Supabase SQL Editor or psql):
--   1. Edit the two ids in the `_cfg` INSERT below:
--        - client_id     : any real public.clients.id
--        - actor_user_id  : any real user id that belongs to that client
--   2. Run the entire file.
--   3. Success  -> final row/notice: "ALL 13 LIFECYCLE CHECKS PASSED".
--      Failure  -> an exception "Cn FAIL: ..." and the transaction rolls back.
-- ===========================================================================

begin;

create temporary table _cfg on commit drop as
select
  '00000000-0000-0000-0000-000000000000'::uuid as client_id,      -- <-- EDIT
  '00000000-0000-0000-0000-000000000000'::uuid as actor_user_id;  -- <-- EDIT

do $$
declare
  v_client   uuid;
  v_actor    uuid;
  v_now      timestamptz := now();
  v_page     text := 'PAGE_TEST_' || substr(md5(random()::text), 1, 8);

  v_sender   text;
  v_r        record;   -- resolve_conversation result
  v_r2       record;
  v_a        record;   -- apply_conversation_lifecycle_action result
  v_conv     uuid;
  v_conv_b   uuid;
  v_contact  uuid;
  v_identity uuid;
  v_identity2 uuid;
  v_conv_a2  uuid;
  v_status   text;
  v_closed   timestamptz;
  v_assigned uuid;
  v_sysasg   uuid;
  v_step     text;
  v_solved   uuid;
  v_midnight timestamptz;
begin
  select client_id, actor_user_id into v_client, v_actor from _cfg;
  if v_client = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'Edit the _cfg INSERT: set a real client_id / actor_user_id first';
  end if;

  -- =====================================================================
  -- C1: OPEN active, last message < 2h  -> SAME conversation, untouched
  -- =====================================================================
  v_sender := 'llt1_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations set last_message_at = v_now - interval '30 minutes' where id = v_conv;

  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if v_r2.conversation_id <> v_conv then raise exception 'C1 FAIL: expected same conversation'; end if;
  if v_r2.is_new_conversation then raise exception 'C1 FAIL: is_new_conversation must be false'; end if;
  if v_r2.resolution <> 'existing_open' then raise exception 'C1 FAIL: resolution=% (want existing_open)', v_r2.resolution; end if;
  raise notice 'C1 PASS  active <2h -> same conversation';

  -- =====================================================================
  -- C2: OPEN active, last message >= 2h  -> NEW active, old auto-closed
  -- =====================================================================
  v_sender := 'llt2_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations set last_message_at = v_now - interval '3 hours' where id = v_conv;

  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if v_r2.conversation_id = v_conv then raise exception 'C2 FAIL: expected a NEW conversation'; end if;
  if not v_r2.is_new_conversation then raise exception 'C2 FAIL: is_new_conversation must be true'; end if;
  if v_r2.resolution <> 'new_after_timeout' then raise exception 'C2 FAIL: resolution=% (want new_after_timeout)', v_r2.resolution; end if;
  if v_r2.event_type <> 'closed' then raise exception 'C2 FAIL: event_type=% (want closed)', v_r2.event_type; end if;
  select conversation_status into v_status from public.conversations where id = v_conv;
  if v_status <> 'closed' then raise exception 'C2 FAIL: old conversation status=% (want closed)', v_status; end if;
  if not exists (
    select 1 from public.conversation_events
    where conversation_id = v_conv and event_type = 'closed'
      and metadata->>'reason' = 'inactivity_timeout'
  ) then raise exception 'C2 FAIL: missing inactivity_timeout closed event'; end if;
  raise notice 'C2 PASS  active >=2h -> new conversation, old auto-closed + audited';

  -- =====================================================================
  -- C3: OPEN waiting_human, last message < 2h -> SAME + hard stop kept
  -- =====================================================================
  v_sender := 'llt3_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations
    set conversation_status = 'waiting_human',
        assigned_user_id = v_actor, assigned_at = v_now - interval '20 minutes',
        last_message_at = v_now - interval '25 minutes'
    where id = v_conv;

  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if v_r2.conversation_id <> v_conv then raise exception 'C3 FAIL: expected same conversation'; end if;
  if v_r2.conversation_status <> 'waiting_human' then raise exception 'C3 FAIL: status=% (want waiting_human -> downstream hard stop)', v_r2.conversation_status; end if;
  select assigned_user_id into v_assigned from public.conversations where id = v_conv;
  if v_assigned is distinct from v_actor then raise exception 'C3 FAIL: assignment was disturbed'; end if;
  raise notice 'C3 PASS  waiting_human <2h -> same conversation, ownership + hard stop intact';

  -- =====================================================================
  -- C4: OPEN waiting_human, last message >= 2h -> NEW active, no ownership
  -- =====================================================================
  v_sender := 'llt4_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations
    set conversation_status = 'waiting_human',
        assigned_user_id = v_actor, assigned_at = v_now - interval '4 hours',
        system_assigned_user_id = v_actor, system_assigned_at = v_now - interval '4 hours',
        last_message_at = v_now - interval '3 hours'
    where id = v_conv;

  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if v_r2.conversation_id = v_conv then raise exception 'C4 FAIL: expected a NEW conversation'; end if;
  if v_r2.conversation_status <> 'active' then raise exception 'C4 FAIL: new status=% (want active)', v_r2.conversation_status; end if;
  select assigned_user_id, system_assigned_user_id into v_assigned, v_sysasg from public.conversations where id = v_r2.conversation_id;
  if v_assigned is not null or v_sysasg is not null then raise exception 'C4 FAIL: stale waiting_human ownership carried into the new conversation'; end if;
  raise notice 'C4 PASS  waiting_human >=2h -> new active conversation, no carried ownership';

  -- =====================================================================
  -- C5: CLOSED < 2h ago, customer inbound -> SAME conversation AUTO-REOPENED
  --      (also covers: clears old human assignment; is_new_conversation=false)
  -- =====================================================================
  v_sender := 'llt5_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations
    set conversation_status = 'closed',
        closed_at = v_now - interval '30 minutes',
        current_step = 'done',
        solved_by = v_actor, solved_at = v_now - interval '30 minutes',
        assigned_user_id = v_actor, assigned_at = v_now - interval '40 minutes',
        system_assigned_user_id = v_actor, system_assigned_at = v_now - interval '40 minutes',
        last_message_at = v_now - interval '35 minutes'
    where id = v_conv;

  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if v_r2.conversation_id <> v_conv then raise exception 'C5 FAIL: expected the SAME conversation auto-reopened, got a new one'; end if;
  if v_r2.is_new_conversation then raise exception 'C5 FAIL: is_new_conversation must be false (no Welcome)'; end if;
  if v_r2.conversation_status <> 'active' then raise exception 'C5 FAIL: status=% (want active, NOT waiting_human)', v_r2.conversation_status; end if;
  if v_r2.resolution <> 'reopened_after_close' then raise exception 'C5 FAIL: resolution=% (want reopened_after_close)', v_r2.resolution; end if;
  if v_r2.event_type <> 'reopened' then raise exception 'C5 FAIL: event_type=% (want reopened)', v_r2.event_type; end if;

  select closed_at, current_step, assigned_user_id, system_assigned_user_id, solved_by
    into v_closed, v_step, v_assigned, v_sysasg, v_solved
    from public.conversations where id = v_conv;
  if v_closed is not null then raise exception 'C5 FAIL: closed_at was not cleared'; end if;
  if v_step is not null then raise exception 'C5 FAIL: current_step was not cleared'; end if;
  if v_assigned is not null then raise exception 'C5 FAIL: assigned_user_id was not cleared (still claimed by previous employee)'; end if;
  if v_sysasg is not null then raise exception 'C5 FAIL: system_assigned_user_id was not cleared'; end if;
  if v_solved is distinct from v_actor then raise exception 'C5 FAIL: solved_by history was destroyed (must be preserved)'; end if;
  if not exists (
    select 1 from public.conversation_events
    where conversation_id = v_conv and event_type = 'reopened' and actor_user_id is null
      and metadata->>'reason' = 'customer_returned_within_window'
  ) then raise exception 'C5 FAIL: missing automatic reopened event'; end if;
  raise notice 'C5 PASS  closed <2h -> SAME conversation auto-reopened active, ownership cleared, history kept';

  -- =====================================================================
  -- C6: CLOSED >= 2h ago, customer inbound -> NEW conversation
  -- =====================================================================
  v_sender := 'llt6_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations
    set conversation_status = 'closed',
        closed_at = v_now - interval '3 hours',
        current_step = 'done',
        last_message_at = v_now - interval '3 hours 10 minutes'
    where id = v_conv;

  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if v_r2.conversation_id = v_conv then raise exception 'C6 FAIL: expected a NEW conversation'; end if;
  if not v_r2.is_new_conversation then raise exception 'C6 FAIL: is_new_conversation must be true'; end if;
  if v_r2.resolution <> 'new_after_closed' then raise exception 'C6 FAIL: resolution=% (want new_after_closed)', v_r2.resolution; end if;
  select conversation_status into v_status from public.conversations where id = v_conv;
  if v_status <> 'closed' then raise exception 'C6 FAIL: old conversation must stay closed/historical'; end if;
  raise notice 'C6 PASS  closed >=2h -> new conversation, old stays historical';

  -- =====================================================================
  -- C7: CLOSED < 2h ago BUT crossing midnight -> still SAME (auto-reopen)
  --      (business-day / midnight boundary must have NO effect)
  -- =====================================================================
  v_sender := 'llt7_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  v_midnight := date_trunc('day', v_now);  -- 00:00 (server tz) of today
  update public.conversations
    set conversation_status = 'closed',
        closed_at = v_midnight - interval '20 minutes',      -- 23:40 "yesterday"
        last_message_at = v_midnight - interval '25 minutes'
    where id = v_conv;

  -- p_now = 00:15 "today": 35 min after close, on the far side of midnight.
  select * into v_r2 from public.resolve_conversation(
    v_client, 'facebook', v_sender, v_page, v_midnight + interval '15 minutes'
  );
  if v_r2.conversation_id <> v_conv then raise exception 'C7 FAIL: midnight crossing split the conversation (must not)'; end if;
  if v_r2.resolution <> 'reopened_after_close' then raise exception 'C7 FAIL: resolution=% (want reopened_after_close across midnight)', v_r2.resolution; end if;
  raise notice 'C7 PASS  closed <2h across midnight -> SAME conversation (boundary ignored)';

  -- =====================================================================
  -- C8: MANUAL reopen < 2h -> waiting_human, assigned to the acting employee
  -- =====================================================================
  v_sender := 'llt8_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations
    set conversation_status = 'closed', closed_at = v_now - interval '30 minutes', current_step = 'done'
    where id = v_conv;

  select * into v_a from public.apply_conversation_lifecycle_action(v_client, v_conv, v_actor, 'reopen');
  if v_a.outcome <> 'ok' then raise exception 'C8 FAIL: outcome=% (want ok)', v_a.outcome; end if;
  if v_a.conversation_status <> 'waiting_human' then raise exception 'C8 FAIL: status=% (want waiting_human)', v_a.conversation_status; end if;
  if v_a.assigned_user_id is distinct from v_actor then raise exception 'C8 FAIL: not assigned to the acting employee'; end if;
  if v_a.system_assigned_user_id is distinct from v_actor then raise exception 'C8 FAIL: system_assigned_user_id not aligned with the acting employee'; end if;
  select closed_at into v_closed from public.conversations where id = v_conv;
  if v_closed is not null then raise exception 'C8 FAIL: closed_at not cleared on manual reopen'; end if;
  raise notice 'C8 PASS  manual reopen <2h -> waiting_human, owned by actor';

  -- =====================================================================
  -- C9: MANUAL reopen >= 2h -> 'expired', conversation untouched
  -- =====================================================================
  v_sender := 'llt9_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations
    set conversation_status = 'closed', closed_at = v_now - interval '3 hours', current_step = 'done'
    where id = v_conv;

  select * into v_a from public.apply_conversation_lifecycle_action(v_client, v_conv, v_actor, 'reopen');
  if v_a.outcome <> 'expired' then raise exception 'C9 FAIL: outcome=% (want expired)', v_a.outcome; end if;
  select conversation_status, closed_at into v_status, v_closed from public.conversations where id = v_conv;
  if v_status <> 'closed' or v_closed is null then raise exception 'C9 FAIL: expired reopen must not mutate the conversation'; end if;
  raise notice 'C9 PASS  manual reopen >=2h -> expired (non-success), no mutation';

  -- =====================================================================
  -- C10: MANUAL reopen when another OPEN conversation exists for the same
  --       channel_identity_id -> 'conflict', NO 23505, nothing mutated
  -- =====================================================================
  v_sender := 'llt10_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv    := v_r.conversation_id;
  v_contact := v_r.contact_id;
  v_identity := v_r.channel_identity_id;
  update public.conversations
    set conversation_status = 'closed', closed_at = v_now - interval '10 minutes', current_step = 'done'
    where id = v_conv;
  insert into public.conversations (client_id, contact_id, channel_identity_id, platform, conversation_status, started_at, created_at, updated_at)
    values (v_client, v_contact, v_identity, 'facebook', 'active', v_now, v_now, v_now)
    returning id into v_conv_b;

  select * into v_a from public.apply_conversation_lifecycle_action(v_client, v_conv, v_actor, 'reopen');
  if v_a.outcome <> 'conflict' then raise exception 'C10 FAIL: outcome=% (want conflict, and definitely not a raised 23505)', v_a.outcome; end if;
  select conversation_status into v_status from public.conversations where id = v_conv;
  if v_status <> 'closed' then raise exception 'C10 FAIL: conflicted reopen mutated the closed conversation'; end if;
  select conversation_status into v_status from public.conversations where id = v_conv_b;
  if v_status <> 'active' then raise exception 'C10 FAIL: the other open conversation was disturbed'; end if;
  raise notice 'C10 PASS  manual reopen with another open conversation -> controlled conflict, no 23505';

  -- =====================================================================
  -- C11: multi-account identity isolation (same sender, two channel_keys)
  -- =====================================================================
  v_sender := 'llt11_' || substr(md5(random()::text), 1, 10);
  select * into v_r  from public.resolve_conversation(v_client, 'facebook', v_sender, 'PAGE_A_' || substr(md5(random()::text),1,6), v_now);
  v_identity  := v_r.channel_identity_id;
  v_conv      := v_r.conversation_id;
  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, 'PAGE_B_' || substr(md5(random()::text),1,6), v_now);
  v_identity2 := v_r2.channel_identity_id;
  v_conv_a2   := v_r2.conversation_id;

  if v_identity = v_identity2 then raise exception 'C11 FAIL: two channel_keys collapsed to one identity'; end if;
  if v_conv = v_conv_a2 then raise exception 'C11 FAIL: two identities share one conversation'; end if;

  -- close + auto-reopen identity #1; identity #2 must be untouched
  update public.conversations set conversation_status = 'closed', closed_at = v_now - interval '15 minutes' where id = v_conv;
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, (select channel_key from public.contact_channel_identities where id = v_identity), v_now);
  if v_r.conversation_id <> v_conv then raise exception 'C11 FAIL: identity #1 did not auto-reopen its own conversation'; end if;
  select conversation_status into v_status from public.conversations where id = v_conv_a2;
  if v_status <> 'active' then raise exception 'C11 FAIL: identity #2 conversation was disturbed by identity #1 activity'; end if;
  raise notice 'C11 PASS  multi-account identity isolation intact';

  -- =====================================================================
  -- C12: auto-reopen does NOT set is_new_conversation (Welcome signal)
  --       — explicit restatement of the C5 assertion for the checklist
  -- =====================================================================
  v_sender := 'llt12_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  v_conv := v_r.conversation_id;
  update public.conversations set conversation_status = 'closed', closed_at = v_now - interval '5 minutes' where id = v_conv;
  select * into v_r2 from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if v_r2.is_new_conversation then raise exception 'C12 FAIL: auto-reopen set is_new_conversation=true -> would fire Welcome'; end if;
  if v_r2.conversation_id <> v_conv then raise exception 'C12 FAIL: auto-reopen created a new conversation'; end if;
  raise notice 'C12 PASS  auto-reopen keeps is_new_conversation=false (no Welcome / no legacy-reset branch)';

  -- =====================================================================
  -- C13: first-ever inbound is unaffected (regression guard)
  -- =====================================================================
  v_sender := 'llt13_' || substr(md5(random()::text), 1, 10);
  select * into v_r from public.resolve_conversation(v_client, 'facebook', v_sender, v_page, v_now);
  if not v_r.is_new_conversation then raise exception 'C13 FAIL: first inbound must be a new conversation'; end if;
  if v_r.resolution <> 'first_conversation' then raise exception 'C13 FAIL: resolution=% (want first_conversation)', v_r.resolution; end if;
  if v_r.conversation_status <> 'active' then raise exception 'C13 FAIL: first conversation status=% (want active)', v_r.conversation_status; end if;
  raise notice 'C13 PASS  first-ever inbound -> new active conversation (unchanged)';

  raise notice '=====================================================';
  raise notice 'ALL 13 LIFECYCLE CHECKS PASSED';
  raise notice '=====================================================';
end $$;

rollback;
