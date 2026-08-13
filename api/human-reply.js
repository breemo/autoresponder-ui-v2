import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

const SETTING_KEY = "human_reply_webhook_url";

// Thin proxy to the n8n Human Reply workflow, following the same
// fetch-and-relay shape as api/create-whatsapp-instance.js. n8n resolves
// client/channel/integration from conversation_id and owns both channel
// delivery and the outbound Supabase insert — this endpoint does neither.
//
// Authorization: the caller must resolve to an active client_users
// membership with `inbox` permission. Same documented limitation as
// elsewhere: only `actor_user_id` is trusted, and it isn't cryptographically
// verified (no session tokens exist in this app).
//
// Architecture boundary: subscription/plan entitlement (is the client's
// subscription active, expired, does the plan allow sending, does it
// support AI, etc.) is intentionally NOT re-checked here. The n8n workflow
// this proxies to already performs that check authoritatively, early in
// its own flow, against the same Supabase data. Duplicating that business
// logic here would create two independent implementations that can drift
// and disagree — this endpoint only ever enforces identity/permission
// authorization and multi-tenant isolation, not runtime service
// entitlement. See supabase/migrations/20260814_client_subscription_status_view.sql
// for the (UI-only) subscription status read-model this app still owns.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const conversation_id = req.body?.conversation_id;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const actor_user_id = req.body?.actor_user_id;

  if (!conversation_id || !message) {
    return res.status(400).json({
      success: false,
      message: "conversation_id and message are required",
    });
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

  // Human Takeover ownership: a conversation already in the human queue
  // (waiting_human) can only be replied to by its assigned employee — and
  // if nobody has claimed it yet (assigned_user_id null), nobody may reply
  // until someone does. A conversation not in that state has no owner
  // concept and stays unrestricted (unchanged pre-existing behavior — a
  // human can already reply on a normal active/AI-driven conversation).
  const { data: state, error: stateError } = await supabase
    .from("conversation_state")
    .select("conversation_status, assigned_user_id")
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id)
    .maybeSingle();

  if (stateError) {
    return res.status(500).json({ success: false, message: "فشل التحقق من حالة المحادثة" });
  }

  if (state?.conversation_status === "waiting_human" && state.assigned_user_id !== actor.user.id) {
    return res.status(403).json({
      success: false,
      message: state.assigned_user_id
        ? "هذه المحادثة مستلمة بواسطة موظف آخر"
        : "يجب استلام المحادثة أولاً",
    });
  }

  // No subscription/entitlement check here — see the architecture note
  // above. n8n decides whether this client is allowed to send.

  const { data: setting, error: settingError } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle();

  const webhookUrl = setting?.value;

  if (settingError || !webhookUrl) {
    return res.status(500).json({
      success: false,
      message: "Human reply webhook is not configured",
    });
  }

  try {
    // sent_by_user_id is additive and safe to send even though n8n does not
    // read it yet — see the "Human takeover readiness" note in the
    // implementation report for exactly what n8n would need to do to start
    // persisting it onto the outbound message row.
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ conversation_id, message, sent_by_user_id: actor.user.id }),
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to reach human reply workflow",
    });
  }
}
