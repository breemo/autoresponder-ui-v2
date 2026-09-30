import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";
import { REPLY_MODE_VALUES, DEFAULT_REPLY_MODE } from "../../src/lib/replyMode.js";

// Multi-Account Stage 2B — Facebook Page account CRUD.
//
// client_facebook has RLS enabled with zero policies (Stage 1) — the
// browser's anon-keyed Supabase client cannot read or write it at all,
// by design. This endpoint is the only path to it:
//   browser (FacebookAccountsSection.jsx) -> this endpoint (service-role
//   Supabase client) -> client_facebook.
// Never query client_facebook directly from React/browser Supabase code.
//
// Authorization: identical convention to every other endpoint in this
// app (api/create-whatsapp-instance.js, api/client-integrations.js) —
// only actor_user_id is ever trusted from the request; client_id, role,
// is_active, and INTEGRATIONS permission are all re-derived server-side
// via resolveActingMembership()/actorHasPermission(). Every operation is
// scoped to actor.membership.client_id, never a client_id sent by the
// browser. UPDATE/SET_ACTIVE/DELETE additionally require the target row's
// OWN client_id to match — enforced directly in each query's WHERE
// clause (not just an earlier read), matching this repo's established
// ownership-in-the-WHERE-clause discipline (see
// apply_conversation_lifecycle_action's header comment for the identical
// reasoning).
//
// Credential handling (page_access_token) — HARD REQUIREMENTS enforced
// throughout this file, not just documented:
//   - LIST/read responses NEVER include page_access_token. toSafeAccount()
//     below is the single chokepoint every response shape passes through;
//     it destructures the token out and replaces it with a derived
//     has_page_access_token boolean.
//   - CREATE accepts page_access_token normally (first time being set),
//     via the atomic create_client_facebook_account RPC (see below) —
//     stored exactly as submitted, never trimmed/altered (only a trimmed
//     copy is used to detect a purely-whitespace non-submission; the
//     stored value is always the raw string).
//   - UPDATE: an empty/omitted page_access_token means "preserve the
//     existing value" (the column is simply left out of the UPDATE's SET
//     list); a non-empty value means "replace it" with the raw submitted
//     string, same no-silent-alteration rule as CREATE. Never re-read and
//     never echo back the token on any response.
//   - Never logged: every console.error below explicitly logs a
//     hand-picked diagnostic object, never req.body or the row itself, so
//     a token can never end up in server logs by accident.
//   - Never returned in an error response: every error path returns a
//     fixed, translated message string, never raw row/request data.
//
// Plan-limit enforcement (CREATE only): atomic, via the
// create_client_facebook_account Postgres RPC (supabase/migrations/
// 20260826_client_facebook_atomic_create.sql) — the limit check and the
// INSERT happen inside one transaction, serialized per client_id via an
// advisory lock, closing the COUNT-then-INSERT race a plain two-step
// Supabase-js implementation cannot avoid. See that migration's own
// header comment for the full design rationale.
//
// Vercel Hobby Function-count consolidation: this file was formerly the
// top-level api/client-facebook.js, now dispatched from
// api/client-integrations.js (?resource=facebook) instead of being its own
// deployed Vercel Function. Behavior, authorization, validation, credential
// handling, and every response are completely unchanged — only the public
// URL changed (FacebookAccountsSection.jsx updated accordingly).
//
// Shape:
//   GET  /api/client-integrations?resource=facebook&actor_user_id=
//     -> { success: true, accounts: [...safe...], plan_limit: number|null }
//   POST /api/client-integrations?resource=facebook
//     { action: "create" | "update" | "set_active" | "delete",
//       actor_user_id, id?, display_name?, page_id?, channel_key?,
//       page_access_token?, reply_mode?, is_active? }

function toSafeAccount(row) {
  if (!row) return row;
  const { page_access_token, ...rest } = row;
  return { ...rest, has_page_access_token: !!(page_access_token && page_access_token.trim()) };
}

// Column list for every SELECT against client_facebook. NOT itself the
// safety mechanism (pre-migration audit finding — the name previously
// implied it was) — it deliberately INCLUDES page_access_token, because
// the server needs the real value in memory to compute
// has_page_access_token. The actual credential-safety chokepoint is
// toSafeAccount() below, which strips it before any response is ever
// built. Never pass this constant's result to res.json() directly.
const ACCOUNT_SELECT_COLUMNS =
  "id, client_id, display_name, page_id, channel_key, is_active, reply_mode, connection_status, created_at, updated_at, page_access_token";

