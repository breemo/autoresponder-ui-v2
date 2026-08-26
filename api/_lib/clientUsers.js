import crypto from "node:crypto";
import { getSupabaseServerClient } from "./supabaseServer.js";
import {
  resolveActingMembership,
  actorHasPermission,
  countOtherActiveOwners,
} from "./clientAuthz.js";
import { PERMISSIONS, ROLES, computeOverridesDiff, resolvePermissions } from "../../src/lib/permissions.js";

// Client Team Management API.
//
// Vercel Hobby Function-count consolidation: this file was formerly the
// top-level api/client-users.js, dispatched from api/client-router.js
// (?resource=users) instead of being its own deployed Vercel Function —
// see the deployment-failure inspection report. Behavior, auth, and
// response shapes below are completely unchanged; ClientTeam.jsx was
// updated to call the new URL, nothing else changed.
//
// Security model: every request carries `actor_user_id` (the logged-in
// caller's users.id). Nothing else about the caller — role, client_id,
// permissions — is ever trusted from the request body; it is always
// re-derived server-side from client_users via resolveActingMembership().
// Every DB read/write on a *target* user is additionally scoped to
// `client_id = actor's own client_id`, which is what actually prevents
// Client A from touching Client B's team.
//
// Known limitation (documented, not fixed here — see the implementation
// report): this app has no verified session/token, so `actor_user_id`
// itself is still a client-supplied value. Re-deriving role/client_id
// server-side closes the specific gap this feature would otherwise open
// (spoofing role/client_id in the request body); it does not by itself
// prove the caller really is that user_id. Fixing that needs real session
// tokens, which is out of scope for this task.

function generateTempPassword() {
  return crypto.randomBytes(9).toString("base64url"); // ~12 url-safe chars
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// A caller who still has a mandatory temp password pending must fix that
// first (via api/change-password.js) before touching team management —
// this mirrors the route-level gate in App.jsx, enforced here too so it
// isn't just a UI-level restriction.
async function requireActor(req, res, supabase, permission) {
  const actorUserId = req.method === "GET" ? req.query?.actor_user_id : req.body?.actor_user_id;

  const actor = await resolveActingMembership(supabase, actorUserId);
  if (!actor) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }

  if (actor.user.must_change_password) {
    res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
    return null;
  }

  if (!actorHasPermission(actor.membership, permission)) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return null;
  }

  return actor;
}

