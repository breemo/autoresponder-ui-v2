-- Conversation Lifecycle — DB-side maintenance of conversations.last_message_at.
--
-- Run this manually against the Supabase project (SQL editor / your own
-- tooling) — it is NOT executed automatically by this repo, and was NOT
-- run as part of this change.
--
-- Apply AFTER 20260823_conversation_model_redesign_stage_a.sql (creates
-- public.conversations with the last_message_at column). No ordering
-- dependency on the AI-engine migrations. Apply BEFORE (or together with)
-- 20260828_conversation_resolver_inactivity_timeout.sql, which relies on
-- last_message_at being accurate.
--
-- ---------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------
-- The 2-hour inactivity timeout in the redesigned resolve_conversation()
-- (see the companion migration) measures "time since the last ACTUAL
-- conversational message". Today conversations.last_message_at is written
-- ONLY by the late n8n node `sync_conversation_v2`, at the very end of a
-- reply run. That is unsafe as the single source of truth:
--   - it is skipped entirely if the n8n run errors before reaching it,
--   - the "Human Reply" workflow (employee replies from the Inbox) has
--     its own outbound-insert path and does not necessarily bump it,
--   - it fires once per run, not once per message.
--
-- The safest mechanism consistent with the current architecture is a
-- database trigger on public.messages: EVERY persisted inbound/outbound
-- message row — from any code path (n8n auto, n8n AI, human reply, media,
-- future callers) — updates the owning conversation's last_message_at
-- atomically, in the same transaction as the message insert. Internal
-- lifecycle events (assignment, claim, status change, notes) do NOT
-- insert into public.messages, so they correctly do NOT extend the
-- inactivity window.
--
-- ---------------------------------------------------------------------
-- Scope / safety
-- ---------------------------------------------------------------------
-- - Reads only NEW.conversation_id, NEW.client_id, NEW.created_at on
--   public.messages — all three are populated by every current writer
--   (n8n `insert message` / `insert auto reply`, api/human-reply.js via
--   n8n). The trigger is null-safe: a row with no conversation_id (legacy
--   / non-V2) simply updates zero rows.
-- - AFTER INSERT, FOR EACH ROW. Never blocks or rewrites the message.
-- - Never moves last_message_at backwards (greatest(...)) so an
--   out-of-order media-status insert can't rewind the window.
-- - Scoped by BOTH id AND client_id — a message can only ever bump its
--   own tenant's conversation row.
-- - public.conversations has no matching row for a legacy conversation_id
--   → the UPDATE is a harmless no-op.

begin;

create or replace function public.messages_bump_conversation_last_message_at()
returns trigger
language plpgsql
as $$
begin
  if new.conversation_id is not null then
    update public.conversations as c
      set last_message_at = greatest(
            coalesce(c.last_message_at, 'epoch'::timestamptz),
            coalesce(new.created_at, now())
          ),
          updated_at = now()
      where c.id = new.conversation_id
        and c.client_id = new.client_id;
  end if;
  return null; -- AFTER trigger; return value ignored
end;
$$;

comment on function public.messages_bump_conversation_last_message_at() is
  'AFTER INSERT trigger on public.messages: bumps conversations.last_message_at to the new message''s timestamp (never backwards), scoped by id+client_id. This is the authoritative maintenance path for last_message_at, feeding resolve_conversation()''s 2-hour inactivity timeout. Internal lifecycle events do not insert into public.messages and therefore do not extend the window.';

drop trigger if exists messages_bump_conversation_last_message_at_trg on public.messages;
create trigger messages_bump_conversation_last_message_at_trg
  after insert on public.messages
  for each row
  execute function public.messages_bump_conversation_last_message_at();

commit;

-- ---------------------------------------------------------------------
-- Optional one-time backfill (review before running — NOT part of the
-- automatic migration body above)
-- ---------------------------------------------------------------------
-- Existing conversations whose last_message_at was never written (or is
-- stale relative to their real message history) can be corrected with:
--
--   update public.conversations c
--     set last_message_at = m.max_created,
--         updated_at = now()
--   from (
--     select conversation_id, max(created_at) as max_created
--       from public.messages
--      where conversation_id is not null
--      group by conversation_id
--   ) m
--   where m.conversation_id = c.id
--     and (c.last_message_at is null or c.last_message_at < m.max_created);
--
-- Run once, manually, only if you want historical accuracy before the new
-- resolver goes live. Not required for correctness going forward.

-- ---------------------------------------------------------------------
-- n8n note (no live n8n change made here)
-- ---------------------------------------------------------------------
-- `sync_conversation_v2`'s own `last_message_at: $now` write becomes
-- redundant once this trigger is live (the trigger already set it from
-- the message insert earlier in the same run). It is harmless to leave
-- in place — greatest(...) means the later n8n write of the same instant
-- is a no-op. It can be removed from the workflow later as cleanup.
