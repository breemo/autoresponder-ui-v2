import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";
import { REPLY_MODE_VALUES, DEFAULT_REPLY_MODE } from "../../src/lib/replyMode.js";
import { createWebsiteChatRepo } from "./websiteChatRepo.js";
import { normalizeAllowedDomains } from "./websiteChatDomains.js";
import { generatePublicKey, generateChannelKey } from "./websiteChatKeys.js";

// Website Chat site management (dashboard, authenticated) — dispatched from
// api/client-integrations.js?resource=website_chat. Each site is one
// client_feature_integrations row (feature slug 'website_chat'); several
// rows per client = several websites, each with its own internal
// channelKey and public widget key.
//
// Authorization: identical convention to the Facebook accounts endpoint
// (api/_lib/clientFacebook.js) — only actor_user_id is taken from the
// request; client_id, role, must_change_password and the INTEGRATIONS
// permission are re-derived server-side, and every query is scoped to
// actor.membership.client_id (ownership in the WHERE clause).
//
// channelKey is generated server-side and NEVER returned: toSafeSite() is
// the single response chokepoint. The public key is returned (it is what
// the client pastes into its website).
//
//   GET  /api/client-integrations?resource=website_chat&actor_user_id=
//     -> { success, sites: [safe...] }
//   POST /api/client-integrations?resource=website_chat
//     { action: "create" | "update" | "set_active" | "regenerate_key" | "delete",
//       actor_user_id, id?, display_name?, allowed_domains?, reply_mode?, is_active? }

const MAX_DISPLAY_NAME = 100;

export function toSafeSite(row) {
  if (!row) return row;
  const cfg = row.config || {};
  return {
    id: row.id,
    is_active: row.is_active === true,
    display_name: cfg.displayName || "",
    public_key: cfg.publicKey || null,
    key_version: Number(cfg.keyVersion) || 1,
    allowed_domains: Array.isArray(cfg.allowedDomains) ? cfg.allowedDomains : [],
    reply_mode: cfg.reply_mode || DEFAULT_REPLY_MODE,
    created_at: row.created_at || null,
  };
}

function defaultDeps() {
  const supabase = getSupabaseServerClient();
  return {
    repo: createWebsiteChatRepo(supabase),
    resolveActor: (actorUserId) => resolveActingMembership(supabase, actorUserId),
  };
}

async function requireActor(res, deps, actorUserId) {
  const actor = await deps.resolveActor(actorUserId);
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

function readDisplayName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= MAX_DISPLAY_NAME ? name : null;
}

function readReplyMode(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  return REPLY_MODE_VALUES.includes(value) ? { ok: true, value } : { ok: false };
}

function readDomains(value) {
  const r = normalizeAllowedDomains(value);
  if (!r.ok || r.domains.length === 0) return null;
  return r.domains;
}

const bad = (res, message) => res.status(400).json({ success: false, message });

