import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";

// AI Engine V1 — Phase 2: client_ai_behavior CRUD.
//
// Vercel Hobby Function-count consolidation: this file was formerly the
// top-level api/client-ai-behavior.js, dispatched from
// api/client-router.js (?resource=ai-behavior) instead of being its own
// deployed Vercel Function — see the deployment-failure inspection
// report. Behavior, auth, and response shapes below are completely
// unchanged; AdminClientSettings.jsx was updated to call the new URL,
// nothing else changed.
//
// client_ai_behavior has RLS enabled with zero policies (Phase 1) — the
// browser's anon-keyed Supabase client cannot read or write it at all, by
// design (same convention as client_facebook — see api/client-facebook.js).
// This endpoint is the only path to it. Never query client_ai_behavior
// directly from React/browser Supabase code.
//
// Dual actor support — a real difference from every other endpoint in this
// app (client-facebook.js, client-integrations.js, create-whatsapp-
// instance.js are all client-role-only via resolveActingMembership()):
// AdminClientSettings.jsx, the only current caller, is used BOTH by an
// admin managing any client AND by a client editing their own account
// (clientIdOverride prop / plan.allow_self_edit), exactly like every other
// section on that page already works via direct browser Supabase calls +
// RLS. client_ai_behavior has no RLS policies to lean on, so this endpoint
// re-implements the same two-actor rule server-side instead:
//   - admin (users.role === 'admin'): may act on ANY client_id, which it
//     must supply explicitly (an admin has no client_id of their own) —
//     verified to be a real client, never trusted beyond that existence
//     check (admin managing any client is the normal, intended shape of
//     the admin console, identical to how AdminClientSettings.jsx already
//     lets admin view/edit any client's subscriptions/features today).
//   - client (users.role === 'client', active client_users membership):
//     client_id is ALWAYS actor.membership.client_id, server-derived —
//     never accepted from the request, matching every other endpoint's
//     "never trust a browser-supplied client_id" rule. Read access
//     requires the AI_SETTINGS permission; write access additionally
//     requires the client's plan to have allow_self_edit === true —
//     the exact same two-gate rule (`isAdmin || clientCanEdit`) the
//     React layer already enforces for the legacy config drawer, now
//     also enforced here since there is no RLS backstop for this table.
//
// Upsert semantics around client_ai_behavior_client_id_unique
// (UNIQUE(client_id), Phase 1): the form always submits the complete
// current state of all 7 fields, so save is a single
// `.upsert(..., { onConflict: "client_id" })` of the full row rather than
// a partial-field PATCH — simplest correct behavior for a settings form
// with always-present controlled inputs, and avoids any ambiguity about
// "omitted vs intentionally cleared" for this shape. Never invents a
// value: a blank field is stored as null (or [] for forbidden_rules), not
// a fabricated default — matching the Phase 1 migration's own "no
// invented defaults" rule.
//
// Shape:
//   GET  /api/client-router?resource=ai-behavior&actor_user_id=&client_id=
//        (client_id required only when the actor is an admin; ignored for
//        a client actor, whose own client_id is always used instead)
//     -> { success: true, behavior: {...}|null, can_edit: boolean }
//   POST /api/client-router?resource=ai-behavior
//     { actor_user_id, client_id? (admin only),
//       personality?, reply_tone?, default_language?, forbidden_rules?,
//       special_instructions?, booking_instructions?,
//       escalation_instructions? }
//     -> { success: true, behavior: {...} }

const BEHAVIOR_SELECT_COLUMNS =
  "id, client_id, personality, reply_tone, default_language, forbidden_rules, special_instructions, booking_instructions, escalation_instructions, created_at, updated_at";

