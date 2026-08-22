import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

// API consolidation: this single domain endpoint replaces the former
// api/claim-conversation.js ("claim" action) and api/conversation-status.js
// ("close"/"reopen"/"takeover" actions). Behavior, validation order,
// response shapes, RPC usage, and every authorization/security check are
// preserved exactly from both -- each action is still handled by its own
// self-contained function (own field validation -> own
// getSupabaseServerClient() call -> own actor resolution -> own business
// logic, in the same order as the original file), only the routing/file
// layer is new. Only "claim" is special-cased at the top level; everything
// else (including an unrecognized action) is routed to
// handleStatusChange(), which performs the exact same conversation_id-then-
// action-vocabulary validation order api/conversation-status.js always did
// -- so a request with both a missing conversation_id AND an invalid
// action still gets the same "conversation_id is required" message it
// always did, not a reordered "Unknown action".
//
// The apply_conversation_lifecycle_action(...) RPC (see
// supabase/migrations/20260820_conversation_lifecycle_action_rpc.sql) is
// untouched -- this file only calls it exactly as both original files did;
// it is NOT an authorization layer itself (EXECUTE is service_role-only),
// so every authorization/ownership check below is unchanged and still runs
// before the RPC is ever called.
//
// Shape:
//   POST /api/conversation-lifecycle { action: "claim", conversation_id, actor_user_id }
//     -> former api/claim-conversation.js
//   POST /api/conversation-lifecycle { action: "close" | "reopen" | "takeover", conversation_id, actor_user_id }
//     -> former api/conversation-status.js

async function resolveAssignedUserName(supabase, userId) {
  if (!userId) return null;
  const { data } = await supabase.from("users").select("id, name").eq("id", userId).maybeSingle();
  return data || null;
}

