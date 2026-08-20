import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

// Server-authorized conversation_state status transitions: close / reopen /
// takeover. These used to be direct browser -> Supabase writes from
// ClientMessages.jsx (no actor/permission/ownership check at all, same
// trust model gap documented elsewhere in this app). Moved here
// specifically so Human Takeover ownership can actually be enforced —
// without a server check, a non-owning teammate could bypass the UI's
// disabled Close button entirely by calling Supabase directly from
// devtools. Same trust model as every other route in this app: only
// actor_user_id is trusted from the request, client_id/role/permission are
// always re-derived server-side.
//
// Stage 7B: close ("solve") and reopen now go through
// apply_conversation_lifecycle_action(...) (see
// supabase/migrations/20260820_conversation_lifecycle_action_rpc.sql),
// which performs the conversation_state update and its matching
// conversation_events row in one transaction — this endpoint no longer
// does two separate writes for those two actions. That function is NOT an
// authorization layer itself (EXECUTE is service_role-only, enforced at
// the database level); every authorization/ownership check below is
// unchanged and still runs here, before the function is ever called.
// takeover is not one of the three actions Stage 7B covers (no ownership/
// event concept applies to it) and keeps doing a plain direct UPDATE,
// exactly as before.
const RPC_ACTION_BY_STATUS_ACTION = { close: "solve", reopen: "reopen" };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const action = req.body?.action;
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
  // close there stays open to any Inbox-eligible teammate (unchanged
  // pre-existing behavior; takeover is only ever called from a non-
  // waiting_human state to begin with, so it's naturally never gated by
  // this check). For a waiting_human conversation, close requires the
  // actor to be the assigned employee — and if no one has claimed it yet
  // (assigned_user_id is null), this correctly blocks everyone until
  // someone claims it first, matching the "must claim before acting" rule.
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
      // Diagnostic only — see the identical note in
      // api/claim-conversation.js. Browser response unchanged.
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
    // rule as the early check above, atomically — this is that race
    // (ownership changed between the early SELECT and this call) being
    // caught by the database instead of silently allowed through. Same
    // 403 response the early check already returns for this case.
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
  // three actions Stage 7B covers (see the module comment above): a
  // takeover has no ownership/acceptance concept and no conversation_events
  // entry in this stage.
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
