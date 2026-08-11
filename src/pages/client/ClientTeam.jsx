import React, { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  ROLE_LABELS,
  getRoleDefaults,
  resolvePermissions,
  hasUserPermission,
} from "../../lib/permissions.js";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

const PERMISSION_ORDER = Object.values(PERMISSIONS);

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return value;
  }
}

async function callTeamAction(action, actorUserId, payload = {}) {
  const response = await fetch("/api/client-users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, actor_user_id: actorUserId, ...payload }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    throw new Error(data?.message || "فشل تنفيذ العملية");
  }
  return data;
}

function PermissionChecklist({ selected, onToggle, lockedOn }) {
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
            <span className="font-semibold">{PERMISSION_LABELS[key]}</span>
          </label>
        );
      })}
    </div>
  );
}

export default function ClientTeam() {
  const { user } = useAuth();

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
        throw new Error(data?.message || "فشل تحميل الفريق");
      }

      setMembers(data.members || []);
    } catch (err) {
      console.error(err);
      setError(err.message || "فشل تحميل الفريق");
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
      setError("يرجى إدخال الاسم والإيميل");
      return;
    }

    setSaving(true);

    try {
      const data = await callTeamAction("add_user", user.id, {
        name,
        email,
        role: addForm.role,
        permissions: Array.from(addForm.permissions),
      });
      setDrawerOpen(false);
      await fetchTeam();
      setReveal({ name: data.member.name, email: data.member.email, password: data.temp_password });
    } catch (err) {
      setError(err.message || "فشل إضافة المستخدم");
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeRole(member, role) {
    if (role === member.role || actionBusyId) return;

    if (member.role === "owner" && role !== "owner") {
      if (!window.confirm("هل أنت متأكد من تغيير دور هذا المالك؟ لن يبقى مالكاً بعد هذا التغيير.")) return;
    }

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      await callTeamAction("change_role", user.id, { target_user_id: member.user_id, role });
      await fetchTeam();
      setMsg("تم تحديث الدور بنجاح");
    } catch (err) {
      setError(err.message || "فشل تحديث الدور");
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleToggleActive(member) {
    if (actionBusyId) return;

    if (member.is_active && !window.confirm(`هل تريد إيقاف ${member.name || member.email}؟`)) return;

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      await callTeamAction("set_active", user.id, { target_user_id: member.user_id, is_active: !member.is_active });
      await fetchTeam();
      setMsg(member.is_active ? "تم إيقاف المستخدم" : "تم تفعيل المستخدم");
    } catch (err) {
      setError(err.message || "فشل تحديث حالة المستخدم");
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleRemove(member) {
    if (actionBusyId) return;
    if (!window.confirm(`هل تريد إزالة ${member.name || member.email} من الفريق؟ يفضّل الإيقاف بدلاً من الإزالة إن كنت تريد الاحتفاظ بإمكانية إعادته لاحقاً.`)) return;

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      await callTeamAction("remove", user.id, { target_user_id: member.user_id });
      await fetchTeam();
      setMsg("تمت إزالة المستخدم من الفريق");
    } catch (err) {
      setError(err.message || "فشل إزالة المستخدم");
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleResetPassword(member) {
    if (actionBusyId) return;
    if (!window.confirm(`هل تريد إعادة تعيين كلمة مرور ${member.name || member.email}؟ سيُطلب منه تعيين كلمة مرور جديدة عند الدخول التالي.`)) return;

    setActionBusyId(member.client_user_id);
    setError("");
    setMsg("");

    try {
      const data = await callTeamAction("reset_password", user.id, { target_user_id: member.user_id });
      setReveal({ name: member.name, email: member.email, password: data.temp_password });
    } catch (err) {
      setError(err.message || "فشل إعادة تعيين كلمة المرور");
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
      });
      setPermsModal(null);
      await fetchTeam();
      setMsg("تم تحديث الصلاحيات بنجاح");
    } catch (err) {
      setError(err.message || "فشل تحديث الصلاحيات");
    } finally {
      setActionBusyId(null);
    }
  }

  if (!canManage) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500" dir="rtl">
        غير مصرح لك بإدارة فريق العمل.
      </div>
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">TEAM</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">فريق العمل</h2>
          <p className="mt-1 text-sm text-slate-500">إدارة المستخدمين الذين لديهم وصول لحساب العميل هذا.</p>
        </div>

        <button
          onClick={openAddDrawer}
          className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700"
        >
          + إضافة مستخدم
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
          <div className="p-10 text-center text-sm text-slate-500">جارِ تحميل الفريق...</div>
        ) : members.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">لا يوجد أعضاء في الفريق بعد.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/60 text-right text-xs font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">الاسم</th>
                  <th className="px-4 py-3">الإيميل</th>
                  <th className="px-4 py-3">الدور</th>
                  <th className="px-4 py-3">الحالة</th>
                  <th className="px-4 py-3">تاريخ الإضافة</th>
                  <th className="px-4 py-3">آخر دخول</th>
                  <th className="px-4 py-3">إجراءات</th>
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
                        {member.name || "—"} {isSelf && <span className="text-xs font-normal text-indigo-500">(أنت)</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600" dir="ltr">{member.email}</td>
                      <td className="px-4 py-3">
                        <select
                          value={member.role}
                          disabled={busy || lastOwner}
                          onChange={(e) => handleChangeRole(member, e.target.value)}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 outline-none focus:border-indigo-300 disabled:opacity-50"
                          title={lastOwner ? "لا يمكن تغيير دور آخر مالك نشط" : undefined}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-bold ${member.is_active ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {member.is_active ? "نشط" : "موقوف"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(member.created_at)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(member.last_login_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            onClick={() => openPermsModal(member)}
                            disabled={busy}
                            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            الصلاحيات
                          </button>

                          <button
                            onClick={() => handleToggleActive(member)}
                            disabled={busy || lastOwner}
                            title={lastOwner ? "لا يمكن إيقاف آخر مالك نشط" : undefined}
                            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {member.is_active ? "إيقاف" : "تفعيل"}
                          </button>

                          <button
                            onClick={() => handleResetPassword(member)}
                            disabled={busy || !member.is_active}
                            className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            إعادة تعيين كلمة المرور
                          </button>

                          <button
                            onClick={() => handleRemove(member)}
                            disabled={busy || lastOwner}
                            title={lastOwner ? "لا يمكن حذف آخر مالك نشط" : undefined}
                            className="rounded-xl bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 disabled:opacity-50"
                          >
                            إزالة
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
                <h3 className="mt-1 text-2xl font-black text-slate-950">إضافة مستخدم</h3>
              </div>

              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-xl border px-3 py-2 text-sm"
              >
                إغلاق
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-bold">الاسم</label>
                <input
                  className={inputClass}
                  value={addForm.name}
                  onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-bold">الإيميل</label>
                <input
                  type="email"
                  className={inputClass}
                  value={addForm.email}
                  onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                  dir="ltr"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-bold">الدور</label>
                <select
                  className={inputClass}
                  value={addForm.role}
                  onChange={(e) => handleAddRoleChange(e.target.value)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-bold">الصلاحيات</label>
                <PermissionChecklist selected={addForm.permissions} onToggle={toggleAddPermission} />
                <p className="mt-2 text-xs text-slate-500">
                  محدّدة تلقائياً حسب الدور المختار — يمكنك تعديلها حسب الحاجة.
                </p>
              </div>

              <p className="text-xs text-slate-500">
                سيتم إنشاء كلمة مرور مؤقتة تلقائياً وعرضها لك مرة واحدة بعد الإضافة. سيُطلب من المستخدم تغييرها عند أول دخول.
              </p>

              <button
                type="submit"
                disabled={saving}
                className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? "جارِ الإضافة..." : "إضافة المستخدم"}
              </button>
            </div>
          </form>
        </div>
      )}

      {permsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => setPermsModal(null)}>
          <div className={`${cardClass} w-full max-w-lg p-6`} onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">الصلاحيات</p>
            <h3 className="mt-1 text-lg font-black text-slate-950">{permsModal.member.name || permsModal.member.email}</h3>
            <p className="text-xs text-slate-500">
              الدور: {ROLE_LABELS[permsModal.member.role]} — الصلاحيات الفعلية الحالية معروضة أدناه، يمكنك تعديلها.
            </p>

            <div className="mt-4">
              <PermissionChecklist
                selected={permsModal.selected}
                onToggle={togglePermsModalPermission}
                lockedOn={permsModal.member.role === "owner" ? PERMISSIONS.TEAM_MANAGEMENT : null}
              />
            </div>

            {permsModal.member.role === "owner" && (
              <p className="mt-2 text-xs text-amber-600">
                لا يمكن إزالة صلاحية "إدارة الفريق" من مالك الحساب لتجنّب فقدان القدرة على إدارته.
              </p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={savePermsModal}
                disabled={actionBusyId === permsModal.member.client_user_id}
                className="h-11 flex-1 rounded-2xl bg-indigo-600 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
              >
                حفظ
              </button>
              <button
                type="button"
                onClick={() => setPermsModal(null)}
                className="h-11 rounded-2xl border border-slate-200 px-5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {reveal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => setReveal(null)}>
          <div className={`${cardClass} w-full max-w-sm p-6`} onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-600">كلمة مرور مؤقتة</p>
            <h3 className="mt-1 text-lg font-black text-slate-950">{reveal.name}</h3>
            <p className="text-xs text-slate-500" dir="ltr">{reveal.email}</p>

            <div className="mt-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <code className="flex-1 text-sm font-bold text-slate-900" dir="ltr">{reveal.password}</code>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(reveal.password)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                نسخ
              </button>
            </div>

            <p className="mt-3 text-xs font-semibold text-amber-600">
              شارك كلمة المرور هذه بأمان مع المستخدم الآن — لن تظهر مرة أخرى. سيُطلب منه تغييرها عند أول دخول.
            </p>

            <button
              type="button"
              onClick={() => setReveal(null)}
              className="mt-5 h-11 w-full rounded-2xl border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              تم
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