// Resolves who is acting and which client_id they may act on, plus
// whether they're allowed to WRITE (not just read). Mirrors the React
// layer's own isAdmin / (AI_SETTINGS permission + plan.allow_self_edit)
// rule — see this file's header comment for why it has to be
// re-implemented here instead of leaning on RLS.
async function resolveActor(supabase, { actorUserId, requestedClientId }) {
  if (!actorUserId) return { error: { status: 401, message: "Unauthorized" } };

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("id, role, must_change_password")
    .eq("id", actorUserId)
    .maybeSingle();

  if (userError || !userRow) return { error: { status: 401, message: "Unauthorized" } };
  if (userRow.must_change_password) {
    return { error: { status: 403, message: "يجب تغيير كلمة المرور المؤقتة أولاً" } };
  }

  if (userRow.role === "admin") {
    const clientId = typeof requestedClientId === "string" ? requestedClientId.trim() : "";
    if (!clientId) {
      return { error: { status: 400, message: "client_id is required" } };
    }

    const { data: clientRow, error: clientError } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .maybeSingle();

    if (clientError) return { error: { status: 500, message: "فشل التحقق من العميل" } };
    if (!clientRow) return { error: { status: 404, message: "العميل غير موجود" } };

    return { actor: { kind: "admin", clientId, canWrite: true } };
  }

  if (userRow.role === "client") {
    const actor = await resolveActingMembership(supabase, actorUserId);
    if (!actor) return { error: { status: 401, message: "Unauthorized" } };
    if (!actorHasPermission(actor.membership, PERMISSIONS.AI_SETTINGS)) {
      return { error: { status: 403, message: "Forbidden" } };
    }

    const clientId = actor.membership.client_id;

    const { data: clientRow, error: clientError } = await supabase
      .from("clients")
      .select("plan_id")
      .eq("id", clientId)
      .maybeSingle();
    if (clientError) return { error: { status: 500, message: "فشل التحقق من الخطة" } };

    let allowSelfEdit = false;
    if (clientRow?.plan_id) {
      const { data: planRow, error: planError } = await supabase
        .from("plans")
        .select("allow_self_edit")
        .eq("id", clientRow.plan_id)
        .maybeSingle();
      if (planError) return { error: { status: 500, message: "فشل التحقق من الخطة" } };
      allowSelfEdit = planRow?.allow_self_edit === true;
    }

    return { actor: { kind: "client", clientId, canWrite: allowSelfEdit } };
  }

  return { error: { status: 401, message: "Unauthorized" } };
}

// Trims a free-text field down to null-if-empty — never stores a
// whitespace-only string, never invents a value for an empty one.
function normalizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// forbidden_rules must be a jsonb array of non-empty strings (Phase 1
// default: '[]'). Rejects anything else outright rather than silently
// coercing — a malformed value here would otherwise reach the AI prompt
// unchecked in a later phase.
function normalizeForbiddenRules(value) {
  if (value === undefined) return { ok: true, provided: false };
  if (!Array.isArray(value)) return { ok: false };

  const rules = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { ok: false };
    const trimmed = entry.trim();
    if (trimmed !== "") rules.push(trimmed);
  }

  return { ok: true, provided: true, value: rules };
}

async function handleGet(req, res, supabase) {
  const { error, actor } = await resolveActor(supabase, {
    actorUserId: req.query?.actor_user_id,
    requestedClientId: req.query?.client_id,
  });
  if (error) return res.status(error.status).json({ success: false, message: error.message });

  try {
    const { data, error: rowError } = await supabase
      .from("client_ai_behavior")
      .select(BEHAVIOR_SELECT_COLUMNS)
      .eq("client_id", actor.clientId)
      .maybeSingle();

    if (rowError) throw rowError;

    return res.status(200).json({ success: true, behavior: data || null, can_edit: actor.canWrite });
  } catch (err) {
    console.error("client-ai-behavior: failed to load:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في تحميل إعدادات سلوك الذكاء الاصطناعي" });
  }
}

