import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

const WHATSAPP_FEATURE_SLUG = "whatsapp_evolution";

// Proxies WhatsApp Evolution instance management (create/connect/sync/delete)
// to the n8n gateway workflow. Historically this was an unauthenticated thin
// proxy (any caller who could reach it could act as any client_id supplied
// in the body); it now resolves the acting membership server-side the same
// way api/client-users.js and api/human-reply.js do, and never trusts a
// browser-supplied client_id — see clientId below.
//
// Architecture boundary: this endpoint enforces identity/permission
// authorization, multi-tenant ownership, and the plan's connection-count
// limit (plan_features.max_connections) — all things only the web app
// owns. It does NOT re-check subscription/entitlement status (active,
// expired, plan allows sending, etc.) — the n8n gateway workflow this
// forwards to already performs that check authoritatively against the same
// Supabase data, early in its own flow. Duplicating it here would create
// two independent implementations that can drift and disagree.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const action = req.body?.action;
  const actor = await resolveActingMembership(supabase, req.body?.actor_user_id);

  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INTEGRATIONS)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  // Server-resolved, never the client_id sent in the request body — this is
  // what actually prevents Client A from acting on Client B's WhatsApp
  // instances by editing the request.
  const clientId = actor.membership.client_id;

  // Cross-tenant ownership check: an existing instance targeted by
  // connect/delete must actually belong to the acting client.
  if (action === "connect_instance" || action === "delete_instance") {
    const { data: instance, error: instanceError } = await supabase
      .from("client_whatsapp")
      .select("id")
      .eq("id", req.body?.whatsapp_id)
      .eq("client_id", clientId)
      .maybeSingle();

    if (instanceError || !instance) {
      return res.status(404).json({ success: false, message: "الرقم غير موجود ضمن هذا الحساب" });
    }
  }

  // Plan connection-limit gate (only relevant when actually adding a new
  // number). See plan_features.max_connections — the generic, per-feature
  // limit column; null/missing means unlimited.
  if (action === "create_instance") {
    try {
      const { data: clientRow, error: clientError } = await supabase
        .from("clients")
        .select("plan_id")
        .eq("id", clientId)
        .maybeSingle();

      if (clientError) throw clientError;

      if (clientRow?.plan_id) {
        const { data: featureRow } = await supabase
          .from("features")
          .select("id")
          .eq("slug", WHATSAPP_FEATURE_SLUG)
          .maybeSingle();

        if (featureRow?.id) {
          const { data: planFeatureRow } = await supabase
            .from("plan_features")
            .select("max_connections")
            .eq("plan_id", clientRow.plan_id)
            .eq("feature_id", featureRow.id)
            .maybeSingle();

          const maxConnections = planFeatureRow?.max_connections;

          if (maxConnections !== null && maxConnections !== undefined) {
            const { count, error: countError } = await supabase
              .from("client_whatsapp")
              .select("id", { count: "exact", head: true })
              .eq("client_id", clientId);

            if (countError) throw countError;

            if ((count || 0) >= maxConnections) {
              return res.status(409).json({
                success: false,
                message: `وصلت للحد الأقصى المسموح لأرقام واتساب ضمن خطتك (${maxConnections})`,
              });
            }
          }
        }
      }
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to verify plan connection limit" });
    }
  }

  try {
    const webhookUrl = process.env.N8N_EVOLUTION_GATEWAY_URL;

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...req.body, client_id: clientId }),
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
      message: error.message || "Failed to call n8n",
    });
  }
}
