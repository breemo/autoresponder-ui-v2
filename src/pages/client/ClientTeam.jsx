import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckBadgeIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  NoSymbolIcon,
  UserGroupIcon,
  UserIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../../context/AuthContext.jsx";
import { Card, EmptyState, PageHeader, Skeleton, StatusPill, cx, ui } from "../../components/app/primitives.jsx";
import { ActionMenu, Drawer, Modal, Notice } from "../../components/app/Overlay.jsx";
import {
  PERMISSIONS,
  ROLES,
  getRoleDefaults,
  resolvePermissions,
  hasUserPermission,
} from "../../lib/permissions.js";
import { MemberAvatar, PERMISSION_ORDER, PermissionToggleGrid, ROLE_STYLE, RelativeTime, RoleBadge, RoleMixBar } from "./team/teamUi.jsx";
import { filterMembers, summarizeMembers } from "./team/teamSummary.js";

// Team Members workspace. Every action, confirmation, last-owner lock and
// /api/client-router?resource=users payload is unchanged (logic below is the
// previous implementation verbatim); the server keeps enforcing
// TEAM_MANAGEMENT and the owner rules. Overview counts, search and filters
// are derived locally from the already-loaded member list.

const inputClass = ui.input;

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

// The permission picker is PermissionToggleGrid (./team/teamUi.jsx).
const PermissionChecklist = PermissionToggleGrid;

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

  // ---- Presentation-only state (local filtering of the loaded list) ----
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [pwCopied, setPwCopied] = useState(false);

  if (!canManage) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-500">
        {t("team.noPermission")}
      </div>
    );
  }

  const summary = summarizeMembers(members);
  const visible = filterMembers(members, { query, role: roleFilter, status: statusFilter });
  const filtersActive = query.trim() !== "" || roleFilter !== "all" || statusFilter !== "all";
  const permCount = (member) => resolvePermissions(member.role, member.permissions_overrides).size;

  const roleSelect = (member, busy, lastOwner) => (
    <div className="relative inline-flex">
      <select
        value={member.role}
        disabled={busy || lastOwner}
        onChange={(e) => handleChangeRole(member, e.target.value)}
        aria-label={`${t("team.colRole")}: ${member.name || member.email}`}
        title={lastOwner ? t("team.lockLastOwnerRole") : undefined}
        className={cx(
          "h-8 appearance-none rounded-full py-0 pe-7 ps-3 text-xs font-semibold ring-1 ring-inset outline-none transition focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60",
          (ROLE_STYLE[member.role] || ROLE_STYLE.agent).pill
        )}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>{t(`roles.${r}`)}</option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute end-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-70" />
      {lastOwner && <LockClosedIcon className="pointer-events-none absolute -end-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />}
    </div>
  );

  const statusPill = (member) => (
    <StatusPill tone={member.is_active ? "emerald" : "slate"} dot>
      {member.is_active ? t("common.active") : t("common.inactive")}
    </StatusPill>
  );

  const accessCell = (member) => {
    const n = permCount(member);
    return (
      <div className="min-w-[120px]">
        <p className="text-xs font-medium text-slate-700 tabular-nums">{t("teamMembers.permissionsCount", { count: n, total: PERMISSION_ORDER.length })}</p>
        <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-indigo-500" style={{ width: `${(n / PERMISSION_ORDER.length) * 100}%` }} />
        </div>
      </div>
    );
  };

  const memberActions = (member, busy, lastOwner) => (
    <div className="flex items-center justify-end gap-1.5">
      <button
        type="button"
        onClick={() => openPermsModal(member)}
        disabled={busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
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
      <MemberAvatar member={member} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5">
          <bdi className="truncate font-semibold text-slate-900">{member.name || "—"}</bdi>
          {isSelf && <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{t("team.you")}</span>}
        </p>
        <p className="truncate text-xs text-slate-500" dir="ltr">{member.email}</p>
      </div>
    </div>
  );

  const seg = (value, current, set, label) => (
    <button
      key={value}
      type="button"
      aria-pressed={current === value}
      onClick={() => set(value)}
      className={cx(
        "h-full whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
        current === value ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-800"
      )}
    >
      {label}
    </button>
  );

  const rel = (value) => <RelativeTime value={value} lang={i18n.language} formatDate={formatDate} neverLabel={t("teamMembers.never")} />;
  const tile = "min-w-0 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

  return (
    <div className="space-y-5">
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

      {/* Team overview — counts derived from the loaded member list */}
      <section aria-label={t("teamMembers.overviewTitle")} className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="team-overview">
        {[
          { label: t("teamMembers.totalMembers"), value: summary.total, icon: UserGroupIcon, tone: "bg-indigo-50 text-indigo-600" },
          { label: t("teamMembers.activeMembers"), value: summary.active, icon: CheckBadgeIcon, tone: "bg-emerald-50 text-emerald-600" },
          { label: t("teamMembers.inactiveMembers"), value: summary.inactive, icon: NoSymbolIcon, tone: "bg-slate-100 text-slate-500" },
        ].map((k) => (
          <div key={k.label} className={tile}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-500">{k.label}</p>
              <span className={cx("inline-flex h-8 w-8 items-center justify-center rounded-lg", k.tone)}>
                <k.icon className="h-4 w-4" />
              </span>
            </div>
            {loading ? <Skeleton className="mt-2 h-7 w-12" /> : <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-slate-900">{k.value}</p>}
          </div>
        ))}
        <div className={cx(tile, "col-span-2 lg:col-span-1")}>
          <p className="mb-3 text-xs font-medium text-slate-500">{t("teamMembers.roleMix")}</p>
          {loading ? <Skeleton className="h-8 w-full" /> : <RoleMixBar roles={summary.roles} total={summary.total} t={t} />}
        </div>
      </section>

      {/* Member workspace */}
      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-slate-900">{t("teamMembers.listTitle")}</h2>
            <p className="mt-0.5 text-xs text-slate-500" data-testid="team-count">{t("teamMembers.showing", { shown: visible.length, total: members.length })}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-full sm:basis-60 xl:w-64 xl:flex-none">
              <MagnifyingGlassIcon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("teamMembers.searchPlaceholder")} aria-label={t("teamMembers.searchPlaceholder")} className={cx(inputClass, "ps-9")} />
            </div>
            <div role="group" aria-label={t("team.colRole")} className="inline-flex h-9 items-center gap-0.5 rounded-xl bg-slate-100 p-0.5">
              {seg("all", roleFilter, setRoleFilter, t("teamMembers.filterAll"))}
              {ROLES.map((r) => seg(r, roleFilter, setRoleFilter, t(`roles.${r}`)))}
            </div>
            <div role="group" aria-label={t("common.status")} className="inline-flex h-9 items-center gap-0.5 rounded-xl bg-slate-100 p-0.5">
              {seg("all", statusFilter, setStatusFilter, t("teamMembers.filterAll"))}
              {seg("active", statusFilter, setStatusFilter, t("common.active"))}
              {seg("inactive", statusFilter, setStatusFilter, t("common.inactive"))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : members.length === 0 ? (
          <div className="p-6"><EmptyState icon={UserGroupIcon} title={t("team.empty")} /></div>
        ) : visible.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={MagnifyingGlassIcon} title={t("teamMembers.noMatches")}>
              {filtersActive && (
                <button type="button" onClick={() => { setQuery(""); setRoleFilter("all"); setStatusFilter("all"); }} className="font-semibold text-indigo-600 hover:underline">
                  {t("teamMembers.clearFilters")}
                </button>
              )}
            </EmptyState>
          </div>
        ) : (
          <>
            {/* lg+: table */}
            <div className="hidden lg:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50/80 text-[11px] uppercase tracking-wide text-slate-500 rtl:tracking-normal">
                  <tr>
                    <th className="px-5 py-3 text-start font-semibold">{t("teamMembers.member")}</th>
                    <th className="px-4 py-3 text-start font-semibold">{t("team.colRole")}</th>
                    <th className="px-4 py-3 text-start font-semibold">{t("teamMembers.access")}</th>
                    <th className="px-4 py-3 text-start font-semibold">{t("common.status")}</th>
                    <th className="px-4 py-3 text-start font-semibold">{t("team.colAddedAt")}</th>
                    <th className="px-4 py-3 text-start font-semibold">{t("account.lastLogin")}</th>
                    <th className="px-5 py-3 text-end font-semibold">{t("team.colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((member) => {
                    const busy = actionBusyId === member.client_user_id;
                    const isSelf = member.user_id === user.id;
                    const lastOwner = isLastActiveOwner(member);
                    return (
                      <tr key={member.client_user_id} data-member-id={member.user_id} className={cx("transition hover:bg-slate-50/70", !member.is_active && "bg-slate-50/40")}>
                        <td className="max-w-[300px] px-5 py-3.5">{identity(member, isSelf)}</td>
                        <td className="px-4 py-3.5">{roleSelect(member, busy, lastOwner)}</td>
                        <td className="px-4 py-3.5">{accessCell(member)}</td>
                        <td className="px-4 py-3.5">{statusPill(member)}</td>
                        <td className="px-4 py-3.5 text-xs text-slate-600">{rel(member.created_at)}</td>
                        <td className="px-4 py-3.5 text-xs text-slate-600">{rel(member.last_login_at)}</td>
                        <td className="px-5 py-3.5">{memberActions(member, busy, lastOwner)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* < lg: member cards */}
            <ul className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:hidden">
              {visible.map((member) => {
                const busy = actionBusyId === member.client_user_id;
                const isSelf = member.user_id === user.id;
                const lastOwner = isLastActiveOwner(member);
                return (
                  <li key={member.client_user_id} data-member-id={member.user_id} className="min-w-0 space-y-3 rounded-xl border border-slate-200/80 bg-white p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      {identity(member, isSelf)}
                      {statusPill(member)}
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      {roleSelect(member, busy, lastOwner)}
                      {accessCell(member)}
                    </div>
                    <dl className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                      <div>
                        <dt className="text-slate-500">{t("team.colAddedAt")}</dt>
                        <dd className="mt-0.5 font-medium text-slate-700">{rel(member.created_at)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">{t("account.lastLogin")}</dt>
                        <dd className="mt-0.5 font-medium text-slate-700">{rel(member.last_login_at)}</dd>
                      </div>
                    </dl>
                    {memberActions(member, busy, lastOwner)}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      {/* Add User — stepped drawer */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        closeDisabled={saving}
        title={t("team.drawerAddTitle")}
        subtitle={t("teamMembers.addSubtitle")}
        closeLabel={t("common.close")}
        width="max-w-xl"
        footer={
          <>
            <button type="button" onClick={() => setDrawerOpen(false)} disabled={saving} className={ui.btnSecondary}>{t("common.cancel")}</button>
            <button type="submit" form="team-add-user-form" disabled={saving} className={ui.btnPrimary}>
              <UserPlusIcon className="h-4 w-4" />
              {saving ? t("team.adding") : t("team.addUserButton")}
            </button>
          </>
        }
      >
        <form id="team-add-user-form" onSubmit={handleAddUser} className="space-y-6">
          {error && <Notice tone="error">{error}</Notice>}

          <fieldset className="space-y-3">
            <legend className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-slate-900">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] text-white">1</span>
              {t("teamMembers.stepDetails")}
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="team-name" className={ui.label}>{t("common.name")}</label>
                <div className="relative">
                  <UserIcon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input id="team-name" dir="auto" className={cx(inputClass, "ps-9")} value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} />
                </div>
              </div>
              <div>
                <label htmlFor="team-email" className={ui.label}>{t("common.email")}</label>
                <div className="relative">
                  <EnvelopeIcon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input id="team-email" type="email" className={cx(inputClass, "ps-9")} value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} dir="ltr" />
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-slate-900">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] text-white">2</span>
              {t("team.fieldRole")}
            </legend>
            <div role="radiogroup" aria-label={t("team.fieldRole")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {ROLES.map((r) => {
                const style = ROLE_STYLE[r] || ROLE_STYLE.agent;
                const Icon = style.icon;
                const checked = addForm.role === r;
                return (
                  <label key={r} className={cx("flex cursor-pointer flex-col gap-2 rounded-xl border p-3 transition focus-within:ring-2 focus-within:ring-indigo-500", checked ? "border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-300" : "border-slate-200 hover:border-slate-300")}>
                    <input type="radio" name="team-role" value={r} checked={checked} onChange={() => handleAddRoleChange(r)} className="sr-only" />
                    <span className="flex items-center justify-between">
                      <span className={cx("inline-flex h-8 w-8 items-center justify-center rounded-lg", style.avatar)}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className={cx("h-4 w-4 rounded-full border-2", checked ? "border-indigo-600 bg-indigo-600 shadow-[inset_0_0_0_3px_white]" : "border-slate-300")} aria-hidden="true" />
                    </span>
                    <span className="text-[13px] font-semibold text-slate-900">{t(`roles.${r}`)}</span>
                    <span className="text-[11px] text-slate-500">{t("teamMembers.roleDefaultCount", { count: getRoleDefaults(r).length })}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 flex w-full items-center justify-between gap-2 text-[13px] font-semibold text-slate-900">
              <span className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] text-white">3</span>
                {t("team.fieldPermissions")}
              </span>
              <span className="text-xs font-medium text-slate-500 tabular-nums">{t("teamMembers.enabledCount", { count: addForm.permissions.size, total: PERMISSION_ORDER.length })}</span>
            </legend>
            <p className="mb-2 text-xs text-slate-500">{t("team.permissionsAutoHint")}</p>
            <PermissionToggleGrid selected={addForm.permissions} onToggle={toggleAddPermission} t={t} />
          </fieldset>

          <div className="flex items-start gap-2.5 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 text-xs text-indigo-900">
            <KeyIcon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
            <p>{t("team.tempPasswordNote")}</p>
          </div>
        </form>
      </Drawer>

      {/* Permissions */}
      <Modal
        open={!!permsModal}
        onClose={() => setPermsModal(null)}
        eyebrow={t("team.fieldPermissions")}
        title={permsModal ? permsModal.member.name || permsModal.member.email : ""}
        subtitle={permsModal ? t("team.permsModalRolePrefix", { role: t(`roles.${permsModal.member.role}`) }) : ""}
        closeLabel={t("common.close")}
        size="max-w-2xl"
        footer={
          permsModal && (
            <>
              <span className="me-auto text-xs font-medium text-slate-500 tabular-nums">{t("teamMembers.enabledCount", { count: permsModal.selected.size, total: PERMISSION_ORDER.length })}</span>
              <button type="button" onClick={() => setPermsModal(null)} className={ui.btnSecondary}>{t("common.cancel")}</button>
              <button type="button" onClick={savePermsModal} disabled={actionBusyId === permsModal.member.client_user_id} className={ui.btnPrimary}>{t("common.save")}</button>
            </>
          )
        }
      >
        {permsModal && (
          <>
            <div className="mb-4 flex items-center gap-3 rounded-xl bg-slate-50 p-3">
              <MemberAvatar member={permsModal.member} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900"><bdi>{permsModal.member.name || "—"}</bdi></p>
                <p className="truncate text-xs text-slate-500" dir="ltr">{permsModal.member.email}</p>
              </div>
              <span className="ms-auto"><RoleBadge role={permsModal.member.role} t={t} /></span>
            </div>
            <PermissionToggleGrid
              selected={permsModal.selected}
              onToggle={togglePermsModalPermission}
              lockedOn={permsModal.member.role === "owner" ? PERMISSIONS.TEAM_MANAGEMENT : null}
              t={t}
            />
            {permsModal.member.role === "owner" && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {t("team.ownerFloorNote")}
              </p>
            )}
          </>
        )}
      </Modal>

      {/* Temporary password (shown once) */}
      <Modal
        open={!!reveal}
        onClose={() => { setReveal(null); setPwCopied(false); }}
        title={t("team.tempPasswordTitle")}
        closeLabel={t("common.close")}
        size="max-w-md"
        footer={<button type="button" onClick={() => { setReveal(null); setPwCopied(false); }} className={ui.btnPrimary}>{t("common.done")}</button>}
      >
        {reveal && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                <KeyIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900"><bdi>{reveal.name}</bdi></p>
                <p className="truncate text-xs text-slate-500" dir="ltr">{reveal.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 ps-4">
              <code className="min-w-0 flex-1 break-all font-mono text-base font-semibold tracking-wide text-slate-900" dir="ltr" data-testid="temp-password">{reveal.password}</code>
              <button
                type="button"
                onClick={() => { Promise.resolve(navigator.clipboard?.writeText(reveal.password)).then(() => setPwCopied(true)).catch(() => setPwCopied(false)); }}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {pwCopied ? <CheckIcon className="h-4 w-4 text-emerald-600" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
                {pwCopied ? t("common.copied") : t("common.copy")}
              </button>
            </div>
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
              {t("team.shareWarning")}
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
