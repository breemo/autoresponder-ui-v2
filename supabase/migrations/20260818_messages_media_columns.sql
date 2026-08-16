-- WhatsApp Media & Attachment Support v1 — foundation only.
--
-- Adds media metadata columns to public.messages so the application can
-- eventually represent image/audio/document messages, in addition to the
-- plain text messages this table already stores. This migration is
-- intentionally additive and backward-compatible:
--
--   - message_type defaults to 'text', so every EXISTING row (and every
--     row inserted by the current, unmodified n8n workflow, which has no
--     idea this column exists yet) continues to read back as a text
--     message with zero behavior change.
--   - The four media_* columns are nullable and simply stay null for
--     every text message, exactly like sent_by_user_id
--     (20260815_messages_sent_by_user_id.sql) and assigned_user_id/
--     assigned_at (20260816_conversation_state_assignment.sql) before it.
--
-- media_path deliberately stores a Supabase Storage OBJECT PATH, not a
-- URL — Storage does not exist yet (no bucket, no policies; see the
-- "WhatsApp Media & Attachment Support v1" architecture review). No code
-- in this repository writes to this column yet. It is added now purely so
-- the eventual Storage + n8n Evolution integration has a stable column to
-- target without another schema change, and so the application's
-- renderer/composer foundation (already added in this same pass) has a
-- real shape to code against.
--
-- message_type's CHECK constraint mirrors this repo's existing pattern for
-- small controlled-vocabulary text columns (see
-- clients.default_language / client_users.language in
-- 20260817_client_and_user_language_preference.sql) rather than a
-- Postgres enum — consistent with every other status-like column on this
-- table (direction, reply_source) already being plain text, not an enum.
--
-- n8n impact: none today. The current n8n workflow only ever inserts rows
-- without a message_type value, which the column default absorbs as
-- 'text' — this is the same "columns absent from a request body are left
-- untouched / defaulted" behavior already relied on elsewhere in this
-- repo's migrations. No existing n8n behavior needs to change for this
-- migration to be safely applied.
--
-- Run this manually against the Supabase project (SQL editor or your
-- migration tooling) — it is not executed automatically by this repo, and
-- was NOT run as part of this change (implementation pass only, per
-- explicit instruction not to run it against live Supabase).

begin;

alter table public.messages
  add column if not exists message_type text not null default 'text',
  add column if not exists media_path text null,
  add column if not exists media_mime_type text null,
  add column if not exists media_file_name text null,
  add column if not exists media_size_bytes bigint null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'messages_message_type_check'
  ) then
    alter table public.messages
      add constraint messages_message_type_check
      check (message_type in ('text', 'image', 'audio', 'document'));
  end if;
end $$;

commit;