async function requireActor(req, res, supabase, actorUserId) {
  const actor = await resolveActingMembership(supabase, actorUserId);
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

// null = unlimited, matching every existing limit-column convention in
// this schema (plans.integrations_limit, plan_features.max_connections,
// and every plans.*_accounts_limit column). Deliberately reads
// plans.facebook_accounts_limit only — never plans.integrations_limit,
// never plan_features.max_connections (both explicitly out of scope for
// this limit per instruction).
//
// DEFERRED (pre-migration audit finding, not changed here): a client
// with no plan_id (clientRow?.plan_id falsy) is treated as unlimited,
// identical to the existing convention already live in
// api/client-integrations.js's checkConnectionLimit and
// api/create-whatsapp-instance.js's own limit check. Whether "no plan"
// should instead deny new accounts (a stricter SaaS-entitlement read) is
// a real, open product question — but it must be decided ONCE and
// applied consistently across every channel, not special-cased for
// Facebook alone here, which would only make behavior inconsistent
// across channels for the identical condition. Left unchanged per
// explicit instruction; tracked for a separate, cross-channel
// entitlement-hardening stage.
async function getFacebookAccountsLimit(supabase, clientId) {
  const { data: clientRow, error: clientError } = await supabase
    .from("clients")
    .select("plan_id")
    .eq("id", clientId)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!clientRow?.plan_id) return null;

  const { data: planRow, error: planError } = await supabase
    .from("plans")
    .select("facebook_accounts_limit")
    .eq("id", clientRow.plan_id)
    .maybeSingle();
  if (planError) throw planError;

  return planRow?.facebook_accounts_limit ?? null;
}