// POST { action: "claim", ... } — former api/claim-conversation.js,
// unchanged. Explicit Human Takeover claim: any Inbox-eligible teammate can
// claim an unassigned `waiting_human` conversation for their own client.
// First claimant wins -- the RPC's atomic conditional UPDATE (Postgres
// row-locking) is the sole concurrency-safety mechanism, exactly as before.
async function handleClaim(req, res) {
  const conversation_id = req.body?.conversation_id;
  const actor_user_id = req.body?.actor_user_id;

  if (!conversation_id) {
    return res.status(400).json({ success: false, message: "conversation_id is required" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await resolveActingMembership(supabase, actor_user_id);
  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INBOX)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  const { data: rows, error: rpcError } = await supabase.rpc("apply_conversation_lifecycle_action", {
    p_client_id: actor.membership.client_id,
    p_conversation_id: conversation_id,
    p_actor_user_id: actor.user.id,
    p_action: "accept",
  });

  if (rpcError) {
    // Diagnostic only — the browser still only ever sees the same safe,
    // generic message it always did.
    console.error("apply_conversation_lifecycle_action RPC failed (action=accept):", {
      code: rpcError.code,
      message: rpcError.message,
      details: rpcError.details,
      hint: rpcError.hint,
      conversation_id,
      client_id: actor.membership.client_id,
    });
    return res.status(500).json({ success: false, message: "فشل استلام المحادثة" });
  }

  const result = rows?.[0];

  if (!result || result.outcome === "not_found") {
    return res.status(404).json({ success: false, claimed: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
  }

  if (result.outcome === "conflict") {
    // Lost the race (or the conversation is no longer waiting_human) —
    // return the actual current owner so the UI can show a clean
    // "already claimed" message instead of a generic failure.
    const assignedUser = await resolveAssignedUserName(supabase, result.assigned_user_id);
    return res.status(409).json({
      success: false,
      claimed: false,
      message: result.assigned_user_id
        ? "تم استلام هذه المحادثة بالفعل من قبل موظف آخر"
        : "لم تعد هذه المحادثة بانتظار موظف",
      assignment: {
        conversation_id: result.conversation_id,
        conversation_status: result.conversation_status,
        assigned_user_id: result.assigned_user_id,
        assigned_user: assignedUser,
      },
    });
  }

  // outcome === "ok" — claimed, and the matching conversation_events
  // "accepted" row was already inserted in the same transaction.
  const assignedUser = await resolveAssignedUserName(supabase, result.assigned_user_id);
  return res.status(200).json({
    success: true,
    claimed: true,
    assignment: {
      conversation_id: result.conversation_id,
      conversation_status: result.conversation_status,
      assigned_user_id: result.assigned_user_id,
      assigned_at: result.assigned_at,
      assigned_user: assignedUser,
    },
  });
}

// POST { action: "close" | "reopen" | "takeover", ... } — former
// api/conversation-status.js, unchanged. close ("solve") and reopen go
// through apply_conversation_lifecycle_action(...); takeover stays a plain
// direct UPDATE (no ownership/event concept applies to it), exactly as
// before.
const RPC_ACTION_BY_STATUS_ACTION = { close: "solve", reopen: "reopen" };

async function handleStatusChange(req, res, action) {
  const conversation_id = req.body?.conversation_id;
  const actor_user_id = req.body?.actor_user_id;

  if (!conversation_id) {
    return res.status(400).json({ success: false, message: "conversation_id is required" });
  }
  if (!["close", "reopen", "takeover"].includes(action)) {
    return res.status(400).json({ success: false, message: "Unknown action" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await resolveActingMembership(supabase, actor_user_id);
  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INBOX)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  const { data: current, error: currentError } = await supabase
    .from("conversation_state")
    .select("conversation_id, conversation_status, assigned_user_id")
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id)
    .maybeSingle();

  if (currentError) {
    return res.status(500).json({ success: false, message: "فشل في تحديث حالة المحادثة" });
  }
  if (!current) {
    return res.status(404).json({ success: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
  }

  // Ownership only applies to a conversation already in the human queue —
  // an active/AI-driven conversation has no assigned-owner concept, so
  // close there stays open to any Inbox-eligible teammate; takeover is
  // only ever called from a non-waiting_human state to begin with, so it's
  // naturally never gated by this check. For a waiting_human conversation,
  // close requires the actor to be the assigned employee.
  if (
    action === "close" &&
    current.conversation_status === "waiting_human" &&
    current.assigned_user_id !== actor.user.id
  ) {
    return res.status(403).json({
      success: false,
      message: current.assigned_user_id
        ? "هذه المحادثة مستلمة بواسطة موظف آخر"
        : "يجب استلام المحادثة أولاً",
    });
  }

  const rpcAction = RPC_ACTION_BY_STATUS_ACTION[action];

  if (rpcAction) {
    const { data: rows, error: rpcError } = await supabase.rpc("apply_conversation_lifecycle_action", {
      p_client_id: actor.membership.client_id,
      p_conversation_id: conversation_id,
      p_actor_user_id: actor.user.id,
      p_action: rpcAction,
    });

    if (rpcError) {
      // Diagnostic only — see the identical note in handleClaim above.
      console.error(`apply_conversation_lifecycle_action RPC failed (action=${rpcAction}):`, {
        code: rpcError.code,
        message: rpcError.message,
        details: rpcError.details,
        hint: rpcError.hint,
        conversation_id,
        client_id: actor.membership.client_id,
      });
      return res.status(500).json({ success: false, message: "فشل في تحديث حالة المحادثة" });
    }

    const result = rows?.[0];
    // Only reachable via a TOCTOU race (the row vanished between the
    // `current` lookup above and this call) — there is no delete code
    // path for conversation_state anywhere in this app today, so this is
    // a defensive guard, not an expected outcome.
    if (!result || result.outcome === "not_found") {
      return res.status(404).json({ success: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
    }

    // Only ever reachable for action === "close": the RPC's 'solve'
    // WHERE clause re-enforces the exact same waiting_human-ownership
    // rule as the early check above, atomically.
    if (result.outcome === "forbidden") {
      return res.status(403).json({
        success: false,
        message: result.assigned_user_id
          ? "هذه المحادثة مستلمة بواسطة موظف آخر"
          : "يجب استلام المحادثة أولاً",
      });
    }

    const payload = { updated_at: result.updated_at, conversation_status: result.conversation_status, current_step: result.current_step };
    if (action === "close") {
      payload.solved_by = result.solved_by;
      payload.solved_at = result.solved_at;
    } else if (action === "reopen") {
      payload.assigned_user_id = result.assigned_user_id;
      payload.assigned_at = result.assigned_at;
      payload.reopened_by = result.reopened_by;
      payload.reopened_at = result.reopened_at;
    }

    return res.status(200).json({ success: true, conversation_id, ...payload });
  }

  // action === "takeover" — unchanged plain direct update. Not one of the
  // two actions above (see the module comment): a takeover has no
  // ownership/acceptance concept and no conversation_events entry.
  const payload = {
    updated_at: new Date().toISOString(),
    conversation_status: "waiting_human",
    // current_step intentionally omitted — must not reset the AI flow's
    // step, same as the prior direct-write behavior.
  };

  const { error: updateError } = await supabase
    .from("conversation_state")
    .update(payload)
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id);

  if (updateError) {
    return res.status(500).json({ success: false, message: "فشل في تحديث حالة المحادثة" });
  }

  return res.status(200).json({ success: true, conversation_id, ...payload });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const action = req.body?.action;

  if (action === "claim") {
    return handleClaim(req, res);
  }

  return handleStatusChange(req, res, action);
}
