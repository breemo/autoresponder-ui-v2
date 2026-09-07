import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingAdmin } from "./_lib/clientAuthz.js";
import { computeAdminOverview } from "./_lib/adminOverview.js";

// Platform system settings — the central registry for n8n workflow
// references (Admin -> Settings -> System).
//
// Allowlisted keys only — this endpoint can never read/write an arbitrary
// system_settings row (e.g. a future secret), even as the table grows.
//
//   human_reply_webhook_url            – URL. Consumed by api/_lib/humanReply.js
//                                        (Vercel -> n8n). UNCHANGED behavior.
//   ai_agent_core_workflow_id          – n8n workflow ID. Consumed by the parent
//                                        workflows' Execute Workflow node
//                                        (resourceLocator "id" mode expression).
//   inbound_media_core_workflow_id     – n8n workflow ID. Same.
//   ai_agent_core_workflow_url         – URL. Administration/reference only —
//                                        not consumed by any workflow.
//   inbound_media_core_workflow_url    – URL. Reference only.
//
// AUTHORIZATION: previously this endpoint was completely unauthenticated —
// any caller could read the human-reply webhook URL and repoint it. It now
// requires a platform-admin actor (users.role === "admin"), the same check
// src/App.jsx's <AdminRoute> makes for the page. Follows the existing
// "only actor_user_id is trusted, role is re-read server-side" pattern
// (see api/_lib/clientAuthz.js) — no new auth architecture.
//
// GET /api/system-settings?resource=overview&actor_user_id=  ->  the
// Admin (platform operator) Overview: platform-wide aggregates over
// clients / subscriptions / plans / conversations / messages / channel
// accounts. Same admin-only gate; no tenant parameter. See
// api/_lib/adminOverview.js. (Folded in here rather than a new file — the
// deploy is already at the 12-Serverless-Function Hobby cap, and this
// endpoint is already the platform-admin one.)
const WEBHOOK_KEYS = new Set(["human_reply_webhook_url"]);
const ID_KEYS = new Set(["ai_agent_core_workflow_id", "inbound_media_core_workflow_id"]);
const URL_KEYS = new Set(["ai_agent_core_workflow_url", "inbound_media_core_workflow_url"]);

const ALL_KEYS = [...WEBHOOK_KEYS, ...ID_KEYS, ...URL_KEYS];

async function persistSetting(supabase, key, value) {
  // Select-then-update-or-insert: no dependency on the exact unique
  // constraint name / on-conflict target for system_settings (the table
  // predates this repo's migrations). Missing rows are created safely.
  const { data: existing, error: selError } = await supabase
    .from("system_settings")
    .select("key")
    .eq("key", key)
    .maybeSingle();
  if (selError) return { ok: false };

  if (existing) {
    const { error } = await supabase.from("system_settings").update({ value }).eq("key", key);
    return { ok: !error };
  }
  const { error } = await supabase.from("system_settings").insert({ key, value });
  return { ok: !error };
}

export default async function handler(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actorUserId =
    req.method === "GET"
      ? req.query?.actor_user_id
      : req.body?.actor_user_id;

  const admin = await resolveActingAdmin(supabase, actorUserId);
  if (!admin) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  // Admin (platform operator) Overview — platform-wide aggregates. Reached
  // ONLY after the resolveActingAdmin() check above (users.role === "admin",
  // re-derived server-side). No client_id / tenant parameter is read — a
  // browser cannot obtain platform-wide data by passing a client_id or a
  // role. See api/_lib/adminOverview.js.
  if (req.method === "GET" && req.query?.resource === "overview") {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("system-settings(overview): SUPABASE_SERVICE_ROLE_KEY is not set — refusing to serve admin aggregates (anon-key reads on public.messages return an empty set under RLS, not an error).");
      return res.status(500).json({ success: false, message: "Server is not configured" });
    }
    try {
      const overview = await computeAdminOverview(supabase);
      return res.status(200).json({ success: true, overview });
    } catch (error) {
      console.error("system-settings(overview): failed to build admin overview:", error);
      return res.status(500).json({ success: false, message: "Failed to load the admin overview" });
    }
  }

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("system_settings")
      .select("key, value")
      .in("key", ALL_KEYS);

    if (error) {
      return res.status(500).json({ success: false, message: "Failed to load settings" });
    }

    const settings = {};
    for (const k of ALL_KEYS) settings[k] = "";
    for (const row of data || []) {
      if (typeof row?.key === "string" && ALL_KEYS.includes(row.key)) {
        settings[row.key] = row.value || "";
      }
    }

    return res.status(200).json({
      success: true,
      settings,
      // Back-compat: existing shape kept so nothing that reads the flat
      // field breaks.
      human_reply_webhook_url: settings.human_reply_webhook_url,
    });
  }

  if (req.method === "POST" || req.method === "PUT") {
    // Accept flat keys ({ actor_user_id, human_reply_webhook_url, ... }) or
    // a nested { settings: { ... } }. Only non-empty, allowlisted string
    // values are persisted — an empty field never overwrites a stored one
    // (guards against accidentally clearing load-bearing config).
    const source =
      req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : req.body || {};

    const updates = [];
    for (const key of ALL_KEYS) {
      const raw = source[key];
      if (typeof raw !== "string") continue;
      const value = raw.trim();
      if (!value) continue;
      updates.push({ key, value });
    }

    if (!updates.length) {
      return res.status(400).json({ success: false, message: "No valid settings provided" });
    }

    for (const { key, value } of updates) {
      const result = await persistSetting(supabase, key, value);
      if (!result.ok) {
        return res.status(500).json({ success: false, message: `Failed to save ${key}` });
      }
    }

    const { data, error } = await supabase
      .from("system_settings")
      .select("key, value")
      .in("key", ALL_KEYS);

    const settings = {};
    for (const k of ALL_KEYS) settings[k] = "";
    if (!error) {
      for (const row of data || []) {
        if (typeof row?.key === "string" && ALL_KEYS.includes(row.key)) {
          settings[row.key] = row.value || "";
        }
      }
    }

    return res.status(200).json({
      success: true,
      settings,
      human_reply_webhook_url: settings.human_reply_webhook_url,
    });
  }

  return res.status(405).json({ success: false, message: "Method not allowed" });
}
