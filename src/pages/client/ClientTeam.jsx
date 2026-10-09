import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyIcon, UserGroupIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { useAuth } from "../../context/AuthContext.jsx";
import { Avatar, Card, EmptyState, PageHeader, Skeleton, StatusPill, ui } from "../../components/app/primitives.jsx";
import { ActionMenu, Drawer, Modal, Notice } from "../../components/app/Overlay.jsx";
import {
  PERMISSIONS,
  ROLES,
  getRoleDefaults,
  resolvePermissions,
  hasUserPermission,
} from "../../lib/permissions.js";

// Team Members. Every action, confirmation, last-owner lock and
// /api/client-router?resource=users payload is unchanged; the server keeps
// enforcing TEAM_MANAGEMENT and the owner rules. Presentation only.

const inputClass = ui.input;

const cardClass = ui.card;

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
  const response = await fetch("/api/client-router?resource=users", {
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
            className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px] transition ${
              checked ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600"
            } ${locked ? "opacity-70" : ""}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={locked}
              onChange={() => onToggle(key)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="font-medium">{t(`permissions.${key}`)}</span>
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
      const response = await fetch(`/api/client-router?resource=users&actor_user_id=${encodeURIComponent(user.id)}`);
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
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-500">
        {t("team.noPermission")}
      </div>
    );
  }

  const roleSelect = (member, busy, lastOwner) => (
    <select
      value={member.role}
      disabled={busy || lastOwner}
      onChange={(e) => handleChangeRole(member, e.target.value)}
      aria-label={`${t("team.colRole")}: ${member.name || member.email}`}
      className="h-8 rounded-lg border border-slate-200 bg-white pe-7 ps-2.5 text-xs font-semibold text-slate-700 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50 disabled:opacity-50"
      title={lastOwner ? t("team.lockLastOwnerRole") : undefined}
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>{t(`roles.${r}`)}</option>
      ))}
    </select>
  );

  const statusPill = (member) => (
    <StatusPill tone={member.is_active ? "emerald" : "rose"} dot>
      {member.is_active ? t("common.active") : t("common.inactive")}
    </StatusPill>
  );

  const memberActions = (member, busy, lastOwner) => (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => openPermsModal(member)}
        disabled={busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
      >
        <KeyIcon className="h-4 w-4" />
        {t("team.permissionsButton")}
      </button>
      <ActionMenu
        label={`${t("team.colActions")}: ${member.name || member.email}`}
        disabled={busy}
        items={[
          {
            key: "toggle",
            label: member.is_active ? t("team.deactivate") : t("common.activate"),
            onSelect: () => handleToggleActive(member),
            disabled: busy || lastOwner,
            title: lastOwner ? t("team.lockLastOwnerToggle") : undefined,
          },
          {
            key: "reset",
            label: t("team.resetPassword"),
            onSelect: () => handleResetPassword(member),
            disabled: busy || !member.is_active,
          },
          {
            key: "remove",
            label: t("team.remove"),
            onSelect: () => handleRemove(member),
            disabled: busy || lastOwner,
            title: lastOwner ? t("team.lockLastOwnerRemove") : undefined,
            danger: true,
          },
        ]}
      />
    </div>
  );

  const identity = (member, isSelf) => (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={member.name || member.email} className="h-8 w-8 text-xs" />
      <div className="min-w-0">
        <p className="truncate font-semibold text-slate-900">
          <bdi>{member.name || "—"}</bdi>
          {isSelf && <span className="ms-1.5 text-xs font-normal text-indigo-500">{t("team.you")}</span>}
        </p>
        <p className="truncate text-xs text-slate-500" dir="ltr">{member.email}</p>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("navigation.team")}
        description={t("team.subtitle")}
        actions={
          <button type="button" onClick={openAddDrawer} className={ui.btnPrimary}>
            <UserPlusIcon className="h-4 w-4" />
            {String(t("team.addUser")).replace(/^\+\s*/, "")}
          </button>
        }
      />

      {error && !drawerOpen && <Notice tone="error">{error}</Notice>}
      {msg && <Notice tone="success">{msg}</Notice>}

      <Card padded={false} className="overflow-hidden">
        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        ) : members.length === 0 ? (
          <div className="p-4"><EmptyState icon={UserGroupIcon} title={t("team.empty")} /></div>
        ) : (
          <>
            {/* lg+: table */}
            <div className="hidden lg:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50/80 text-[11px] uppercase tracking-wide text-slate-500 rtl:tracking-normal">
                  <tr>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("common.name")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("team.colRole")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("common.status")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("team.colAddedAt")}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{t("account.lastLogin")}</th>
                    <th className="w-44 px-4 py-2.5 text-start font-semibold">{t("team.colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {members.map((member) => {
                    const busy = actionBusyId === member.client_user_id;
                    const isSelf = member.user_id === user.id;
                    const lastOwner = isLastActiveOwner(member);
                    return (
                      <tr key={member.client_user_id} data-member-id={member.user_id} className="transition hover:bg-slate-50/70">
                        <td className="max-w-[280px] px-4 py-3">{identity(member, isSelf)}</td>
                        <td className="px-4 py-3">{roleSelect(member, busy, lastOwner)}</td>
                        <td className="px-4 py-3">{statusPill(member)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatDate(member.created_at, i18n.language)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatDate(member.last_login_at, i18n.language)}</td>
                        <td className="px-4 py-3">{memberActions(member, busy, lastOwner)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* < lg: cards */}
            <ul className="divide-y divide-slate-100 lg:hidden">
              {members.map((member) => {
                const busy = actionBusyId === member.client_user_id;
                const isSelf = member.user_id === user.id;
                const lastOwner = isLastActiveOwner(member);
                return (
                  <li key={member.client_user_id} data-member-id={member.user_id} className="space-y-2.5 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      {identity(member, isSelf)}
                      {statusPill(member)}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt className="text-slate-500">{t("team.colAddedAt")}</dt>
                      <dd className="text-slate-700">{formatDate(member.created_at, i18n.language)}</dd>
                      <dt className="text-slate-500">{t("account.lastLogin")}</dt>
                      <dd className="text-slate-700">{formatDate(member.last_login_at, i18n.language)}</dd>
                    </dl>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {roleSelect(member, busy, lastOwner)}
                      {memberActions(member, busy, lastOwner)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        closeDisabled={saving}
        title={t("team.drawerAddTitle")}
        closeLabel={t("common.close")}
        width="max-w-lg"
        footer={
          <>
            <button type="button" onClick={() => setDrawerOpen(false)} disabled={saving} className={ui.btnSecondary}>{t("common.cancel")}</button>
            <button type="submit" form="team-add-user-form" disabled={saving} className={ui.btnPrimary}>
              {saving ? t("team.adding") : t("team.addUserButton")}
            </button>
          </>
        }
      >
        <form id="team-add-user-form" onSubmit={handleAddUser} className="space-y-4">
          {error && <Notice tone="error">{error}</Notice>}
          <div>
            <label htmlFor="team-name" className={ui.label}>{t("common.name")}</label>
            <input id="team-name" dir="auto" className={inputClass} value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} />
          </div>
          <div>
            <label htmlFor="team-email" className={ui.label}>{t("common.email")}</label>
            <input id="team-email" type="email" className={inputClass} value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} dir="ltr" />
          </div>
          <div>
            <label htmlFor="team-role" className={ui.label}>{t("team.fieldRole")}</label>
            <select id="team-role" className={inputClass} value={addForm.role} onChange={(e) => handleAddRoleChange(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{t(`roles.${r}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <p className={ui.label}>{t("team.fieldPermissions")}</p>
            <PermissionChecklist selected={addForm.permissions} onToggle={toggleAddPermission} t={t} />
            <p className="mt-2 text-xs text-slate-500">{t("team.permissionsAutoHint")}</p>
          </div>
          <Notice tone="info" className="text-xs font-normal">{t("team.tempPasswordNote")}</Notice>
        </form>
      </Drawer>

      <Modal
        open={!!permsModal}
        onClose={() => setPermsModal(null)}
        eyebrow={t("team.fieldPermissions")}
        title={permsModal ? permsModal.member.name || permsModal.member.email : ""}
        subtitle={permsModal ? t("team.permsModalRolePrefix", { role: t(`roles.${permsModal.member.role}`) }) : ""}
        closeLabel={t("common.close")}
        footer={
          permsModal && (
            <>
              <button type="button" onClick={() => setPermsModal(null)} className={ui.btnSecondary}>{t("common.cancel")}</button>
              <button type="button" onClick={savePermsModal} disabled={actionBusyId === permsModal.member.client_user_id} className={ui.btnPrimary}>{t("common.save")}</button>
            </>
          )
        }
      >
        {permsModal && (
          <>
            <PermissionChecklist
              selected={permsModal.selected}
              onToggle={togglePermsModalPermission}
              lockedOn={permsModal.member.role === "owner" ? PERMISSIONS.TEAM_MANAGEMENT : null}
              t={t}
            />
            {permsModal.member.role === "owner" && <p className="mt-2 text-xs text-amber-600">{t("team.ownerFloorNote")}</p>}
          </>
        )}
      </Modal>

      <Modal
        open={!!reveal}
        onClose={() => setReveal(null)}
        eyebrow={t("team.tempPasswordTitle")}
        title={reveal?.name || ""}
        subtitle={reveal ? <span dir="ltr">{reveal.email}</span> : null}
        closeLabel={t("common.close")}
        size="max-w-sm"
        footer={<button type="button" onClick={() => setReveal(null)} className={ui.btnPrimary}>{t("common.done")}</button>}
      >
        {reveal && (
          <>
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
              <code className="min-w-0 flex-1 break-all text-sm font-semibold text-slate-900" dir="ltr">{reveal.password}</code>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(reveal.password)}
                className="inline-flex h-8 shrink-0 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {t("common.copy")}
              </button>
            </div>
            <p className="mt-3 text-xs font-medium text-amber-700">{t("team.shareWarning")}</p>
          </>
        )}
      </Modal>
    </div>
  );
}
