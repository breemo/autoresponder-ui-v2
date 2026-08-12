-- PREPARED, NOT REQUIRED YET — do not run until n8n is updated to populate
-- this column (see the "Human takeover readiness" section of the
-- implementation report for the exact n8n change needed).
--
-- Purpose: today, `messages.reply_source` already distinguishes ai / auto /
-- system / quick_reply / human outbound messages (reused as-is, no
-- duplicate column added here). What's still missing is WHICH application
-- user sent a given human-originated reply when it came from the Jawab AI
-- Inbox. api/human-reply.js now forwards `sent_by_user_id` (the resolved
-- actor's users.id) to the n8n webhook on every send — see that file — but
-- there is nowhere for n8n to persist it until this column exists.
--
-- This column intentionally has NO foreign-key constraint: users.id's
-- exact column type could not be confirmed from this repository (no
-- migration in this repo defines the `users` table), and guessing wrong
-- would make this migration fail outright. Add an explicit
-- `references public.users(id)` constraint yourself once you've confirmed
-- the matching type, if you want referential integrity enforced.
--
-- Only ever set for reply_source = 'human' rows; left null for
-- AI/auto/system/quick_reply outbound messages and for all inbound
-- messages. A reply sent directly from the connected channel (e.g.
-- replying from WhatsApp itself, not through the Inbox) has no
-- application user to attribute — this column stays null for that case,
-- which is expected, not a bug.

alter table public.messages
  add column if not exists sent_by_user_id bigint null;
