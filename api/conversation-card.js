import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

// Conversation Card V1 — read-only lifecycle/context summary for one
// conversation, shown beside the chat in ClientMessages.jsx. GET-only,
// same actor_user_id-in-query-string + server-side re-derived
// client_id/role/permission pattern already established by
// api/client-users.js's GET branch. Conversation Type/category is
// deliberately NOT part of this response — out of scope for V1, deferred
// to the future Conversation Session Model redesign (see the design
// report). This endpoint performs zero writes.
//
// "Last employee" (see resolveLastEmployee below) and the timeline both
// read conversation_events, which only exists from Stage 7B onward — any
// conversation whose lifecycle happened entirely before that migration
// has no matching rows, a known, documented limitation (see the design
// report), not a bug in this endpoint.

const HUMAN_LAST_EMPLOYEE_EVENT_TYPES = ["accepted", "solved", "reopened"];
const TIMELINE_LIMIT = 10;

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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  // conversation_events has RLS enabled with zero policies -- reachable
  // only by service_role (see supabase/migrations/20260820_conversation_
  // lifecycle_tracking.sql). getSupabaseServerClient() silently falls back
  // to the anon key if SUPABASE_SERVICE_ROLE_KEY isn't set (see that
  // file's own console.warn) -- harmless for tables this app already used
  // before RLS existed, but NOT for this one: a SELECT under zero-policy
  // RLS succeeds with an empty result set rather than erroring, which
  // would silently render this card's timeline/last-employee as "nothing
  // happened" instead of surfacing the real misconfiguration. Fail fast
  // here instead, loudly, rather than let that happen.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("conversation-card: SUPABASE_SERVICE_ROLE_KEY is not set -- refusing to serve conversation_events (the anon-key fallback would silently return empty results under RLS, not an error).");
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await resolveActingMembership(supabase, req.query?.actor_user_id);
  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INBOX)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

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
    console.error("conversation-card: failed to load conversation_state:", stateError);
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
    console.error("conversation-card: failed to load lifecycle detail:", error);
    return res.status(500).json({ success: false, message: "فشل تحميل بيانات المحادثة" });
  }
}
