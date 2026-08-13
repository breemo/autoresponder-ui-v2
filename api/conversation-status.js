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

  const payload = { updated_at: new Date().toISOString() };

  if (action === "close") {
    payload.conversation_status = "closed";
    payload.current_step = "done";
    // assigned_user_id/assigned_at intentionally untouched — preserved as
    // the historical record of who handled this conversation.
  } else if (action === "reopen") {
    payload.conversation_status = "active";
    payload.current_step = null;
    payload.assigned_user_id = null;
    payload.assigned_at = null;
  } else if (action === "takeover") {
    payload.conversation_status = "waiting_human";
    // current_step intentionally omitted — must not reset the AI flow's
    // step, same as the prior direct-write behavior.
  }

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
