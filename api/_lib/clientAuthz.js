import { hasPermission } from "../../src/lib/permissions.js";

// Resolves the acting user's client membership strictly server-side.
// Only `actor_user_id` is ever trusted from the request — role and
// client_id are always re-read from the database here, never taken from
// the request body. Returns null if the id doesn't resolve to an active
// client_users membership.
export async function resolveActingMembership(supabase, actorUserId) {
  if (!actorUserId) return null;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, email, name, role, must_change_password")
    .eq("id", actorUserId)
    .maybeSingle();

  if (userError || !user || user.role !== "client") return null;

  const { data: membership, error: membershipError } = await supabase
    .from("client_users")
    .select("id, client_id, role, is_active, permissions_overrides")
    .eq("user_id", actorUserId)
    .maybeSingle();

  if (membershipError || !membership) return null;

  return { user, membership };
}

// Resolves the acting user as a PLATFORM ADMIN, strictly server-side.
// Same trust model as resolveActingMembership: only `actor_user_id` is
// trusted from the request; `role` is always re-read from the database
// here. Platform admin = users.role === "admin" (the same check
// src/App.jsx's <AdminRoute> makes client-side). Returns the user row or
// null. Used by admin-only, tenant-agnostic endpoints (e.g. platform
// system settings) that have no client_users membership to resolve.
export async function resolveActingAdmin(supabase, actorUserId) {
  if (!actorUserId) return null;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, email, name, role, must_change_password")
    .eq("id", actorUserId)
    .maybeSingle();

  if (userError || !user || user.role !== "admin") return null;
  if (user.must_change_password) return null;

  return user;
}

// An inactive member has no permissions at all, regardless of role/overrides.
export function actorHasPermission(membership, permission) {
  if (!membership || membership.is_active === false) return false;
  return hasPermission(membership.role, membership.permissions_overrides, permission);
}

// Owner-safety: how many OTHER active owners does this client have, besides
// the given user. Used to block any action that would leave the client
// with zero active owners.
export async function countOtherActiveOwners(supabase, clientId, excludeUserId) {
  const { count, error } = await supabase
    .from("client_users")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("role", "owner")
    .eq("is_active", true)
    .neq("user_id", excludeUserId);

  if (error) throw error;
  return count || 0;
}
