import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

// Explicit Human Takeover claim: any Inbox-eligible teammate can claim an
// unassigned `waiting_human` conversation for their own client. First
// claimant wins; conversation_status is untouched (already waiting_human,
// set by the takeover action — this endpoint only ever sets
// assigned_user_id/assigned_at, same authorization shape as
// api/human-reply.js: only actor_user_id is trusted from the request,
// client_id/role/permission are always re-derived server-side.
//
// Stage 7B: the actual claim + its conversation_events "accepted" row are
// written together, in one transaction, by the
// apply_conversation_lifecycle_action(...) Postgres function (see
// supabase/migrations/20260820_conversation_lifecycle_action_rpc.sql) —
// this endpoint no longer does two separate writes. That function is NOT
// an authorization layer itself (its EXECUTE grant is service_role-only,
// enforced at the database level, not just by convention); every
// authorization check below is unchanged and still runs here, before the
// function is ever called.
async function resolveAssignedUserName(supabase, userId) {
  if (!userId) return null;
  const { data } = await supabase.from("users").select("id, name").eq("id", userId).maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

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

  // Atomic claim — the WHERE-equivalent condition inside the RPC
  // (conversation_status = 'waiting_human' AND assigned_user_id IS NULL)
  // is byte-for-byte the same one this endpoint used to run directly.
  // Postgres row-locks the target row on the first UPDATE to reach it; a
  // second concurrent call blocks until the first commits, then
  // re-evaluates against the now-updated row and no longer matches — no
  // separate SELECT-then-UPDATE, no advisory lock, no retry loop needed.
  // Scoped to this actor's own client_id (re-derived above, never trusted
  // from the request body) for multi-tenant isolation.
  const { data: rows, error: rpcError } = await supabase.rpc("apply_conversation_lifecycle_action", {
    p_client_id: actor.membership.client_id,
    p_conversation_id: conversation_id,
    p_actor_user_id: actor.user.id,
    p_action: "accept",
  });

  if (rpcError) {
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