export async function handleWebsiteChatSettings(req, res, injectedDeps) {
  let deps;
  try {
    deps = injectedDeps || defaultDeps();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const isGet = req.method === "GET";
  if (!isGet && req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const actor = await requireActor(res, deps, isGet ? req.query?.actor_user_id : req.body?.actor_user_id);
  if (!actor) return;
  const clientId = actor.membership.client_id;

  try {
    const featureId = await deps.repo.getWebsiteChatFeatureId();
    if (!featureId) return res.status(503).json({ success: false, message: "Website Chat is not enabled" });

    if (isGet) {
      const rows = await deps.repo.listSiteIntegrations(clientId, featureId);
      return res.status(200).json({ success: true, sites: rows.map(toSafeSite) });
    }

    const body = req.body || {};
    const action = body.action;

    if (action === "create") {
      const displayName = readDisplayName(body.display_name);
      if (!displayName) return bad(res, "يرجى إدخال اسم الموقع");
      const domains = readDomains(body.allowed_domains);
      if (!domains) return bad(res, "يرجى إدخال نطاق واحد صالح على الأقل (حتى 10 نطاقات)");
      const replyMode = readReplyMode(body.reply_mode);
      if (!replyMode.ok) return bad(res, "قيمة reply_mode غير صالحة");
      if (body.is_active !== undefined && typeof body.is_active !== "boolean") return bad(res, "is_active يجب أن يكون true أو false");

      const config = {
        channelKey: generateChannelKey(),
        publicKey: generatePublicKey(),
        keyVersion: 1,
        displayName,
        allowedDomains: domains,
        reply_mode: replyMode.value || DEFAULT_REPLY_MODE,
      };
      let out;
      try {
        out = await deps.repo.createIntegration({ clientId, featureId, config, isActive: body.is_active !== false });
      } catch (error) {
        if (error?.code === "23505") {
          return res.status(409).json({ success: false, message: "تعذر إنشاء موقع إضافي (قيد فريد على التكامل)" });
        }
        throw error;
      }
      if (out?.outcome === "limit_reached") {
        return res.status(409).json({ success: false, message: `وصلت للحد الأقصى المسموح لمواقع الدردشة ضمن خطتك (${out.plan_limit})` });
      }
      return res.status(200).json({ success: true, site: toSafeSite(out?.integration) });
    }

    const id = body.id;
    if (!id) return bad(res, "id is required");
    const existing = await deps.repo.findOwnedIntegration(clientId, featureId, id);
    if (!existing) return res.status(404).json({ success: false, message: "الموقع غير موجود ضمن هذا الحساب" });
    const cfg = existing.config || {};

    if (action === "update") {
      const next = { ...cfg };
      if (body.display_name !== undefined) {
        const displayName = readDisplayName(body.display_name);
        if (!displayName) return bad(res, "اسم الموقع لا يمكن أن يكون فارغًا");
        next.displayName = displayName;
      }
      if (body.allowed_domains !== undefined) {
        const domains = readDomains(body.allowed_domains);
        if (!domains) return bad(res, "يرجى إدخال نطاق واحد صالح على الأقل (حتى 10 نطاقات)");
        next.allowedDomains = domains;
      }
      if (body.reply_mode !== undefined) {
        const replyMode = readReplyMode(body.reply_mode);
        if (!replyMode.ok) return bad(res, "قيمة reply_mode غير صالحة");
        if (replyMode.value) next.reply_mode = replyMode.value;
      }
      // channelKey / publicKey / keyVersion are server-owned: never taken from the request.
      next.channelKey = cfg.channelKey;
      next.publicKey = cfg.publicKey;
      next.keyVersion = cfg.keyVersion;
      const row = await deps.repo.updateIntegration(id, clientId, featureId, { config: next });
      return res.status(200).json({ success: true, site: toSafeSite(row) });
    }

    if (action === "set_active") {
      if (typeof body.is_active !== "boolean") return bad(res, "is_active يجب أن يكون true أو false");
      const row = await deps.repo.updateIntegration(id, clientId, featureId, { is_active: body.is_active });
      return res.status(200).json({ success: true, site: toSafeSite(row) });
    }

    if (action === "regenerate_key") {
      // New public key + keyVersion: the old snippet stops working at once;
      // visitors of this site keep their identity once they reconnect with
      // the new key (api/widget.js session).
      const next = { ...cfg, publicKey: generatePublicKey(), keyVersion: (Number(cfg.keyVersion) || 1) + 1 };
      const row = await deps.repo.updateIntegration(id, clientId, featureId, { config: next });
      return res.status(200).json({ success: true, site: toSafeSite(row) });
    }

    if (action === "delete") {
      const deletedId = await deps.repo.deleteIntegration(id, clientId, featureId);
      if (!deletedId) return res.status(404).json({ success: false, message: "الموقع غير موجود ضمن هذا الحساب" });
      return res.status(200).json({ success: true, deleted_id: deletedId });
    }

    return res.status(400).json({ success: false, message: "Unknown action" });
  } catch (error) {
    console.error("website-chat settings: request failed:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "فشل تنفيذ العملية" });
  }
}

// Guard for the generic client_feature_integrations actions (add /
// set_active / save_config) in api/client-integrations.js: a Website Chat
// row must only be managed through ?resource=website_chat, so generic
// save_config can never overwrite (or read back) its server-owned keys.
export async function isWebsiteChatFeatureId(repo, featureId) {
  if (!featureId) return false;
  const websiteChatFeatureId = await repo.getWebsiteChatFeatureId();
  return !!websiteChatFeatureId && websiteChatFeatureId === featureId;
}
