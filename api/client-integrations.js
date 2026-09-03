import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

// Server-side authorization for Telegram/Facebook/Instagram (and any future
// non-WhatsApp) client_feature_integrations mutations — previously these
// were direct browser-to-Supabase writes with no server-side check at all.
//
// Mirrors api/client-users.js's pattern exactly: only `actor_user_id` is
// ever trusted from the request; role/client_id/permissions are always
// re-derived server-side via resolveActingMembership(), and every mutation
// is scoped to the actor's own client_id — never the client_id in the
// request body.
//
// WhatsApp Evolution is untouched — it keeps its own dedicated endpoint
// (api/create-whatsapp-instance.js) with its own plan-limit logic against
// client_whatsapp. This endpoint governs the generic
// client_feature_integrations row (one per client+feature) every OTHER
// channel uses, and does not change that row's schema or semantics.
//
// Architecture boundary: this endpoint enforces identity/permission
// authorization, multi-tenant ownership, and the plan's connection-count
// limit (plan_features.max_connections) — all things only the web app
// owns. It does NOT check subscription/entitlement status — n8n is the
// authoritative source for that at message-processing time, and
// duplicating the rule here would risk the two disagreeing.

async function requireActor(req, res, supabase) {
  const actor = await resolveActingMembership(supabase, req.body?.actor_user_id);

  if (!actor) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }
  if (actor.user.must_change_password) {
    res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
    return null;
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INTEGRATIONS)) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return null;
  }

  return actor;
}