// Loads a client_facebook row scoped to the actor's own client_id — this
// scoping is the actual multi-tenant/ownership boundary for update/
// set_active/delete, re-checked here rather than trusted from an earlier
// read.
async function loadOwnedAccount(supabase, clientId, accountId) {
  const { data, error } = await supabase
    .from("client_facebook")
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq("id", accountId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function normalizeChannelKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizePageId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Strict is_active validation, shared by create/update/set_active —
// pre-migration audit fix. Never coerces a truthy-but-wrong type (e.g.
// the JS-truthy string "false") into `true` the way `!!value` used to.
//   required=false (create/update): omitted/null means "not provided" —
//     the caller decides the default (create) or preserves the existing
//     value (update). A provided value must be a real boolean or this
//     rejects with { ok: false }.
//   required=true (set_active): the whole point of this action is to set
//     is_active, so omitted/null is itself invalid, not "use a default".
function validateIsActive(value, { required }) {
  if (value === undefined || value === null) {
    return required ? { ok: false } : { ok: true, provided: false };
  }
  if (typeof value !== "boolean") return { ok: false };
  return { ok: true, provided: true, value };
}

const IS_ACTIVE_TYPE_ERROR = { success: false, message: "is_active يجب أن يكون true أو false" };

// Postgres error codes this endpoint knows how to translate into a
// friendly message. Anything else falls through to a generic failure —
// never the raw error text (which could, in principle, echo back
// constraint/column details unrelated to credentials, but is avoided
// uniformly here as a matter of consistent style with the rest of this
// app's API layer).
function friendlyDbErrorMessage(error, fallback) {
  if (error?.code === "23505") return "channel_key مستخدم بالفعل ضمن حساباتك";
  if (error?.code === "23514") return "بيانات غير صالحة (تحقق من channel_key أو page_id أو reply_mode)";
  return fallback;
}

async function handleList(req, res, supabase, actor) {
  const clientId = actor.membership.client_id;

  try {
    const [{ data: rows, error: rowsError }, limit] = await Promise.all([
      supabase
        .from("client_facebook")
        .select(ACCOUNT_SELECT_COLUMNS)
        .eq("client_id", clientId)
        .order("created_at", { ascending: true }),
      getFacebookAccountsLimit(supabase, clientId),
    ]);

    if (rowsError) throw rowsError;

    return res.status(200).json({
      success: true,
      accounts: (rows || []).map(toSafeAccount),
      plan_limit: limit,
    });
  } catch (error) {
    console.error("client-facebook: failed to list accounts:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "فشل في تحميل حسابات فيسبوك" });
  }
}

async function handleCreate(req, res, supabase, actor) {
  const clientId = actor.membership.client_id;

  const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  if (!displayName) {
    return res.status(400).json({ success: false, message: "يرجى إدخال اسم الصفحة" });
  }

  let replyMode = DEFAULT_REPLY_MODE;
  if (req.body?.reply_mode !== undefined && req.body?.reply_mode !== null && req.body?.reply_mode !== "") {
    if (!REPLY_MODE_VALUES.includes(req.body.reply_mode)) {
      return res.status(400).json({ success: false, message: "قيمة reply_mode غير صالحة" });
    }
    replyMode = req.body.reply_mode;
  }

  const isActiveCheck = validateIsActive(req.body?.is_active, { required: false });
  if (!isActiveCheck.ok) {
    return res.status(400).json(IS_ACTIVE_TYPE_ERROR);
  }
  const isActive = isActiveCheck.provided ? isActiveCheck.value : true; // default when omitted
  const channelKey = normalizeChannelKey(req.body?.channel_key);
  const pageId = normalizePageId(req.body?.page_id);
  // Presence is decided via a trimmed check (so a purely-whitespace
  // submission is correctly treated as "nothing entered"), but the
  // STORED value is the raw, un-trimmed string exactly as submitted —
  // pre-migration-fix-pass finding: silently trimming a credential is
  // not appropriate without a strong reason, unlike page_id/channel_key
  // (plain identifiers, safe to normalize).
  const pageAccessTokenRaw = typeof req.body?.page_access_token === "string" ? req.body.page_access_token : "";
  const pageAccessToken = pageAccessTokenRaw.trim() !== "" ? pageAccessTokenRaw : null;

  try {
    // Atomic, race-safe: create_client_facebook_account (see
    // supabase/migrations/20260826_client_facebook_atomic_create.sql)
    // performs the plans.facebook_accounts_limit check and the INSERT
    // inside one Postgres transaction, serialized per client_id via an
    // advisory lock — closes the COUNT-then-INSERT race the original
    // implementation had. client_id is still fully server-derived above
    // (actor.membership.client_id) and passed as p_client_id; this RPC
    // performs zero authorization of its own, matching
    // apply_conversation_lifecycle_action's own established convention.
    const { data: rows, error: rpcError } = await supabase.rpc("create_client_facebook_account", {
      p_client_id: clientId,
      p_display_name: displayName,
      p_page_id: pageId,
      p_channel_key: channelKey,
      p_page_access_token: pageAccessToken,
      p_reply_mode: replyMode,
      p_is_active: isActive,
    });

    if (rpcError) {
      return res.status(409).json({ success: false, message: friendlyDbErrorMessage(rpcError, "فشل في إضافة صفحة فيسبوك") });
    }

    const result = rows?.[0];

    if (!result || result.outcome === "limit_reached") {
      return res.status(409).json({
        success: false,
        message: `وصلت للحد الأقصى المسموح لحسابات فيسبوك ضمن خطتك (${result?.plan_limit})`,
      });
    }

    // Strip the RPC-only outcome/plan_limit fields before shaping the
    // response — keeps the returned `account` object's shape identical
    // to update/set_active's, not leaking internal RPC bookkeeping.
    const { outcome, plan_limit, ...accountRow } = result;
    return res.status(200).json({ success: true, account: toSafeAccount(accountRow) });
  } catch (error) {
    console.error("client-facebook: failed to create account:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "فشل في إضافة صفحة فيسبوك" });
  }
}

async function handleUpdate(req, res, supabase, actor) {
  const clientId = actor.membership.client_id;
  const accountId = req.body?.id;

  if (!accountId) {
    return res.status(400).json({ success: false, message: "id is required" });
  }

  const existing = await loadOwnedAccount(supabase, clientId, accountId);
  if (!existing) {
    return res.status(404).json({ success: false, message: "الحساب غير موجود ضمن هذا العميل" });
  }

  const payload = {};

  if (req.body?.display_name !== undefined) {
    const displayName = typeof req.body.display_name === "string" ? req.body.display_name.trim() : "";
    if (!displayName) {
      return res.status(400).json({ success: false, message: "اسم الصفحة لا يمكن أن يكون فارغًا" });
    }
    payload.display_name = displayName;
  }

  if (req.body?.page_id !== undefined) {
    payload.page_id = normalizePageId(req.body.page_id);
  }

  if (req.body?.channel_key !== undefined) {
    payload.channel_key = normalizeChannelKey(req.body.channel_key);
  }

  if (req.body?.reply_mode !== undefined && req.body?.reply_mode !== null && req.body?.reply_mode !== "") {
    if (!REPLY_MODE_VALUES.includes(req.body.reply_mode)) {
      return res.status(400).json({ success: false, message: "قيمة reply_mode غير صالحة" });
    }
    payload.reply_mode = req.body.reply_mode;
  }

  const isActiveCheck = validateIsActive(req.body?.is_active, { required: false });
  if (!isActiveCheck.ok) {
    return res.status(400).json(IS_ACTIVE_TYPE_ERROR);
  }
  if (isActiveCheck.provided) {
    payload.is_active = isActiveCheck.value;
  } // else: omitted — preserve the existing stored value, unchanged.

  // Empty/omitted page_access_token means "preserve" — the key is simply
  // never added to payload, so the UPDATE's SET list never touches the
  // existing stored value. Only a genuinely non-empty replacement value
  // is written — and the RAW value, not a trimmed one: trimming is used
  // only to detect a purely-whitespace non-submission, never to alter a
  // real credential's exact bytes (see the identical note in
  // handleCreate).
  if (typeof req.body?.page_access_token === "string" && req.body.page_access_token.trim() !== "") {
    payload.page_access_token = req.body.page_access_token;
  }

  if (Object.keys(payload).length === 0) {
    return res.status(200).json({ success: true, account: toSafeAccount(existing) });
  }

  payload.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from("client_facebook")
      .update(payload)
      .eq("id", accountId)
      .eq("client_id", clientId)
      .select(ACCOUNT_SELECT_COLUMNS)
      .single();

    if (error) {
      return res.status(409).json({ success: false, message: friendlyDbErrorMessage(error, "فشل في تحديث صفحة فيسبوك") });
    }

    return res.status(200).json({ success: true, account: toSafeAccount(data) });
  } catch (error) {
    console.error("client-facebook: failed to update account:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "فشل في تحديث صفحة فيسبوك" });
  }
}

async function handleSetActive(req, res, supabase, actor) {
  const clientId = actor.membership.client_id;
  const accountId = req.body?.id;

  if (!accountId) {
    return res.status(400).json({ success: false, message: "id is required" });
  }

  const isActiveCheck = validateIsActive(req.body?.is_active, { required: true });
  if (!isActiveCheck.ok) {
    return res.status(400).json(IS_ACTIVE_TYPE_ERROR);
  }
  const isActive = isActiveCheck.value;

  try {
    const { data, error } = await supabase
      .from("client_facebook")
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq("id", accountId)
      .eq("client_id", clientId)
      .select(ACCOUNT_SELECT_COLUMNS)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: "الحساب غير موجود ضمن هذا العميل" });
    }

    return res.status(200).json({ success: true, account: toSafeAccount(data) });
  } catch (error) {
    console.error("client-facebook: failed to set active state:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "فشل تحديث حالة التفعيل" });
  }
}

async function handleDelete(req, res, supabase, actor) {
  const clientId = actor.membership.client_id;
  const accountId = req.body?.id;

  if (!accountId) {
    return res.status(400).json({ success: false, message: "id is required" });
  }

  try {
    // Ownership enforced directly in the DELETE's own WHERE clause (not
    // just an earlier read) — .select() confirms whether a row was
    // actually deleted, so a wrong/foreign id gets a real 404 instead of
    // a silent no-op.
    const { data, error } = await supabase
      .from("client_facebook")
      .delete()
      .eq("id", accountId)
      .eq("client_id", clientId)
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: "الحساب غير موجود ضمن هذا العميل" });
    }

    return res.status(200).json({ success: true, deleted_id: data.id });
  } catch (error) {
    console.error("client-facebook: failed to delete account:", { code: error?.code, message: error?.message });
    return res.status(500).json({ success: false, message: "فشل في حذف صفحة فيسبوك" });
  }
}

export async function handleClientFacebook(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") {
    const actor = await requireActor(req, res, supabase, req.query?.actor_user_id);
    if (!actor) return;
    return handleList(req, res, supabase, actor);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const actor = await requireActor(req, res, supabase, req.body?.actor_user_id);
  if (!actor) return;

  const action = req.body?.action;

  if (action === "create") return handleCreate(req, res, supabase, actor);
  if (action === "update") return handleUpdate(req, res, supabase, actor);
  if (action === "set_active") return handleSetActive(req, res, supabase, actor);
  if (action === "delete") return handleDelete(req, res, supabase, actor);

  return res.status(400).json({ success: false, message: "Unknown action" });
}
