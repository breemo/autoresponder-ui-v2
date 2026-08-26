import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";
import { handleConversationsList } from "./_lib/conversationsList.js";
import { handleConversationLifecycle } from "./_lib/conversationLifecycle.js";
import { handleHumanReply } from "./_lib/humanReply.js";

// Conversation Card V1 — API consolidation Merge #1: this single domain
// endpoint replaces the former api/conversation-card.js (read-only
// lifecycle/context summary) and api/conversation-notes.js (internal notes
// CRUD). Behavior, response shapes, and every authorization/security check
// are preserved exactly from both -- only the file/URL/action names
// changed (Vercel Hobby plan's 12-Serverless-Function limit; see the
// Conversation Card V1 deployment-failure inspection report). Conversation
// Type/category is still deliberately absent -- out of scope for V1,
// deferred to the future Conversation Session Model redesign.
//
// API consolidation Merge #2 (Hobby Function-count fix, this pass): the
// former top-level api/conversations.js, api/conversation-lifecycle.js,
// and api/human-reply.js are now dispatched from here too — see
// api/_lib/conversationsList.js, api/_lib/conversationLifecycle.js, and
// api/_lib/humanReply.js. Each is dispatched BEFORE this file's own
// supabase-client creation and SUPABASE_SERVICE_ROLE_KEY guard below, so
// none of the three gains a new precondition it didn't have as its own
// top-level function — every one of them still creates its own supabase
// client and runs its own auth exactly as before. Only the routing/file
// layer and public URL changed; ClientMessages.jsx was updated to call
// this endpoint instead. api/smart-assign-conversation.js was deliberately
// NOT folded in here despite also being "conversation domain" — it is
// invoked by an external Supabase Database Webhook (not this app's
// frontend), configured outside this repo, with its own distinct
// shared-secret trust model; consolidating it would risk silently breaking
// a caller this repo cannot see or update. See the deployment-failure
// inspection report for the full rationale.
//
// Shape:
//   GET  /api/conversation?actor_user_id=&conversation_id=
//     -> lifecycle/context details + timeline (former conversation-card.js)
//   GET  /api/conversation?resource=notes&actor_user_id=&conversation_id=
//     -> list notes (former conversation-notes.js GET)
//   GET  /api/conversation?resource=list&actor_user_id=
//     -> conversation list (former top-level api/conversations.js)
//   POST /api/conversation
//     { action: "add_note" | "edit_note" | "delete_note", actor_user_id,
//       conversation_id?, note_id?, body? }
//     (former conversation-notes.js POST actions "add"/"edit"/"delete",
//     renamed to *_note so this file's action vocabulary stays unambiguous
//     as more actions are added to this domain endpoint later)
//   POST /api/conversation { action: "claim" | "close" | "reopen" | "takeover", ... }
//     -> former top-level api/conversation-lifecycle.js
//   POST /api/conversation { action: "human_reply", conversation_id, message, actor_user_id, ... }
//     -> former top-level api/human-reply.js
//
// "Last employee" and the timeline both read conversation_events, which
// only exists from Stage 7B onward -- any conversation whose lifecycle
// happened entirely before that migration has no matching rows, a known,
// documented limitation (see the design report), not a bug in this
// endpoint.
//
// Notes are internal only -- nothing in this file, or anywhere else in the
// app, ever forwards conversation_notes content to a customer-facing send
// path; enforcing that is simply a matter of no such path existing.
//
// Authorization (unchanged from both merged files): every branch requires
// an active client_users membership + INBOX permission, re-derived
// server-side via resolveActingMembership()/actorHasPermission() -- never
// trusted from the request. Note edit/delete are additionally author-only
// (author_user_id === the resolved actor's own user id) -- this app's
// authorization model has no existing concept of one member acting on
// content another member authored, so no broader override is invented
// here, same as before the merge.
//
// Tenant scope: every read/write is scoped to the actor's own client_id,
// re-derived server-side -- never trusted from the request body/query.
//
// service_role guard (unchanged from both merged files): conversation_events
// and conversation_notes both have RLS enabled with zero policies
// (service-role-only by default-deny -- see supabase/migrations/
// 20260820_conversation_lifecycle_tracking.sql). getSupabaseServerClient()
// silently falls back to the anon key if SUPABASE_SERVICE_ROLE_KEY isn't
// set. For a write that fallback does fail loudly (an RLS-violation error
// from Postgres), but for a GET a SELECT under zero-policy RLS succeeds
// with an empty result set rather than erroring -- silently rendering
// "no notes"/"no events" instead of surfacing the real misconfiguration.
// This is checked once, up front, for every method/action in this file.

