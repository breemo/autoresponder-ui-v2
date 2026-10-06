import { handleClientFacebook } from "./_lib/clientFacebook.js";
import { handleWebsiteChatSettings, isWebsiteChatFeatureId } from "./_lib/websiteChatAccounts.js";
import { handleClientFeatureSettings } from "./_lib/clientFeatureSettings.js";
import { featureSlugMap, isInstagramSlug, safeIntegrationView } from "./_lib/integrationSafeView.js";
import { buildInstagramConfigUpdate, redactInstagramConfig } from "./_lib/instagramSetup.js";
import { getMainInboundWebhookBase } from "./_lib/inboundWebhookBase.js";
import { createWebsiteChatRepo } from "./_lib/websiteChatRepo.js";
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

// D4 Step C — the client Integrations page reads its integration rows
// through here (service role) instead of a direct browser select. Scoped
// to the actor's own client_id; every row is projected through
// safeIntegrationView (Instagram token / Website Chat channelKey never
// returned). Exported for unit tests.
export async function listClientIntegrations(supabase, clientId) {
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

// Vercel Hobby Function-count consolidation: ?resource=facebook dispatches
// to the former top-level api/client-facebook.js (Multi-Account Stage 2B
// Facebook Page CRUD, now api/_lib/clientFacebook.js) — unchanged behavior,
// its own GET+POST handling and its own authorization. Requests without
// ?resource keep this file's existing behavior exactly.
//   GET  /api/client-integrations?resource=facebook&actor_user_id=
//   POST /api/client-integrations?resource=facebook { action, actor_user_id, ... }
// Website Chat (Phase 2 foundation): ?resource=website_chat dispatches to
// api/_lib/websiteChatAccounts.js (multi-site CRUD, server-generated keys).
// The generic add/set_active/save_config actions below refuse the
// website_chat feature so its server-owned keys can't be overwritten.
// D4 Step C: ?resource=feature_settings dispatches to
// api/_lib/clientFeatureSettings.js (AdminClientSettings feature drawer,
// admin + client-self-edit actors).
// Pure, synchronous routing decision — unit-testable without Supabase.
export function resolveIntegrationsResource(req) {
  if (req.query?.resource === "facebook") return "facebook";
  if (req.query?.resource === "website_chat") return "website_chat";
  if (req.query?.resource === "feature_settings") return "feature_settings";
  return null;
}

// Returns true when it has already responded (request refused).
async function refuseGenericWebsiteChatMutation(req, res, deps = {}) {
  const featureId = req.body?.feature_id;
  if (req.method !== "POST" || !featureId) return false;
  let supabase;
  try {
    supabase = deps.supabase || getSupabaseServerClient();
  } catch {
    return false; // the existing path answers "Server is not configured"
  }
  try {
    if (await isWebsiteChatFeatureId(createWebsiteChatRepo(supabase), featureId)) {
      res.status(400).json({ success: false, message: "Website Chat is managed via resource=website_chat" });
      return true;
    }
    return false;
  } catch {
    res.status(500).json({ success: false, message: "Failed to verify integration type" });
    return true;
  }
}

// `deps` is for unit tests only (injected Supabase client); Vercel calls
// handler(req, res).
export default async function handler(req, res, deps = {}) {
  const resource = resolveIntegrationsResource(req);
  if (resource === "facebook") {
    return handleClientFacebook(req, res);
  }
  if (resource === "website_chat") {
    return handleWebsiteChatSettings(req, res);
  }
  if (resource === "feature_settings") {
    return handleClientFeatureSettings(req, res, deps);
  }
  if (await refuseGenericWebsiteChatMutation(req, res, deps)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let supabase;
  try {
    supabase = deps.supabase || getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await requireActor(req, res, supabase);
  if (!actor) return;

  // Server-resolved, never the client_id sent in the request body.
  const clientId = actor.membership.client_id;
  const action = req.body?.action;
  const featureId = req.body?.feature_id;

  // Read-only list for the Integrations page (same INTEGRATIONS permission
  // gate as the page route itself). No feature_id needed. Also returns this
  // environment's Main Inbound Flow webhook base (system_settings, server
  // side; null when missing/invalid -> the UI shows "not configured").
  if (action === "list") {
    try {
      const integrations = await listClientIntegrations(supabase, clientId);
      const inbound_webhook_base = await getMainInboundWebhookBase(supabase);
      return res.status(200).json({ success: true, integrations, inbound_webhook_base });
    } catch (error) {
      return res.status(500).json({ success: false, message: "فشل في تحميل التكاملات" });
    }
  }

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

  // Instagram manual-setup save (reconciled from the Phase 2 WIP stash).
  // Writes instagram_account_id / facebook_page_id / reply_mode / optional
  // page_access_token via buildInstagramConfigUpdate, sets the
  // internal channelKey and verify_token once, and never echoes the stored
  // Page Access Token back.
  if (action === "save_instagram_config") {
    const target = await loadOwnedIntegration(supabase, clientId, featureId);
    if (!target) {
      return res.status(404).json({ success: false, message: "التكامل غير موجود ضمن هذا الحساب" });
    }

    let slug = "";
    try {
      slug = (await featureSlugMap(supabase, [featureId])).get(featureId) || "";
    } catch (e) {
      return res.status(500).json({ success: false, message: "فشل التحقق من نوع التكامل" });
    }
    if (!isInstagramSlug(slug)) {
      return res.status(400).json({ success: false, message: "هذا الإجراء مخصّص لقناة إنستغرام فقط" });
    }

    const built = buildInstagramConfigUpdate(target.config || {}, target.id, {
      instagram_account_id: req.body?.instagram_account_id,
      facebook_page_id: req.body?.facebook_page_id,
      reply_mode: req.body?.reply_mode,
      page_access_token: req.body?.page_access_token,
    });
    if (built.error === "invalid_reply_mode") {
      return res.status(400).json({ success: false, message: "قيمة reply_mode غير صالحة" });
    }
    if (built.error || !built.config) {
      return res.status(400).json({ success: false, message: "بيانات غير صالحة" });
    }

    let conflict;
    try {
      conflict = await findConflictingProviderIdentity(
        supabase,
        { instagram_account_id: built.config.instagram_account_id },
        clientId
      );
    } catch (e) {
      return res.status(500).json({ success: false, message: "فشل التحقق من هوية القناة" });
    }
    if (conflict.taken) {
      return res.status(409).json({ success: false, ...PROVIDER_IDENTITY_CONFLICT[conflict.key] });
    }

    const { error } = await supabase
      .from("client_feature_integrations")
      .update({ config: built.config })
      .eq("id", target.id)
      .eq("client_id", clientId);
    if (error) {
      return res.status(500).json({ success: false, message: "فشل حفظ إعدادات إنستغرام" });
    }

    const { config: safeConfig, flags } = redactInstagramConfig(built.config);
    return res.status(200).json({
      success: true,
      config: safeConfig,
      config_flags: flags,
      verify_token: built.config.verify_token,
      channel_key: built.config.channelKey,
    });
  }

  return res.status(400).json({ success: false, message: "Unknown action" });
}
