import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  PERMISSIONS,
  ROLES,
  getRoleDefaults,
  resolvePermissions,
  hasUserPermission,
} from "../../lib/permissions.js";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

const PERMISSION_ORDER = Object.values(PERMISSIONS);

function formatDate(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(lang === "en" ? "en-US" : "ar-EG", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return value;
  }
}

async function callTeamAction(action, actorUserId, payload = {}, t) {
  const response = await fetch("/api/client-users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, actor_user_id: actorUserId, ...payload }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    throw new Error(data?.message || t("integrationsPage.actionFailedGeneric"));
  }
  return data;
}

function PermissionChecklist({ selected, onToggle, lockedOn, t }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {PERMISSION_ORDER.map((key) => {
        const checked = selected.has(key);
        const locked = lockedOn === key;
        return (
          <label
            key={key}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
              checked ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600"
            } ${locked ? "opacity-70" : ""}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={locked}
              onChange={() => onToggle(key)}
            />
            <span className="font-semibold">{t(`permissions.${key}`)}</span>
          </label>
        );
      })}
    </div>
  );
}

export default function ClientTeam() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();

  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", email: "", role: "agent", permissions: new Set(getRoleDefaults("agent")) });
  const [saving, setSaving] = useState(false);

  const [actionBusyId, setActionBusyId] = useState(null);
  const [reveal, setReveal] = useState(null); // { name, email, password }
  const [permsModal, setPermsModal] = useState(null); // { member, selected: Set }

  const canManage = hasUserPermission(user, PERMISSIONS.TEAM_MANAGEMENT);

  useEffect(() => {
    if (canManage) fetchTeam();
  }, [user?.id]);

  async function fetchTeam() {
    if (!user?.id) return;

    setLoading(true);
    setError("");

    try {
      const response = await fetch(`/api/client-users?actor_user_id=${encodeURIComponent(user.id)}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || t("team.errorLoadTeam"));
      }

      setMembers(data.members || []);
    } catch (err) {
      console.error(err);
      setError(err.message || t("team.errorLoadTeam"));
    } finally {
      setLoading(false);
    }
  }

  const activeOwnerCount = members.filter((m) => m.role === "owner" && m.is_active).length;

  function isLastActiveOwner(member) {
    return member.role === "owner" && member.is_active && activeOwnerCount <= 1;
  }

  function openAddDrawer() {
    setAddForm({ name: "", email: "", role: "agent", permissions: new Set(getRoleDefaults("agent")) });
    setError("");
    setDrawerOpen(true);
  }

  function handleAddRoleChange(role) {
    // Resetting to the new role's defaults on every role change keeps this
    // predictable — customize permissions after settling on a role.
    setAddForm((prev) => ({ ...prev, role, permissions: new Set(getRoleDefaults(role)) }));
  }

  function toggleAddPermission(key) {
    setAddForm((prev) => {
      const next = new Set(prev.permissions);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, permissions: next };
    });
  }

  async function handleAddUser(e) {
    e.preventDefault();
    setError("");
    setMsg("");

    const name = addForm.name.trim();
    const email = addForm.email.trim();

    if (!name || !email) {
      setError(t("team.errorNameEmail"));
      return;
    }

    setSaving(true);

    try {
      const data = await callTeamAction("add_user", user.id, {
        name,
        email,
        role: addForm.role,
        permissions: Array.from(addForm.permissions),
      }, t);
      setDrawerOpen(false);
      await fetchTeam();
      setReveal({ name: data.member.name, email: data.member.email, password: data.temp_password });
    } catch (err) {
      setError(err.message || t("team.errorAddUser"));
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeRole(member, role) {
    if (role === member.role || actionBusyId) return;

    if (member.role === "owner" && role !== "owner") {
      if (!window.confirm(t("team.confirmChangeOwnerRole"))) return;
    }

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      await callTeamAction("change_role", user.id, { target_user_id: member.user_id, role }, t);
      await fetchTeam();
      setMsg(t("team.roleUpdated"));
    } catch (err) {
      setError(err.message || t("team.errorRoleUpdate"));
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleToggleActive(member) {
    if (actionBusyId) return;

    if (member.is_active && !window.confirm(t("team.confirmDeactivate", { name: member.name || member.email }))) return;

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      await callTeamAction("set_active", user.id, { target_user_id: member.user_id, is_active: !member.is_active }, t);
      await fetchTeam();
      setMsg(member.is_active ? t("team.userDeactivated") : t("team.userActivated"));
    } catch (err) {
      setError(err.message || t("team.errorStatusUpdate"));
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleRemove(member) {
    if (actionBusyId) return;
    if (!window.confirm(t("team.confirmRemove", { name: member.name || member.email }))) return;

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      await callTeamAction("remove", user.id, { target_user_id: member.user_id }, t);
      await fetchTeam();
      setMsg(t("team.userRemoved"));
    } catch (err) {
      setError(err.message || t("team.errorRemove"));
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleResetPassword(member) {
    if (actionBusyId) return;
    if (!window.confirm(t("team.confirmResetPassword", { name: member.name || member.email }))) return;

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      const data = await callTeamAction("reset_password", user.id, { target_user_id: member.user_id }, t);
      setReveal({ name: member.name, email: member.email, password: data.temp_password });
    } catch (err) {
      setError(err.message || t("team.errorResetPassword"));
    } finally {
      setActionBusyId(null);
    }
  }

  function openPermsModal(member) {
    const effective = resolvePermissions(member.role, member.permissions_overrides);
    setPermsModal({ member, selected: effective });
  }

  function togglePermsModalPermission(key) {
    setPermsModal((prev) => {
      if (!prev) return prev;
      // Owner floor: team_management can't be unchecked for an owner —
      // mirrors the server-side rule so the UI never shows a change that
      // would just be rejected.
      if (prev.member.role === "owner" && key === PERMISSIONS.TEAM_MANAGEMENT) return prev;
      const next = new Set(prev.selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, selected: next };
    });
  }

  async function savePermsModal() {
    if (!permsModal || actionBusyId) return;

    setActionBusyId(permsModal.member.client_user_id);
    setError("");
    setMsg("");

    try {
      await callTeamAction("change_permissions", user.id, {
        target_user_id: permsModal.member.user_id,
        permissions: Array.from(permsModal.selected),
      }, t);
      setPermsModal(null);
      await fetchTeam();
      setMsg(t("team.permissionsUpdated"));
    } catch (err) {
      setError(err.message || t("team.errorPermissionsUpdate"));
    } finally {
      setActionBusyId(null);
    }
  }

  if (!canManage) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        {t("team.noPermission")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">TEAM</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">{t("navigation.team")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("team.subtitle")}</p>
        </div>

        <button
          onClick={openAddDrawer}
          className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700"
        >
          {t("team.addUser")}
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
          {error}
        </div>
      )}

      {msg && (
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-700">
          {msg}
        </div>
      )}

      <div className={`${cardClass} overflow-hidden`}>
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500">{t("team.loading")}</div>
        ) : members.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">{t("team.empty")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/60 text-right text-xs font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t("common.name")}</th>
                  <th className="px-4 py-3">{t("common.email")}</th>
                  <th className="px-4 py-3">{t("team.colRole")}</th>
                  <th className="px-4 py-3">{t("common.status")}</th>
                  <th className="px-4 py-3">{t("team.colAddedAt")}</th>
                  <th className="px-4 py-3">{t("account.lastLogin")}</th>
                  <th className="px-4 py-3">{t("team.colActions")}</th>
                </tr>
              </thead>

              <tbody>
                {members.map((member) => {
                  const busy = actionBusyId === member.client_user_id;
                  const isSelf = member.user_id === user.id;
                  const lastOwner = isLastActiveOwner(member);

                  return (
                    <tr key={member.client_user_id} className="border-b border-slate-50 last:border-0">
                      <td className="px-4 py-3 font-bold text-slate-900">
                        {member.name || "—"} {isSelf && <span className="text-xs font-normal text-indigo-500">{t("team.you")}</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600" dir="ltr">{member.email}</td>
                      <td className="px-4 py-3">
                        <select
                          value={member.role}
                          disabled={busy || lastOwner}
                          onChange={(e) => handleChangeRole(member, e.target.value)}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 outline-none focus:border-indigo-300 disabled:opacity-50"
                          title={lastOwner ? t("team.lockLastOwnerRole") : undefined}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>{t(`roles.${r}`)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-bold ${member.is_active ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {member.is_active ? t("common.active") : t("common.inactive")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(member.created_at, i18n.language)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(member.last_login_at, i18n.language)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            onClick={() => openPermsModal(member)}
                            disabled={busy}
                            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {t("team.permissionsButton")}
                          </button>

                          <button
                            onClick={() => handleToggleActive(member)}
                            disabled={busy || lastOwner}
                            title={lastOwner ? t("team.lockLastOwnerToggle") : undefined}
                            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {member.is_active ? t("team.deactivate") : t("common.activate")}
                          </button>

                          <button
                            onClick={() => handleResetPassword(member)}
                            disabled={busy || !member.is_active}
                            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {t("team.resetPassword")}
                          </button>

                          <button
                            onClick={() => handleRemove(member)}
                            disabled={busy || lastOwner}
                            title={lastOwner ? t("team.lockLastOwnerRemove") : undefined}
                            className="rounded-xl bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 disabled:opacity-50"
                          >
                            {t("team.remove")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/40"
          onClick={() => !saving && setDrawerOpen(false)}
        >
          <form
            onSubmit={handleAddUser}
            onClick={(e) => e.stopPropagation()}
            className="h-full w-full max-w-lg overflow-y-auto bg-white p-6 shadow-2xl"
          >
            <div className="mb-6 flex items-start justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">TEAM</p>
                <h3 className="mt-1 text-2xl font-black text-slate-950">{t("team.drawerAddTitle")}</h3>
              </div>

              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-xl border px-3 py-2 text-sm"
              >
                {t("common.close")}
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-bold">{t("common.name")}</label>
                <input
                  className={inputClass}
                  value={addForm.name}
                  onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-bold">{t("common.email")}</label>
                <input
                  type="email"
                  className={inputClass}
                  value={addForm.email}
                  onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                  dir="ltr"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-bold">{t("team.fieldRole")}</label>
                <select
                  className={inputClass}
                  value={addForm.role}
                  onChange={(e) => handleAddRoleChange(e.target.value)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{t(`roles.${r}`)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-bold">{t("team.fieldPermissions")}</label>
                <PermissionChecklist selected={addForm.permissions} onToggle={toggleAddPermission} t={t} />
                <p className="mt-2 text-xs text-slate-500">
                  {t("team.permissionsAutoHint")}
                </p>
              </div>

              <p className="text-xs text-slate-500">
                {t("team.tempPasswordNote")}
              </p>

              <button
                type="submit"
                disabled={saving}
                className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? t("team.adding") : t("team.addUserButton")}
              </button>
            </div>
          </form>
        </div>
      )}

      {permsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => setPermsModal(null)}>
          <div className={`${cardClass} w-full max-w-lg p-6`} onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">{t("team.fieldPermissions")}</p>
            <h3 className="mt-1 text-lg font-black text-slate-950">{permsModal.member.name || permsModal.member.email}</h3>
            <p className="text-xs text-slate-500">
              {t("team.permsModalRolePrefix", { role: t(`roles.${permsModal.member.role}`) })}
            </p>

            <div className="mt-4">
              <PermissionChecklist
                selected={permsModal.selected}
                onToggle={togglePermsModalPermission}
                lockedOn={permsModal.member.role === "owner" ? PERMISSIONS.TEAM_MANAGEMENT : null}
                t={t}
              />
            </div>

            {permsModal.member.role === "owner" && (
              <p className="mt-2 text-xs text-amber-600">
                {t("team.ownerFloorNote")}
              </p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={savePermsModal}
                disabled={actionBusyId === permsModal.member.client_user_id}
                className="h-11 flex-1 rounded-2xl bg-indigo-600 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
              >
                {t("common.save")}
              </button>
              <button
                type="button"
                onClick={() => setPermsModal(null)}
                className="h-11 rounded-2xl border border-slate-200 px-5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {reveal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => setReveal(null)}>
          <div className={`${cardClass} w-full max-w-sm p-6`} onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">{t("team.tempPasswordTitle")}</p>
            <h3 className="mt-1 text-lg font-black text-slate-950">{reveal.name}</h3>
            <p className="text-xs text-slate-500" dir="ltr">{reveal.email}</p>

            <div className="mt-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <code className="flex-1 text-sm font-bold text-slate-900" dir="ltr">{reveal.password}</code>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(reveal.password)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                {t("common.copy")}
              </button>
            </div>

            <p className="mt-3 text-xs font-semibold text-amber-600">
              {t("team.shareWarning")}
            </p>

            <button
              type="button"
              onClick={() => setReveal(null)}
              className="mt-5 h-11 w-full rounded-2xl border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              {t("common.done")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
