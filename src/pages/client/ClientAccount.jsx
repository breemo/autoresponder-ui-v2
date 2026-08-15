import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50";

const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

export default function ClientAccount() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { setUserLanguage, clearUserLanguage } = useLanguage();

  function formatDate(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString(i18n.language === "en" ? "en-US" : "ar-EG", {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return value;
    }
  }

  const [form, setForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);
  const [langSaving, setLangSaving] = useState(false);
  const [langMsg, setLangMsg] = useState("");

  const forced = user?.must_change_password === true;

  // Hidden by default — the form only exposes itself after an explicit
  // click, per the requested UX. Exception: a forced first-login password
  // change has nowhere else to go (every other client route redirects back
  // here while must_change_password is true) and the amber notice below
  // already says a change is required right now, so hiding the form behind
  // an extra click there would just add friction to a mandatory flow.
  const [showPasswordForm, setShowPasswordForm] = useState(forced);

  function openPasswordForm() {
    setShowPasswordForm(true);
  }

  function cancelPasswordForm() {
    setShowPasswordForm(false);
    setForm({ current_password: "", new_password: "", confirm_password: "" });
    setMsg("");
    setIsError(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg("");
    setIsError(false);

    if (!form.current_password || !form.new_password || !form.confirm_password) {
      setIsError(true);
      setMsg(t("account.validationEmptyFields"));
      return;
    }
    if (form.new_password !== form.confirm_password) {
      setIsError(true);
      setMsg(t("account.validationMismatch"));
      return;
    }
    if (form.new_password.length < 8) {
      setIsError(true);
      setMsg(t("account.validationTooShort"));
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
        throw new Error(data?.message || t("account.errorGeneric"));
      }

      // Update the session locally so the mandatory-change route gate
      // clears immediately, without requiring a fresh login.
      const updatedUser = { ...user, must_change_password: false };
      localStorage.setItem("user", JSON.stringify(updatedUser));
      setUser(updatedUser);

      setForm({ current_password: "", new_password: "", confirm_password: "" });
      setIsError(false);
      setMsg(t("account.successChanged"));
      setShowPasswordForm(false);

      if (forced) {
        setTimeout(() => navigate("/client"), 800);
      }
    } catch (err) {
      setIsError(true);
      setMsg(err.message || t("account.errorGeneric"));
    } finally {
      setSaving(false);
    }
  }

  async function handleLanguageChange(lang) {
    setLangSaving(true);
    setLangMsg("");
    const result = lang ? await setUserLanguage(lang) : await clearUserLanguage();
    setLangSaving(false);
    if (result?.success) {
      setLangMsg(result.persisted === false ? t("account.languageSaveFailedLocal") : t("account.languageSaved"));
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">{t("account.badge")}</p>
        <h2 className="mt-1 text-2xl font-black text-slate-950">{t("account.title")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("account.subtitle")}</p>
      </div>

      {forced && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
          {t("account.forcedNotice")}
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
        <h3 className="mb-4 text-sm font-black text-slate-950">{t("account.personalDataTitle")}</h3>
        <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-slate-500">{t("common.name")}</p>
            <p className="mt-1 font-bold text-slate-900">{user?.name || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">{t("common.email")}</p>
            <p className="mt-1 font-bold text-slate-900" dir="ltr">{user?.email || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">{t("account.role")}</p>
            <p className="mt-1 font-bold text-slate-900">{user?.client_role ? t(`roles.${user.client_role}`) : "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">{t("common.status")}</p>
            <p className="mt-1">
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${user?.is_active ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                {user?.is_active ? t("common.active") : t("common.inactive")}
              </span>
            </p>
          </div>
          <div>
            <p className="text-slate-500">{t("account.lastLogin")}</p>
            <p className="mt-1 font-bold text-slate-900">{formatDate(user?.last_login_at)}</p>
          </div>
        </div>
      </div>

      <div className={`${cardClass} p-6`}>
        <h3 className="mb-1 text-sm font-black text-slate-950">{t("account.languageTitle")}</h3>
        <p className="mb-4 text-xs text-slate-500">{t("account.languageHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={langSaving}
            onClick={() => handleLanguageChange("ar")}
            className={`rounded-xl border px-4 py-2 text-xs font-bold transition disabled:opacity-50 ${
              i18n.language === "ar" && user?.ui_language_user
                ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                : "border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            {t("account.languageArabic")}
          </button>
          <button
            type="button"
            disabled={langSaving}
            onClick={() => handleLanguageChange("en")}
            className={`rounded-xl border px-4 py-2 text-xs font-bold transition disabled:opacity-50 ${
              i18n.language === "en" && user?.ui_language_user
                ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                : "border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            {t("account.languageEnglish")}
          </button>
          {user?.ui_language_user && (
            <button
              type="button"
              disabled={langSaving}
              onClick={() => handleLanguageChange(null)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              {t("account.languageUseClientDefault")}
            </button>
          )}
        </div>
        {langMsg && <p className="mt-3 text-xs font-bold text-indigo-700">{langMsg}</p>}
      </div>

      <div className={`${cardClass} p-6`}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-black text-slate-950">{t("account.changePassword")}</h3>
          {!showPasswordForm && (
            <button
              type="button"
              onClick={openPasswordForm}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              {t("account.changePassword")}
            </button>
          )}
        </div>

        {showPasswordForm && (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-bold">{t("account.currentPassword")}</label>
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
              <label className="mb-1 block text-sm font-bold">{t("account.newPassword")}</label>
              <input
                type="password"
                className={inputClass}
                value={form.new_password}
                onChange={(e) => setForm({ ...form, new_password: e.target.value })}
                dir="ltr"
                disabled={saving}
              />
              <p className="mt-1 text-xs text-slate-500">{t("account.newPasswordHint")}</p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-bold">{t("account.confirmPassword")}</label>
              <input
                type="password"
                className={inputClass}
                value={form.confirm_password}
                onChange={(e) => setForm({ ...form, confirm_password: e.target.value })}
                dir="ltr"
                disabled={saving}
              />
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="h-12 flex-1 rounded-2xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? t("common.saving") : t("account.changePassword")}
              </button>
              {/* No cancel out of a mandatory first-login change — there is
                  nowhere else for that user to go (see the forced gate in
                  App.jsx's ClientRoute). */}
              {!forced && (
                <button
                  type="button"
                  onClick={cancelPasswordForm}
                  disabled={saving}
                  className="h-12 rounded-2xl border border-slate-200 px-6 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {t("account.cancel")}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
