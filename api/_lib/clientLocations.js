import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";

// AI Engine V1 — Business Voice + Authoritative Locations: client_locations
// CRUD + the client-level locations_list_complete flag.
//
// client_locations has RLS enabled with zero policies (see the
// accompanying migration) — the browser's anon-keyed Supabase client
// cannot read or write it at all, by design (same convention as
// client_ai_behavior/client_knowledge_documents). This module is the
// only path to it. Never query client_locations directly from
// React/browser Supabase code.
//
// Dual-actor authorization — same MODEL as api/_lib/clientAiBehavior.js
// (not the same exported function; scoped to this file, matching this
// repo's established precedent of mirroring the ~30-line pattern per
// domain rather than importing across files):
//   - admin (users.role === 'admin'): may act on ANY client_id, supplied
//     explicitly and existence-checked, never trusted beyond that.
//   - client (users.role === 'client', active client_users membership):
//     client_id is ALWAYS actor.membership.client_id, server-derived,
//     never accepted from the request. Requires the SETTINGS permission
//     for both read and write — this is business-profile data (business
//     name/address/phone/hours), the same domain ClientSettings.jsx
//     already edits directly against `clients`, not an AI-specific
//     setting — so, unlike client_ai_behavior, there is no additional
//     plan.allow_self_edit gate here; SETTINGS access is sufficient,
//     matching ClientSettings.jsx's own existing behavior.
//
// Every mutation is scoped by BOTH client_id AND the target location_id
// in its own WHERE clause (not just an earlier read) — matches this
// repo's established ownership-in-the-WHERE-clause discipline. A wrong/
// foreign location_id therefore always resolves to a real 404, never a
// silent no-op or another client's row.
//
// Shape:
//   GET  /api/client-router?resource=locations&actor_user_id=&client_id=
//     -> { success: true, locations: [...], locations_list_complete: bool, can_edit: bool }
//   POST /api/client-router?resource=locations
//     { action: "add" | "update" | "set_primary" | "set_active" | "delete" | "set_list_complete",
//       actor_user_id, client_id?, ... action-specific fields }

const LOCATION_SELECT_COLUMNS = "id, client_id, name, address, city, phone, working_hours, is_primary, is_active, created_at, updated_at";

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
    if (!clientId) return { error: { status: 400, message: "client_id is required" } };

    const { data: clientRow, error: clientError } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
    if (clientError) return { error: { status: 500, message: "فشل التحقق من العميل" } };
    if (!clientRow) return { error: { status: 404, message: "العميل غير موجود" } };

    return { actor: { kind: "admin", clientId, canWrite: true } };
  }

  if (userRow.role === "client") {
    const actor = await resolveActingMembership(supabase, actorUserId);
    if (!actor) return { error: { status: 401, message: "Unauthorized" } };
    if (!actorHasPermission(actor.membership, PERMISSIONS.SETTINGS)) {
      return { error: { status: 403, message: "Forbidden" } };
    }
    return { actor: { kind: "client", clientId: actor.membership.client_id, canWrite: true } };
  }

  return { error: { status: 401, message: "Unauthorized" } };
}

async function loadOwnedLocation(supabase, clientId, locationId) {
  const { data, error } = await supabase.from("client_locations").select(LOCATION_SELECT_COLUMNS).eq("id", locationId).eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  return data;
}

function normalizeLocationFields(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const city = typeof body?.city === "string" ? body.city.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  // working_hours: same structured shape as clients.working_hours — not
  // validated in depth here (mirrors clients' own save path, which also
  // doesn't re-validate structure server-side beyond what the client UI
  // already enforces) — stored as-is, or null if not a plain object.
  const workingHours = body?.working_hours && typeof body.working_hours === "object" ? body.working_hours : null;
  return { name: name || null, address, city: city || null, phone: phone || null, working_hours: workingHours };
}