// TEMPORARY, Phase 2 -> Phase 3/4 cutover ONLY. Remove this function and
// its one call site once n8n's AI prompt path reads client_ai_behavior
// directly instead of client_feature_integrations.config (AI Engine V1
// blueprint, Phase 7 cleanup).
//
// Why this exists: from this phase onward, the new AI Behavior UI writes
// authoritatively to client_ai_behavior, not client_feature_integrations.
// But n8n's live AI prompt path still reads
// client_feature_integrations.config.reply_tone/language/
// special_instructions today (unchanged until cutover). Without this,
// any edit made through the new UI would be invisible to the live AI —
// a real regression, and the exact kind of "authoritative source the
// running system doesn't actually read" drift Phase 0 diagnosed as the
// root cause of the "birds" incident. So this mirrors ONLY those same 3
// fields back into the existing legacy config row, best-effort.
//
// Scope, strictly enforced:
//   - ONLY reply_tone, language, special_instructions. Never personality,
//     booking_instructions, escalation_instructions, or forbidden_rules
//     (n8n's prompt code doesn't read those keys at all today, so writing
//     them would be pure clutter, not compatibility).
//   - NEVER touches business_name/business_description/phone_number/
//     working_hours or any other key already present in config — read-
//     modify-write against the EXISTING config object, merging in only
//     the 3 keys above, every other key (including stale Business
//     Profile fields Phase 0 found drifting) passes through untouched.
//   - Best-effort only: if the client has no ai_auto_reply
//     client_feature_integrations row yet, this silently does nothing —
//     it never creates one. A missing/failed dual-write never fails the
//     primary client_ai_behavior save (caught and logged, not re-thrown).
async function dualWriteLegacyAiConfig(supabase, clientId, { reply_tone, default_language, special_instructions }) {
  try {
    const { data: featureRow, error: featureError } = await supabase
      .from("features")
      .select("id")
      .eq("slug", "ai_auto_reply")
      .maybeSingle();
    if (featureError || !featureRow) return;

    const { data: integrationRow, error: integrationError } = await supabase
      .from("client_feature_integrations")
      .select("id, config")
      .eq("client_id", clientId)
      .eq("feature_id", featureRow.id)
      .maybeSingle();
    if (integrationError || !integrationRow) return;

    const mergedConfig = {
      ...(integrationRow.config || {}),
      reply_tone: reply_tone ?? "",
      language: default_language ?? "",
      special_instructions: special_instructions ?? "",
    };

    const { error: updateError } = await supabase
      .from("client_feature_integrations")
      .update({ config: mergedConfig })
      .eq("id", integrationRow.id);
    if (updateError) throw updateError;
  } catch (err) {
    // Never fails the caller's primary save over this — see header comment.
    console.error("client-ai-behavior: legacy config dual-write failed (non-fatal):", { code: err?.code, message: err?.message });
  }
}

async function handleSave(req, res, supabase) {
  const { error, actor } = await resolveActor(supabase, {
    actorUserId: req.body?.actor_user_id,
    requestedClientId: req.body?.client_id,
  });
  if (error) return res.status(error.status).json({ success: false, message: error.message });
  if (!actor.canWrite) return res.status(403).json({ success: false, message: "Forbidden" });

  const forbiddenRulesCheck = normalizeForbiddenRules(req.body?.forbidden_rules);
  if (!forbiddenRulesCheck.ok) {
    return res.status(400).json({ success: false, message: "forbidden_rules يجب أن تكون قائمة نصوص" });
  }

  const payload = {
    client_id: actor.clientId,
    personality: normalizeText(req.body?.personality),
    reply_tone: normalizeText(req.body?.reply_tone),
    default_language: normalizeText(req.body?.default_language),
    special_instructions: normalizeText(req.body?.special_instructions),
    booking_instructions: normalizeText(req.body?.booking_instructions),
    escalation_instructions: normalizeText(req.body?.escalation_instructions),
    forbidden_rules: forbiddenRulesCheck.provided ? forbiddenRulesCheck.value : [],
    updated_at: new Date().toISOString(),
  };

  try {
    const { data, error: upsertError } = await supabase
      .from("client_ai_behavior")
      .upsert(payload, { onConflict: "client_id" })
      .select(BEHAVIOR_SELECT_COLUMNS)
      .single();

    if (upsertError) throw upsertError;

    // Best-effort, non-fatal — see the function's own header comment.
    // Awaited so a caller reloading immediately after save sees
    // consistent state, but its failure never affects this response.
    await dualWriteLegacyAiConfig(supabase, actor.clientId, {
      reply_tone: data.reply_tone,
      default_language: data.default_language,
      special_instructions: data.special_instructions,
    });

    return res.status(200).json({ success: true, behavior: data });
  } catch (err) {
    console.error("client-ai-behavior: failed to save:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في حفظ إعدادات سلوك الذكاء الاصطناعي" });
  }
}

export async function handleClientAiBehavior(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") return handleGet(req, res, supabase);
  if (req.method === "POST") return handleSave(req, res, supabase);

  return res.status(405).json({ success: false, message: "Method not allowed" });
}
