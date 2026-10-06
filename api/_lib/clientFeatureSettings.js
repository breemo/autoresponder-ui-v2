import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActor } from "./clientAiBehavior.js";
import { featureSlugMap, isInstagramSlug, isWebsiteChatSlug, safeIntegrationView } from "./integrationSafeView.js";
import { getMainInboundWebhookBase } from "./inboundWebhookBase.js";

// D4 Step C — channel feature-settings drawer of AdminClientSettings.jsx in
// ADMIN mode (/admin/client/:id). Replaces the drawer's former direct
// browser reads/writes of client_feature_integrations.
//
// Authorization: PLATFORM ADMINS ONLY. Actor resolution reuses
// resolveActor() from api/_lib/clientAiBehavior.js (admin: any existing
// client, client_id supplied explicitly), and every non-admin actor is
// refused with 403. Clients manage channel configuration exclusively on the
// Integrations page (/api/client-integrations, INTEGRATIONS permission) —
// channel configs are NOT exposed through AI_SETTINGS. (The client-mode
// Feature Settings page keeps AI Behavior via resource=ai-behavior.)
//
// Shape (dispatched from api/client-integrations.js?resource=feature_settings):
//   GET  ?resource=feature_settings&actor_user_id=&client_id=
//     -> { success, integrations: [safe view...], can_edit, inbound_webhook_base }
//   POST ?resource=feature_settings
//     { action: "save", actor_user_id, client_id? (admin), feature_id, config }
//     -> { success, integration: safe view }
//
// Save keeps the drawer's existing semantics: update the client's row for
// that feature with `config`, or insert it when missing. Website Chat and
// Instagram rows carry server-owned keys/secrets and are managed only via
// their own server actions, so this generic save refuses them.

const MANAGED_ELSEWHERE_MESSAGE = "هذه القناة تُدار من صفحة التكاملات";

export async function listFeatureSettings(supabase, clientId) {
  const { data, error } = await supabase
    .from("client_feature_integrations")
    .select("id, client_id, feature_id, is_active, config, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = data || [];
  const slugById = await featureSlugMap(supabase, rows.map((r) => r.feature_id));
  return rows.map((row) => safeIntegrationView(row, slugById.get(row.feature_id)));
}

export async function saveFeatureSettings(supabase, { clientId, featureId, config }) {
  if (!featureId || typeof featureId !== "string") {
    return { status: 400, body: { success: false, message: "feature_id is required" } };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { status: 400, body: { success: false, message: "config must be an object" } };
  }

  const slug = (await featureSlugMap(supabase, [featureId])).get(featureId);
  if (!slug) return { status: 404, body: { success: false, message: "الميزة غير موجودة" } };
  if (isWebsiteChatSlug(slug) || isInstagramSlug(slug)) {
    return { status: 400, body: { success: false, code: "managed_elsewhere", message: MANAGED_ELSEWHERE_MESSAGE } };
  }

  // The drawer only lists the client's plan features — enforce the same.
  const { data: clientRow, error: clientError } = await supabase
    .from("clients")
    .select("plan_id")
    .eq("id", clientId)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!clientRow?.plan_id) return { status: 403, body: { success: false, message: "الميزة غير متاحة ضمن الخطة" } };
  const { data: planFeature, error: pfError } = await supabase
    .from("plan_features")
    .select("feature_id")
    .eq("plan_id", clientRow.plan_id)
    .eq("feature_id", featureId)
    .maybeSingle();
  if (pfError) throw pfError;
  if (!planFeature) return { status: 403, body: { success: false, message: "الميزة غير متاحة ضمن الخطة" } };

  const { data: existing, error: existingError } = await supabase
    .from("client_feature_integrations")
    .select("id")
    .eq("client_id", clientId)
    .eq("feature_id", featureId)
    .maybeSingle();
  if (existingError) throw existingError;

  const columns = "id, client_id, feature_id, is_active, config, created_at";
  const { data: row, error } = existing
    ? await supabase
        .from("client_feature_integrations")
        .update({ config })
        .eq("id", existing.id)
        .eq("client_id", clientId)
        .select(columns)
        .single()
    : await supabase
        .from("client_feature_integrations")
        .insert([{ client_id: clientId, feature_id: featureId, config }])
        .select(columns)
        .single();
  if (error) throw error;

  return { status: 200, body: { success: true, integration: safeIntegrationView(row, slug) } };
}

export async function handleClientFeatureSettings(req, res, deps = {}) {
  let supabase;
  try {
    supabase = deps.supabase || getSupabaseServerClient();
  } catch {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const isGet = req.method === "GET";
  if (!isGet && req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const source = isGet ? req.query || {} : req.body || {};
  const { error: authError, actor } = await resolveActor(supabase, {
    actorUserId: source.actor_user_id,
    requestedClientId: source.client_id,
  });
  if (authError) return res.status(authError.status).json({ success: false, message: authError.message });
  if (actor.kind !== "admin") return res.status(403).json({ success: false, message: "Forbidden" });

  try {
    if (isGet) {
      const integrations = await listFeatureSettings(supabase, actor.clientId);
      const inbound_webhook_base = await getMainInboundWebhookBase(supabase);
      return res.status(200).json({ success: true, integrations, can_edit: actor.canWrite === true, inbound_webhook_base });
    }

    if (source.action !== "save") {
      return res.status(400).json({ success: false, message: "Unknown action" });
    }
    if (!actor.canWrite) return res.status(403).json({ success: false, message: "Forbidden" });

    const out = await saveFeatureSettings(supabase, {
      clientId: actor.clientId,
      featureId: source.feature_id,
      config: source.config,
    });
    return res.status(out.status).json(out.body);
  } catch (error) {
    console.error("feature-settings: request failed:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "فشل في معالجة إعدادات الميزة" });
  }
}