// Loads a target client_users row, scoped to the actor's own client_id.
// This scoping is the actual multi-tenant boundary: a target that belongs
// to a different client simply won't be found.
async function loadTargetMembership(supabase, clientId, targetUserId) {
  if (!targetUserId) return null;

  const { data, error } = await supabase
    .from("client_users")
    .select("id, user_id, role, is_active, permissions_overrides")
    .eq("client_id", clientId)
    .eq("user_id", targetUserId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

// True if `target` is currently the client's last active owner — used to
// block any change that would leave the client with zero active owners.
async function isLastActiveOwner(supabase, clientId, target) {
  if (target.role !== "owner" || !target.is_active) return false;
  const otherOwners = await countOtherActiveOwners(supabase, clientId, target.user_id);
  return otherOwners === 0;
}

export async function handleClientUsers(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") {
    const actor = await requireActor(req, res, supabase, PERMISSIONS.TEAM_MANAGEMENT);
    if (!actor) return;

    const { data, error } = await supabase
      .from("client_users")
      .select("id, user_id, role, is_active, permissions_overrides, created_at, users(id, name, email, last_login_at)")
      .eq("client_id", actor.membership.client_id)
      .order("created_at", { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, message: "Failed to load team" });
    }

    const members = (data || []).map((row) => ({
      client_user_id: row.id,
      user_id: row.user_id,
      name: row.users?.name || "",
      email: row.users?.email || "",
      role: row.role,
      is_active: row.is_active,
      permissions_overrides: row.permissions_overrides,
      created_at: row.created_at,
      last_login_at: row.users?.last_login_at || null,
    }));

    return res.status(200).json({ success: true, members, actor_user_id: actor.user.id });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const action = req.body?.action;

  if (action === "add_user") {
    const actor = await requireActor(req, res, supabase, PERMISSIONS.TEAM_MANAGEMENT);
    if (!actor) return;

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = normalizeEmail(req.body?.email);
    const role = req.body?.role;
    const requestedPermissions = Array.isArray(req.body?.permissions) ? req.body.permissions : null;

    if (!name || !email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "الاسم والإيميل مطلوبان وبصيغة صحيحة" });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: "دور غير صالح" });
    }

    const overrides = requestedPermissions
      ? computeOverridesDiff(role, requestedPermissions)
      : null;

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUserError) {
      return res.status(500).json({ success: false, message: "فشل التحقق من الإيميل" });
    }
    if (existingUser) {
      return res.status(409).json({ success: false, message: "هذا الإيميل مستخدم بالفعل" });
    }

    const tempPassword = generateTempPassword();

    const { data: newUser, error: userError } = await supabase
      .from("users")
      .insert([{ email, name, role: "client", password: tempPassword, must_change_password: true }])
      .select("id, name, email")
      .single();

    if (userError || !newUser) {
      return res.status(500).json({ success: false, message: "فشل إنشاء المستخدم" });
    }

    const { data: membershipRow, error: linkError } = await supabase
      .from("client_users")
      .insert([{
        client_id: actor.membership.client_id,
        user_id: newUser.id,
        role,
        is_active: true,
        permissions_overrides: overrides && Object.keys(overrides).length > 0 ? overrides : null,
      }])
      .select("id, role, is_active, permissions_overrides, created_at")
      .single();

    if (linkError || !membershipRow) {
      // Best-effort cleanup so a failed add doesn't leave an orphaned,
      // unusable users row (and doesn't block the email from being reused).
      await supabase.from("users").delete().eq("id", newUser.id);
      return res.status(500).json({ success: false, message: "فشل ربط المستخدم بالعميل" });
    }

    return res.status(200).json({
      success: true,
      member: {
        client_user_id: membershipRow.id,
        user_id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: membershipRow.role,
        is_active: membershipRow.is_active,
        permissions_overrides: membershipRow.permissions_overrides,
        created_at: membershipRow.created_at,
      },
      temp_password: tempPassword,
    });
  }

  if (action === "reset_password") {
    const actor = await requireActor(req, res, supabase, PERMISSIONS.TEAM_MANAGEMENT);
    if (!actor) return;

    const targetUserId = req.body?.target_user_id;

    const target = await loadTargetMembership(supabase, actor.membership.client_id, targetUserId);
    if (!target) return res.status(404).json({ success: false, message: "المستخدم غير موجود في هذا الفريق" });

    if (target.is_active === false) {
      return res.status(400).json({ success: false, message: "المستخدم موقوف، فعّله أولاً" });
    }

    const tempPassword = generateTempPassword();

    const { error } = await supabase
      .from("users")
      .update({ password: tempPassword, must_change_password: true })
      .eq("id", targetUserId);

    if (error) {
      return res.status(500).json({ success: false, message: "فشل إعادة تعيين كلمة المرور" });
    }

    return res.status(200).json({ success: true, temp_password: tempPassword });
  }

  if (action === "change_role") {
    const actor = await requireActor(req, res, supabase, PERMISSIONS.TEAM_MANAGEMENT);
    if (!actor) return;

    const targetUserId = req.body?.target_user_id;
    const newRole = req.body?.role;

    if (!ROLES.includes(newRole)) {
      return res.status(400).json({ success: false, message: "دور غير صالح" });
    }

    const target = await loadTargetMembership(supabase, actor.membership.client_id, targetUserId);
    if (!target) return res.status(404).json({ success: false, message: "المستخدم غير موجود في هذا الفريق" });

    if (newRole !== "owner" && (await isLastActiveOwner(supabase, actor.membership.client_id, target))) {
      return res.status(409).json({ success: false, message: "لا يمكن تغيير دور آخر مالك نشط في الحساب" });
    }

    const { error } = await supabase.from("client_users").update({ role: newRole }).eq("id", target.id);
    if (error) {
      return res.status(500).json({ success: false, message: "فشل تحديث الدور" });
    }

    return res.status(200).json({ success: true });
  }

  if (action === "change_permissions") {
    const actor = await requireActor(req, res, supabase, PERMISSIONS.TEAM_MANAGEMENT);
    if (!actor) return;

    const targetUserId = req.body?.target_user_id;
    const requestedPermissions = Array.isArray(req.body?.permissions) ? req.body.permissions : null;

    if (!requestedPermissions) {
      return res.status(400).json({ success: false, message: "قائمة الصلاحيات مطلوبة" });
    }

    const target = await loadTargetMembership(supabase, actor.membership.client_id, targetUserId);
    if (!target) return res.status(404).json({ success: false, message: "المستخدم غير موجود في هذا الفريق" });

    // Owner safety: never let an override strip an active owner's ability
    // to manage the team — resolvePermissions() also enforces this floor
    // unconditionally, but rejecting it here gives a clear error instead of
    // silently ignoring the owner's unchecked box.
    if (target.role === "owner" && !requestedPermissions.includes(PERMISSIONS.TEAM_MANAGEMENT)) {
      return res.status(409).json({ success: false, message: "لا يمكن إزالة صلاحية إدارة الفريق من المالك" });
    }

    const overrides = computeOverridesDiff(target.role, requestedPermissions);

    const { error } = await supabase
      .from("client_users")
      .update({ permissions_overrides: Object.keys(overrides).length > 0 ? overrides : null })
      .eq("id", target.id);

    if (error) {
      return res.status(500).json({ success: false, message: "فشل تحديث الصلاحيات" });
    }

    return res.status(200).json({
      success: true,
      effective_permissions: Array.from(resolvePermissions(target.role, overrides)),
    });
  }

  if (action === "set_active") {
    const actor = await requireActor(req, res, supabase, PERMISSIONS.TEAM_MANAGEMENT);
    if (!actor) return;

    const targetUserId = req.body?.target_user_id;
    const isActive = req.body?.is_active === true;

    const target = await loadTargetMembership(supabase, actor.membership.client_id, targetUserId);
    if (!target) return res.status(404).json({ success: false, message: "المستخدم غير موجود في هذا الفريق" });

    if (!isActive && (await isLastActiveOwner(supabase, actor.membership.client_id, target))) {
      return res.status(409).json({ success: false, message: "لا يمكن إيقاف آخر مالك نشط في الحساب" });
    }

    const { error } = await supabase.from("client_users").update({ is_active: isActive }).eq("id", target.id);
    if (error) {
      return res.status(500).json({ success: false, message: "فشل تحديث حالة المستخدم" });
    }

    return res.status(200).json({ success: true });
  }

  if (action === "remove") {
    const actor = await requireActor(req, res, supabase, PERMISSIONS.TEAM_MANAGEMENT);
    if (!actor) return;

    const targetUserId = req.body?.target_user_id;

    const target = await loadTargetMembership(supabase, actor.membership.client_id, targetUserId);
    if (!target) return res.status(404).json({ success: false, message: "المستخدم غير موجود في هذا الفريق" });

    if (await isLastActiveOwner(supabase, actor.membership.client_id, target)) {
      return res.status(409).json({ success: false, message: "لا يمكن حذف آخر مالك نشط في الحساب" });
    }

    // Deliberately unlinks the membership only — the users row itself is
    // preserved (not deleted). Nothing else in this schema references
    // users.id historically, but keeping the row avoids destroying account
    // history for an audit trail, and a hard-deleted users row plus its
    // orphaned references is the kind of thing this task explicitly asked
    // to avoid. The trade-off: this user's email stays reserved and can't
    // be reused for a new invite unless they're re-added to a client later.
    const { error } = await supabase.from("client_users").delete().eq("id", target.id);
    if (error) {
      return res.status(500).json({ success: false, message: "فشل حذف المستخدم من الفريق" });
    }

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false, message: "Unknown action" });
}
