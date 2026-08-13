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

  // Atomic claim — a single conditional UPDATE is the entire race-condition
  // fix. Postgres row-locks the target row on the first UPDATE to reach it;
  // a second concurrent UPDATE against the same row blocks until the first
  // commits, then re-evaluates its own WHERE clause against the now-updated
  // row. Since assigned_user_id is no longer null at that point, the WHERE
  // clause no longer matches and the second UPDATE affects zero rows — no
  // separate SELECT-then-UPDATE, no advisory lock, no retry loop needed.
  // Scoped to this actor's own client_id (re-derived above, never trusted
  // from the request body) for multi-tenant isolation, and to
  // conversation_status = 'waiting_human' so a conversation that was closed
  // or reopened in the meantime can't be claimed out from under that change.
  const { data: claimed, error: claimError } = await supabase
    .from("conversation_state")
    .update({ assigned_user_id: actor.user.id, assigned_at: new Date().toISOString() })
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id)
    .eq("conversation_status", "waiting_human")
    .is("assigned_user_id", null)
    .select("conversation_id, conversation_status, assigned_user_id, assigned_at, assigned_user:assigned_user_id(id, name)")
    .maybeSingle();

  if (claimError) {
    return res.status(500).json({ success: false, message: "فشل استلام المحادثة" });
  }

  if (claimed) {
    return res.status(200).json({ success: true, claimed: true, assignment: claimed });
  }

  // Lost the race (or the conversation is no longer waiting_human, or
  // doesn't belong to this client) — look up its current state, scoped to
  // the same client, so the UI can show a clean "already claimed" message
  // with the actual current owner's name instead of a generic failure.
  const { data: current, error: currentError } = await supabase
    .from("conversation_state")
    .select("conversation_id, conversation_status, assigned_user_id, assigned_user:assigned_user_id(id, name)")
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id)
    .maybeSingle();

  if (currentError || !current) {
    return res.status(404).json({ success: false, claimed: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
  }

  return res.status(409).json({
    success: false,
    claimed: false,
    message: current.assigned_user_id
      ? "تم استلام هذه المحادثة بالفعل من قبل موظف آخر"
      : "لم تعد هذه المحادثة بانتظار موظف",
    assignment: current,
  });
}
