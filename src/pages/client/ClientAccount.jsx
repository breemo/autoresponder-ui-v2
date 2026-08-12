import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { ROLE_LABELS } from "../../lib/permissions.js";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return value;
  }
}

export default function ClientAccount() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);

  const forced = user?.must_change_password === true;

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg("");
    setIsError(false);

    if (!form.current_password || !form.new_password || !form.confirm_password) {
      setIsError(true);
      setMsg("يرجى تعبئة جميع الحقول");
      return;
    }
    if (form.new_password !== form.confirm_password) {
      setIsError(true);
      setMsg("كلمة المرور الجديدة وتأكيدها غير متطابقين");
      return;
    }
    if (form.new_password.length < 8) {
      setIsError(true);
      setMsg("يجب أن تتكون كلمة المرور من 8 أحرف على الأقل");
      return;
    }

    setSaving(true);

    try {
      const response = await fetch("/api/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user.id,
          current_password: form.current_password,
          new_password: form.new_password,
          confirm_password: form.confirm_password,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.message || "فشل تغيير كلمة المرور");
      }

      // Update the session locally so the mandatory-change route gate
      // clears immediately, without requiring a fresh login.
      const updatedUser = { ...user, must_change_password: false };
      localStorage.setItem("user", JSON.stringify(updatedUser));
      setUser(updatedUser);

      setForm({ current_password: "", new_password: "", confirm_password: "" });
      setIsError(false);
      setMsg("تم تغيير كلمة المرور بنجاح");

      if (forced) {
        setTimeout(() => navigate("/client"), 800);
      }
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "فشل تغيير كلمة المرور");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">ACCOUNT</p>
        <h2 className="mt-1 text-2xl font-black text-slate-950">حسابي</h2>
        <p className="mt-1 text-sm text-slate-500">بياناتك الشخصية وكلمة المرور الخاصة بك.</p>
      </div>

      {forced && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
          يجب تغيير كلمة المرور المؤقتة قبل استخدام باقي أقسام لوحة التحكم.
        </div>
      )}

      {msg && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
            isError ? "border-red-100 bg-red-50 text-red-700" : "border-indigo-100 bg-indigo-50 text-indigo-700"
          }`}
        >
          {msg}
        </div>
      )}

      <div className={`${cardClass} p-6`}>
        <h3 className="mb-4 text-sm font-black text-slate-950">البيانات الشخصية</h3>
        <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-slate-500">الاسم</p>
            <p className="mt-1 font-bold text-slate-900">{user?.name || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">البريد الإلكتروني</p>
            <p className="mt-1 font-bold text-slate-900" dir="ltr">{user?.email || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">الدور</p>
            <p className="mt-1 font-bold text-slate-900">{ROLE_LABELS[user?.client_role] || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">الحالة</p>
            <p className="mt-1">
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${user?.is_active ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                {user?.is_active ? "مفعّل" : "معطّل"}
              </span>
            </p>
          </div>
          <div>
            <p className="text-slate-500">آخر دخول</p>
            <p className="mt-1 font-bold text-slate-900">{formatDate(user?.last_login_at)}</p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className={`${cardClass} space-y-4 p-6`}>
        <h3 className="text-sm font-black text-slate-950">تغيير كلمة المرور</h3>

        <div>
          <label className="mb-1 block text-sm font-bold">كلمة المرور الحالية</label>
          <input
            type="password"
            className={inputClass}
            value={form.current_password}
            onChange={(e) => setForm({ ...form, current_password: e.target.value })}
            dir="ltr"
            disabled={saving}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-bold">كلمة المرور الجديدة</label>
          <input
            type="password"
            className={inputClass}
            value={form.new_password}
            onChange={(e) => setForm({ ...form, new_password: e.target.value })}
            dir="ltr"
            disabled={saving}
          />
          <p className="mt-1 text-xs text-slate-500">8 أحرف على الأقل.</p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-bold">تأكيد كلمة المرور الجديدة</label>
          <input
            type="password"
            className={inputClass}
            value={form.confirm_password}
            onChange={(e) => setForm({ ...form, confirm_password: e.target.value })}
            dir="ltr"
            disabled={saving}
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="h-12 w-full rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "جارِ الحفظ..." : "تغيير كلمة المرور"}
        </button>
      </form>
    </div>
  );
}