const HUMAN_LAST_EMPLOYEE_EVENT_TYPES = ["accepted", "solved", "reopened"];
const TIMELINE_LIMIT = 10;

async function requireActor(req, res, supabase) {
  const actorUserId = req.method === "GET" ? req.query?.actor_user_id : req.body?.actor_user_id;

  const actor = await resolveActingMembership(supabase, actorUserId);
  if (!actor) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }
  if (actor.user.must_change_password) {
    res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
    return null;
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INBOX)) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return null;
  }

  return actor;
}

async function fetchUsersByIds(supabase, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const { data, error } = await supabase.from("users").select("id, name").in("id", uniqueIds);
  if (error) throw error;

  const map = new Map();
  for (const row of data || []) map.set(row.id, { id: row.id, name: row.name });
  return map;
}

function userRef(usersById, id) {
  if (!id) return null;
  return usersById.get(id) || { id, name: null };
}

// "Last employee who interacted with this conversation" — derived from
// the lifecycle event log, not from picking among
// assigned_user_id/solved_by/reopened_by (which cannot tell you which one
// happened most recently). system_assigned is deliberately excluded: it
// has actor_user_id = null (a system recommendation, not a human acting).
// Falls back to assigned_user_id only when no qualifying event exists at
// all (e.g. a conversation whose only lifecycle activity predates
// Stage 7B's event logging) -- flagged via `source` in the response so
// the frontend/caller can tell a real event-derived answer from this
// approximation.
async function resolveLastEmployee(supabase, clientId, conversationStateId, currentAssignedUserId, usersById) {
  const { data, error } = await supabase
    .from("conversation_events")
    .select("actor_user_id, event_type, created_at")
    .eq("client_id", clientId)
    .eq("conversation_state_id", conversationStateId)
    .in("event_type", HUMAN_LAST_EMPLOYEE_EVENT_TYPES)
    .not("actor_user_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;

  const latest = data?.[0];
  if (latest) {
    return {
      user: userRef(usersById, latest.actor_user_id),
      event_type: latest.event_type,
      at: latest.created_at,
      source: "event",
    };
  }

  if (currentAssignedUserId) {
    return {
      user: userRef(usersById, currentAssignedUserId),
      event_type: null,
      at: null,
      source: "fallback_assigned_user_id",
    };
  }

  return null;
}

function serializeNote(row) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    body: row.body,
    author_user_id: row.author_user_id,
    author: row.users ? { id: row.users.id, name: row.users.name } : { id: row.author_user_id, name: null },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Resolves the stable conversation_state_id for (client, conversation_id) --
// the same lookup shape claim-conversation.js/conversation-status.js use,
// scoped to the actor's own client_id.
async function resolveConversationStateId(supabase, clientId, conversationId) {
  const { data, error } = await supabase
    .from("conversation_state")
    .select("id")
    .eq("client_id", clientId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error) throw error;
  return data?.id || null;
}

// GET /api/conversation?actor_user_id=&conversation_id= — former
// api/conversation-card.js, unchanged.
async function handleGetCardDetails(req, res, supabase) {
  const actor = await requireActor(req, res, supabase);
  if (!actor) return;

  const conversationId = req.query?.conversation_id;
  if (!conversationId) {
    return res.status(400).json({ success: false, message: "conversation_id is required" });
  }

  const clientId = actor.membership.client_id;

  const { data: state, error: stateError } = await supabase
    .from("conversation_state")
    .select("id, conversation_id, conversation_status, updated_at, system_assigned_user_id, system_assigned_at, assigned_user_id, assigned_at, solved_by, solved_at, reopened_by, reopened_at")
    .eq("client_id", clientId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (stateError) {
    console.error("conversation: failed to load conversation_state:", stateError);
    return res.status(500).json({ success: false, message: "فشل تحميل بيانات المحادثة" });
  }
  if (!state) {
    return res.status(404).json({ success: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
  }

  try {
    // One batched users lookup for every id referenced anywhere in this
    // response (current-state actors + timeline actors/targets), instead
    // of one round trip per field/row.
    const preliminaryIds = [state.system_assigned_user_id, state.assigned_user_id, state.solved_by, state.reopened_by];

    const { data: timelineData, error: timelineError } = await supabase
      .from("conversation_events")
      .select("id, event_type, actor_user_id, target_user_id, created_at")
      .eq("client_id", clientId)
      .eq("conversation_state_id", state.id)
      .order("created_at", { ascending: false })
      .limit(TIMELINE_LIMIT);
    if (timelineError) throw timelineError;
    const timelineRaw = timelineData || [];

    const timelineIds = timelineRaw.flatMap((row) => [row.actor_user_id, row.target_user_id]);
    const usersById = await fetchUsersByIds(supabase, [...preliminaryIds, ...timelineIds]);

    const timeline = timelineRaw.map((row) => ({
      id: row.id,
      event_type: row.event_type,
      actor_user: userRef(usersById, row.actor_user_id),
      target_user: userRef(usersById, row.target_user_id),
      created_at: row.created_at,
    }));

    const lastEmployee = await resolveLastEmployee(supabase, clientId, state.id, state.assigned_user_id, usersById);

    return res.status(200).json({
      success: true,
      conversation: {
        conversation_state_id: state.id,
        conversation_id: state.conversation_id,
        conversation_status: state.conversation_status,
        updated_at: state.updated_at,
        system_assigned_user_id: state.system_assigned_user_id,
        system_assigned_at: state.system_assigned_at,
        system_assigned_user: userRef(usersById, state.system_assigned_user_id),
        assigned_user_id: state.assigned_user_id,
        assigned_at: state.assigned_at,
        assigned_user: userRef(usersById, state.assigned_user_id),
        solved_by: state.solved_by,
        solved_at: state.solved_at,
        solved_by_user: userRef(usersById, state.solved_by),
        reopened_by: state.reopened_by,
        reopened_at: state.reopened_at,
        reopened_by_user: userRef(usersById, state.reopened_by),
      },
      last_employee: lastEmployee,
      timeline,
    });
  } catch (error) {
    console.error("conversation: failed to load lifecycle detail:", error);
    return res.status(500).json({ success: false, message: "فشل تحميل بيانات المحادثة" });
  }
}

// GET /api/conversation?resource=notes&actor_user_id=&conversation_id= —
// former api/conversation-notes.js GET, unchanged.
async function handleListNotes(req, res, supabase) {
  const actor = await requireActor(req, res, supabase);
  if (!actor) return;

  const conversationId = req.query?.conversation_id;
  if (!conversationId) {
    return res.status(400).json({ success: false, message: "conversation_id is required" });
  }

  const { data, error } = await supabase
    .from("conversation_notes")
    .select("id, conversation_id, body, author_user_id, created_at, updated_at, users:author_user_id(id, name)")
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("conversation: failed to list notes:", error);
    return res.status(500).json({ success: false, message: "فشل تحميل الملاحظات" });
  }

  return res.status(200).json({ success: true, notes: (data || []).map(serializeNote), actor_user_id: actor.user.id });
}

// POST { action: "add_note", ... } — former api/conversation-notes.js
// POST action "add", unchanged.
async function handleAddNote(req, res, supabase) {
  const actor = await requireActor(req, res, supabase);
  if (!actor) return;

  const conversationId = req.body?.conversation_id;
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";

  if (!conversationId) {
    return res.status(400).json({ success: false, message: "conversation_id is required" });
  }
  if (!body) {
    return res.status(400).json({ success: false, message: "الملاحظة لا يمكن أن تكون فارغة" });
  }

  let conversationStateId;
  try {
    conversationStateId = await resolveConversationStateId(supabase, actor.membership.client_id, conversationId);
  } catch (error) {
    console.error("conversation: failed to resolve conversation_state:", error);
    return res.status(500).json({ success: false, message: "فشل إضافة الملاحظة" });
  }
  if (!conversationStateId) {
    return res.status(404).json({ success: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
  }

  const { data, error } = await supabase
    .from("conversation_notes")
    .insert({
      client_id: actor.membership.client_id,
      conversation_state_id: conversationStateId,
      conversation_id: conversationId,
      author_user_id: actor.user.id,
      body,
    })
    .select("id, conversation_id, body, author_user_id, created_at, updated_at, users:author_user_id(id, name)")
    .single();

  if (error) {
    console.error("conversation: failed to add note:", error);
    return res.status(500).json({ success: false, message: "فشل إضافة الملاحظة" });
  }

  return res.status(200).json({ success: true, note: serializeNote(data) });
}

// POST { action: "edit_note" | "delete_note", ... } — former
// api/conversation-notes.js POST actions "edit"/"delete", unchanged
// (author-only, tenant-scoped).
async function handleEditOrDeleteNote(req, res, supabase, action) {
  const actor = await requireActor(req, res, supabase);
  if (!actor) return;

  const noteId = req.body?.note_id;
  if (!noteId) {
    return res.status(400).json({ success: false, message: "note_id is required" });
  }

  // Author-only, scoped to the actor's own client_id -- see the module
  // comment: no owner/broader override exists in this app's model.
  const { data: existing, error: existingError } = await supabase
    .from("conversation_notes")
    .select("id, client_id, author_user_id")
    .eq("id", noteId)
    .maybeSingle();

  if (existingError) {
    console.error("conversation: failed to load note:", existingError);
    return res.status(500).json({ success: false, message: "فشل تنفيذ العملية" });
  }
  if (!existing || existing.client_id !== actor.membership.client_id) {
    return res.status(404).json({ success: false, message: "الملاحظة غير موجودة" });
  }
  if (existing.author_user_id !== actor.user.id) {
    return res.status(403).json({ success: false, message: "يمكنك فقط تعديل أو حذف ملاحظاتك الخاصة" });
  }

  if (action === "delete_note") {
    const { error } = await supabase.from("conversation_notes").delete().eq("id", noteId);
    if (error) {
      console.error("conversation: failed to delete note:", error);
      return res.status(500).json({ success: false, message: "فشل حذف الملاحظة" });
    }
    return res.status(200).json({ success: true, deleted_id: noteId });
  }

  // action === "edit_note"
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) {
    return res.status(400).json({ success: false, message: "الملاحظة لا يمكن أن تكون فارغة" });
  }

  const { data, error } = await supabase
    .from("conversation_notes")
    .update({ body, updated_at: new Date().toISOString() })
    .eq("id", noteId)
    .select("id, conversation_id, body, author_user_id, created_at, updated_at, users:author_user_id(id, name)")
    .single();

  if (error) {
    console.error("conversation: failed to edit note:", error);
    return res.status(500).json({ success: false, message: "فشل تعديل الملاحظة" });
  }

  return res.status(200).json({ success: true, note: serializeNote(data) });
}

const LIFECYCLE_ACTIONS = new Set(["claim", "close", "reopen", "takeover"]);

// Pure, synchronous routing decision — extracted from handler() below so
// it's unit-testable (api/_lib/__tests__/conversationRouting.test.js)
// without needing a real Supabase client. Every request that doesn't
// match one of the delegated sub-domains routes to "self" — this file's
// own pre-existing card/notes logic — exactly as before this merge.
export function resolveConversationRoute(req) {
  if (req.method === "GET" && req.query?.resource === "list") return "list";
  if (req.method === "POST" && LIFECYCLE_ACTIONS.has(req.body?.action)) return "lifecycle";
  if (req.method === "POST" && req.body?.action === "human_reply") return "human_reply";
  return "self";
}

export default async function handler(req, res) {
  // Delegated sub-domains (Merge #2) — dispatched first, before this
  // file's own supabase client / service-role guard below, so each keeps
  // exactly the preconditions it had as its own top-level function. See
  // the module comment above.
  const route = resolveConversationRoute(req);
  if (route === "list") return handleConversationsList(req, res);
  if (route === "lifecycle") return handleConversationLifecycle(req, res);
  if (route === "human_reply") return handleHumanReply(req, res);

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  // service_role guard — see the module comment above. Checked once, up
  // front, for every method/action in this file (conversation_events and
  // conversation_notes both need it).
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("conversation: SUPABASE_SERVICE_ROLE_KEY is not set -- refusing to serve conversation_events/conversation_notes (the anon-key fallback would silently return empty results on GET under RLS, not an error).");
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") {
    if (req.query?.resource === "notes") {
      return handleListNotes(req, res, supabase);
    }
    return handleGetCardDetails(req, res, supabase);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const action = req.body?.action;

  if (action === "add_note") {
    return handleAddNote(req, res, supabase);
  }
  if (action === "edit_note" || action === "delete_note") {
    return handleEditOrDeleteNote(req, res, supabase, action);
  }

  return res.status(400).json({ success: false, message: "Unknown action" });
}