// Loads a client_feature_integrations row scoped to the actor's own
// client_id — this scoping is the actual multi-tenant boundary.
async function loadOwnedIntegration(supabase, clientId, featureId) {
  const { data, error } = await supabase
    .from("client_feature_integrations")
    .select("id, feature_id, is_active, config")
    .eq("client_id", clientId)
    .eq("feature_id", featureId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

// Cross-tenant provider-identity guard.
//
// A Facebook Page (config.pageId) / Instagram account
// (config.instagram_account_id) may belong to exactly ONE client.
// AutoResponder_Final's `client_feature` node resolves the owning tenant
// for an inbound Meta webhook purely by matching that id against
// client_feature_integrations, with LIMIT 1:
//
//   facebook :  ...?config->>pageId=eq.<channelKey>&features.slug=eq.facebook&limit=1
//   instagram:  ...?config->>instagram_account_id=eq.<channelKey>&features.slug=eq.instagram&limit=1
//
// If the same identity were stored on two clients, that lookup would
// return whichever row Postgres happens to order first, silently routing
// one tenant's customer messages to — and answering them with the AI /
// Welcome config of — a different tenant (observed live for Facebook Page
// 738298739648065). Nothing else in the config is a routing key.
//
// Returns { taken, key } when `config` carries a page/account id already
// stored on a DIFFERENT client's row. Only the presence of a conflict is
// reported — never which client holds it.
const PROVIDER_IDENTITY_KEYS = ["pageId", "instagram_account_id"];

async function findConflictingProviderIdentity(supabase, config, clientId) {
  for (const key of PROVIDER_IDENTITY_KEYS) {
    const value = typeof config?.[key] === "string" ? config[key].trim() : "";
    if (!value) continue;
    const { data, error } = await supabase
      .from("client_feature_integrations")
      .select("id")
      .eq(`config->>${key}`, value)
      .neq("client_id", clientId)
      .limit(1);
    if (error) throw error;
    if ((data || []).length > 0) return { taken: true, key };
  }
  return { taken: false, key: null };
}

const PROVIDER_IDENTITY_CONFLICT = {
  pageId: {
    code: "FACEBOOK_PAGE_ALREADY_ASSIGNED",
    message: "هذه الصفحة مرتبطة بحساب عميل آخر بالفعل",
  },
  instagram_account_id: {
    code: "INSTAGRAM_ACCOUNT_ALREADY_ASSIGNED",
    message: "هذا الحساب مرتبط بعميل آخر بالفعل",
  },
};

// Generic per-feature connection-limit check — same shape as the WhatsApp
// Evolution enforcement in api/create-whatsapp-instance.js, against
// plan_features.max_connections. Every other channel is currently capped
// at one client_feature_integrations row per feature by construction, so
// `currentCount` is always 0 here (checked before the row exists); this is
// written generically so a future multi-connection channel needs only a
// real count query swapped in, not new enforcement code.
async function checkConnectionLimit(supabase, planId, featureId, currentCount) {
  if (!planId) return { allowed: true };

  const { data: planFeatureRow } = await supabase
    .from("plan_features")
    .select("max_connections")
    .eq("plan_id", planId)
    .eq("feature_id", featureId)
    .maybeSingle();

  const maxConnections = planFeatureRow?.max_connections;
  if (maxConnections === null || maxConnections === undefined) return { allowed: true };

  if (currentCount >= maxConnections) {
    return {
      allowed: false,
      message: `وصلت للحد الأقصى المسموح لهذه القناة ضمن خطتك (${maxConnections})`,
    };
  }

  return { allowed: true };
}

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

  const actor = await requireActor(req, res, supabase);
  if (!actor) return;

  // Server-resolved, never the client_id sent in the request body.
  const clientId = actor.membership.client_id;
  const action = req.body?.action;
  const featureId = req.body?.feature_id;

  if (!featureId) {
    return res.status(400).json({ success: false, message: "feature_id is required" });
  }

  if (action === "add") {
    const existing = await loadOwnedIntegration(supabase, clientId, featureId);
    if (existing) {
      return res.status(409).json({ success: false, message: "هذه القناة مفعّلة بالفعل" });
    }

    try {
      const { data: clientRow, error: clientError } = await supabase
        .from("clients")
        .select("plan_id")
        .eq("id", clientId)
        .maybeSingle();

      if (clientError) throw clientError;

      const limitCheck = await checkConnectionLimit(supabase, clientRow?.plan_id, featureId, 0);
      if (!limitCheck.allowed) {
        return res.status(409).json({ success: false, message: limitCheck.message });
      }
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to verify plan connection limit" });
    }

    const { data, error } = await supabase
      .from("client_feature_integrations")
      .insert({ client_id: clientId, feature_id: featureId, is_active: true, config: {} })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ success: false, message: "فشل في تفعيل التكامل" });
    }

    return res.status(200).json({ success: true, integration: data });
  }

  if (action === "set_active") {
    const target = await loadOwnedIntegration(supabase, clientId, featureId);
    if (!target) {
      return res.status(404).json({ success: false, message: "التكامل غير موجود ضمن هذا الحساب" });
    }

    const isActive = req.body?.is_active === true;

    const { error } = await supabase
      .from("client_feature_integrations")
      .update({ is_active: isActive })
      .eq("id", target.id);

    if (error) {
      return res.status(500).json({ success: false, message: "فشل تحديث حالة التكامل" });
    }

    return res.status(200).json({ success: true });
  }

  if (action === "save_config") {
    const target = await loadOwnedIntegration(supabase, clientId, featureId);
    if (!target) {
      return res.status(404).json({ success: false, message: "التكامل غير موجود ضمن هذا الحساب" });
    }

    const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};

    // A Facebook Page / Instagram account identity may only ever belong
    // to one client — reject a config that would claim one already
    // connected to another tenant (see findConflictingProviderIdentity).
    let conflict;
    try {
      conflict = await findConflictingProviderIdentity(supabase, config, clientId);
    } catch (e) {
      return res.status(500).json({ success: false, message: "فشل التحقق من هوية القناة" });
    }
    if (conflict.taken) {
      return res.status(409).json({ success: false, ...PROVIDER_IDENTITY_CONFLICT[conflict.key] });
    }

    const { error } = await supabase
      .from("client_feature_integrations")
      .update({ config })
      .eq("id", target.id);

    if (error) {
      return res.status(500).json({ success: false, message: "فشل حفظ إعدادات التكامل" });
    }

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false, message: "Unknown action" });
}
