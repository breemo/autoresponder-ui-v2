// Centralized role → permission map for the Client Portal.
//
// Single source of truth for what each client_users.role can do, imported
// by both the frontend (nav filtering, route protection) and server-side
// API routes (api/client-users.js, api/change-password.js) — no scattered
// `role === "owner"` checks anywhere else.

export const ROLES = ["owner", "agent", "it"];

export const ROLE_LABELS = {
  owner: "مالك",
  agent: "موظف",
  it: "تقني",
};

// Exactly 8 functional-area permissions — deliberately not split into
// view/manage sub-permissions per area.
export const PERMISSIONS = {
  DASHBOARD: "dashboard",
  INBOX: "inbox",
  LEADS: "leads",
  AUTO_REPLIES: "auto_replies",
  INTEGRATIONS: "integrations",
  AI_SETTINGS: "ai_settings",
  TEAM_MANAGEMENT: "team_management",
  SETTINGS: "settings",
};

export const PERMISSION_LABELS = {
  [PERMISSIONS.DASHBOARD]: "لوحة التحكم",
  [PERMISSIONS.INBOX]: "صندوق الوارد",
  [PERMISSIONS.LEADS]: "العملاء المحتملون",
  [PERMISSIONS.AUTO_REPLIES]: "الردود التلقائية",
  [PERMISSIONS.INTEGRATIONS]: "التكاملات",
  [PERMISSIONS.AI_SETTINGS]: "إعدادات الذكاء الاصطناعي",
  [PERMISSIONS.TEAM_MANAGEMENT]: "إدارة الفريق",
  [PERMISSIONS.SETTINGS]: "إعدادات الحساب",
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);
const ALL_PERMISSIONS_SET = new Set(ALL_PERMISSIONS);

// Role → default permission set.
export const ROLE_PERMISSIONS = {
  owner: ALL_PERMISSIONS,
  agent: [
    PERMISSIONS.DASHBOARD,
    PERMISSIONS.INBOX,
    PERMISSIONS.LEADS,
    PERMISSIONS.AUTO_REPLIES,
  ],
  it: [
    PERMISSIONS.DASHBOARD,
    PERMISSIONS.INTEGRATIONS,
    PERMISSIONS.AI_SETTINGS,
    PERMISSIONS.SETTINGS,
  ],
};

export function getRoleDefaults(role) {
  return ROLE_PERMISSIONS[role] || [];
}

// permissions_overrides shape (client_users.permissions_overrides, nullable
// jsonb): a flat map of permission key -> boolean.
//   { "leads": true }      grants leads even if the role default doesn't include it
//   { "auto_replies": false } revokes auto_replies even if the role default includes it
// Any key not present in the object falls back to the role default. This is
// intentionally the entire merge rule — no precedence layers, no wildcards.
//
// Owner safety floor: an owner can never lose team_management, even via a
// bad/malicious override — otherwise a single-owner account could be
// permanently locked out of its own team management with no one able to
// undo it. This is enforced here (not just at the API layer) so it holds
// regardless of how the override data got written.
export function resolvePermissions(role, overrides) {
  const base = new Set(getRoleDefaults(role));

  if (overrides && typeof overrides === "object") {
    for (const [key, value] of Object.entries(overrides)) {
      if (!ALL_PERMISSIONS_SET.has(key)) continue; // ignore unknown/stale keys defensively
      if (value === true) base.add(key);
      else if (value === false) base.delete(key);
    }
  }

  if (role === "owner") base.add(PERMISSIONS.TEAM_MANAGEMENT);

  return base;
}

export function hasPermission(role, overrides, permission) {
  return resolvePermissions(role, overrides).has(permission);
}

// Convenience for call sites that already have the AuthContext user object
// (client_role / is_active / permissions_overrides, set at login by
// Login.jsx from the client_users membership row).
export function hasUserPermission(user, permission) {
  if (!user || user.role !== "client") return false;
  if (user.is_active === false) return false;
  return hasPermission(user.client_role, user.permissions_overrides, permission);
}

// Reduces a desired *effective* permission set (what the owner checked in
// the UI) down to only the keys that differ from the role's defaults, for
// storage in permissions_overrides. Keeps the stored override object
// minimal instead of always writing all 8 keys.
export function computeOverridesDiff(role, selectedPermissions) {
  const defaults = new Set(getRoleDefaults(role));
  const selected = new Set((selectedPermissions || []).filter((key) => ALL_PERMISSIONS_SET.has(key)));
  const diff = {};

  for (const key of ALL_PERMISSIONS) {
    const inDefault = defaults.has(key);
    const inSelected = selected.has(key);
    if (inDefault && !inSelected) diff[key] = false;
    else if (!inDefault && inSelected) diff[key] = true;
  }

  return diff;
}