async function handleList(req, res, supabase) {
  const { error, actor } = await resolveActor(supabase, { actorUserId: req.query?.actor_user_id, requestedClientId: req.query?.client_id });
  if (error) return res.status(error.status).json({ success: false, message: error.message });

  try {
    const [{ data: locations, error: locationsError }, { data: clientRow, error: clientError }] = await Promise.all([
      supabase.from("client_locations").select(LOCATION_SELECT_COLUMNS).eq("client_id", actor.clientId).order("is_primary", { ascending: false }).order("created_at", { ascending: true }),
      supabase.from("clients").select("locations_list_complete").eq("id", actor.clientId).maybeSingle(),
    ]);
    if (locationsError) throw locationsError;
    if (clientError) throw clientError;

    return res.status(200).json({
      success: true,
      locations: locations || [],
      locations_list_complete: clientRow?.locations_list_complete === true,
      can_edit: actor.canWrite,
    });
  } catch (err) {
    console.error("clientLocations: failed to list:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في تحميل الفروع" });
  }
}

async function handleAdd(req, res, supabase, actor) {
  const { name, address, city, phone, working_hours } = normalizeLocationFields(req.body);
  if (!address) {
    return res.status(400).json({ success: false, message: "العنوان مطلوب" });
  }
  const isPrimary = req.body?.is_primary === true;

  try {
    // A new primary displaces any existing one — see handleSetPrimary's
    // own comment for why this is two statements, not one transaction.
    if (isPrimary) {
      const { error: clearError } = await supabase.from("client_locations").update({ is_primary: false }).eq("client_id", actor.clientId).eq("is_primary", true);
      if (clearError) throw clearError;
    }

    const { data, error } = await supabase
      .from("client_locations")
      .insert({ client_id: actor.clientId, name, address, city, phone, working_hours, is_primary: isPrimary, is_active: true })
      .select(LOCATION_SELECT_COLUMNS)
      .single();
    if (error) throw error;

    return res.status(200).json({ success: true, location: data });
  } catch (err) {
    console.error("clientLocations: failed to add:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في إضافة الفرع" });
  }
}

async function handleUpdate(req, res, supabase, actor) {
  const locationId = req.body?.location_id;
  if (!locationId) return res.status(400).json({ success: false, message: "location_id is required" });

  const existing = await loadOwnedLocation(supabase, actor.clientId, locationId);
  if (!existing) return res.status(404).json({ success: false, message: "الفرع غير موجود ضمن هذا الحساب" });

  const { name, address, city, phone, working_hours } = normalizeLocationFields(req.body);
  if (!address) {
    return res.status(400).json({ success: false, message: "العنوان مطلوب" });
  }

  try {
    const { data, error } = await supabase
      .from("client_locations")
      .update({ name, address, city, phone, working_hours, updated_at: new Date().toISOString() })
      .eq("id", locationId)
      .eq("client_id", actor.clientId)
      .select(LOCATION_SELECT_COLUMNS)
      .single();
    if (error) throw error;

    return res.status(200).json({ success: true, location: data });
  } catch (err) {
    console.error("clientLocations: failed to update:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في تحديث الفرع" });
  }
}

// Displaces any existing primary first, THEN sets the new one — two
// statements, not one atomic transaction (this app has no existing
// multi-statement-transaction RPC convention to reuse for a
// low-frequency settings action). A theoretical concurrent double-click
// race is a known, accepted limitation — same class of documented,
// non-critical race already accepted elsewhere in this codebase (see
// resolveActingMembership's own actor_user_id trust note) — never a
// correctness or tenant-isolation risk, only a possible "which one ended
// up primary" ambiguity under simultaneous requests.
async function handleSetPrimary(req, res, supabase, actor) {
  const locationId = req.body?.location_id;
  if (!locationId) return res.status(400).json({ success: false, message: "location_id is required" });

  const existing = await loadOwnedLocation(supabase, actor.clientId, locationId);
  if (!existing) return res.status(404).json({ success: false, message: "الفرع غير موجود ضمن هذا الحساب" });
  if (!existing.is_active) {
    return res.status(400).json({ success: false, message: "لا يمكن جعل فرع غير مفعّل رئيسياً" });
  }

  try {
    const { error: clearError } = await supabase.from("client_locations").update({ is_primary: false }).eq("client_id", actor.clientId).eq("is_primary", true);
    if (clearError) throw clearError;

    const { data, error } = await supabase
      .from("client_locations")
      .update({ is_primary: true, updated_at: new Date().toISOString() })
      .eq("id", locationId)
      .eq("client_id", actor.clientId)
      .select(LOCATION_SELECT_COLUMNS)
      .single();
    if (error) throw error;

    return res.status(200).json({ success: true, location: data });
  } catch (err) {
    console.error("clientLocations: failed to set primary:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في تعيين الفرع الرئيسي" });
  }
}

// Deactivating the current primary does NOT auto-reassign primary to
// another row — see the migration's own comment. The (now-inactive)
// primary flag stays as-is until a client explicitly picks a new one.
async function handleSetActive(req, res, supabase, actor) {
  const locationId = req.body?.location_id;
  const isActive = req.body?.is_active === true;
  if (!locationId) return res.status(400).json({ success: false, message: "location_id is required" });

  const existing = await loadOwnedLocation(supabase, actor.clientId, locationId);
  if (!existing) return res.status(404).json({ success: false, message: "الفرع غير موجود ضمن هذا الحساب" });

  try {
    const { data, error } = await supabase
      .from("client_locations")
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq("id", locationId)
      .eq("client_id", actor.clientId)
      .select(LOCATION_SELECT_COLUMNS)
      .single();
    if (error) throw error;

    return res.status(200).json({ success: true, location: data });
  } catch (err) {
    console.error("clientLocations: failed to set active:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في تحديث حالة الفرع" });
  }
}

async function handleDelete(req, res, supabase, actor) {
  const locationId = req.body?.location_id;
  if (!locationId) return res.status(400).json({ success: false, message: "location_id is required" });

  const existing = await loadOwnedLocation(supabase, actor.clientId, locationId);
  if (!existing) return res.status(404).json({ success: false, message: "الفرع غير موجود ضمن هذا الحساب" });

  try {
    // Ownership enforced directly in the DELETE's own WHERE clause, not
    // just the earlier read.
    const { error } = await supabase.from("client_locations").delete().eq("id", locationId).eq("client_id", actor.clientId);
    if (error) throw error;

    return res.status(200).json({ success: true, deleted_id: locationId });
  } catch (err) {
    console.error("clientLocations: failed to delete:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في حذف الفرع" });
  }
}

// Client-level, not per-row — see the migration's own header comment for
// why completeness is modeled on `clients`, not `client_locations`.
async function handleSetListComplete(req, res, supabase, actor) {
  const isComplete = req.body?.is_complete === true;

  try {
    const { error } = await supabase.from("clients").update({ locations_list_complete: isComplete }).eq("id", actor.clientId);
    if (error) throw error;

    return res.status(200).json({ success: true, locations_list_complete: isComplete });
  } catch (err) {
    console.error("clientLocations: failed to set list-complete flag:", { code: err?.code, message: err?.message });
    return res.status(500).json({ success: false, message: "فشل في تحديث حالة اكتمال قائمة الفروع" });
  }
}

export async function handleClientLocations(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") return handleList(req, res, supabase);

  if (req.method !== "POST") return res.status(405).json({ success: false, message: "Method not allowed" });

  const { error, actor } = await resolveActor(supabase, { actorUserId: req.body?.actor_user_id, requestedClientId: req.body?.client_id });
  if (error) return res.status(error.status).json({ success: false, message: error.message });
  if (!actor.canWrite) return res.status(403).json({ success: false, message: "Forbidden" });

  const action = req.body?.action;

  if (action === "add") return handleAdd(req, res, supabase, actor);
  if (action === "update") return handleUpdate(req, res, supabase, actor);
  if (action === "set_primary") return handleSetPrimary(req, res, supabase, actor);
  if (action === "set_active") return handleSetActive(req, res, supabase, actor);
  if (action === "delete") return handleDelete(req, res, supabase, actor);
  if (action === "set_list_complete") return handleSetListComplete(req, res, supabase, actor);

  return res.status(400).json({ success: false, message: "Unknown action" });
}
