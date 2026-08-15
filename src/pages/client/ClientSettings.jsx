import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-500";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

export default function ClientSettings() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const { setClientDefaultLanguage } = useLanguage();
  // client_id is resolved once at login via client_users (see Login.jsx).
  const clientId = user?.client_id || null;
  const [form, setForm] = useState({ business_name: "", email: "", phone: "", address: "", business_description: "", welcome_message: "", default_reply: "", closing_message: "" });
  const [defaultLanguage, setDefaultLanguage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [langSaving, setLangSaving] = useState(false);
  const [langMsg, setLangMsg] = useState("");

  useEffect(() => { if (clientId) loadClient(); }, [clientId]);

  async function loadClient() {
    const { data, error } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (error) return console.error("Error loading client settings:", error);
    if (data) {
      setForm({ business_name: data.business_name || "", email: data.email || "", phone: data.phone || "", address: data.address || "", business_description: data.business_description || "", welcome_message: data.welcome_message || "", default_reply: data.default_reply || "", closing_message: data.closing_message || "" });
      // Absent if the language migration hasn't been applied yet — stays
      // null, and the buttons below simply show neither as selected.
      setDefaultLanguage(data.default_language || null);
    }
  }

  async function handleSave() {
    try {
      setLoading(true); setMsg("");
      const { error: clientError } = await supabase.from("clients").update({ business_name: form.business_name, phone: form.phone, address: form.address, business_description: form.business_description, welcome_message: form.welcome_message, default_reply: form.default_reply, closing_message: form.closing_message }).eq("id", clientId);
      if (clientError) throw clientError;
      setMsg(t("settings.successSaved"));
    } catch (err) {
      console.error(err); setMsg(t("settings.errorSaved"));
    } finally { setLoading(false); }
  }

  async function handleDefaultLanguageChange(lang) {
    setLangSaving(true);
    setLangMsg("");
    const result = await setClientDefaultLanguage(lang);
    setLangSaving(false);
    if (result?.success) {
      setDefaultLanguage(lang);
      setLangMsg(t("settings.defaultLanguageSaved"));
    }
  }

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const isSuccessMsg = msg === t("settings.successSaved");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">{t("settings.badge")}</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">{t("settings.title")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("settings.subtitle")}</p>
        </div>
        <button onClick={handleSave} disabled={loading} className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 disabled:opacity-60">{loading ? t("settings.saving") : t("settings.save")}</button>
      </div>

      {msg && <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${isSuccessMsg ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-red-100 bg-red-50 text-red-700"}`}>{msg}</div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_1.2fr]">
        <div className={`${cardClass} p-6`}>
          <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl">🏢</div><div><h3 className="font-black text-slate-950">{t("settings.businessInfoTitle")}</h3><p className="text-xs text-slate-500">{t("settings.businessInfoSubtitle")}</p></div></div>
          <div className="space-y-4">
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessName")}</label><input className={inputClass} value={form.business_name} onChange={(e) => update("business_name", e.target.value)} /></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.email")}</label><input className={inputClass} value={form.email} disabled /><p className="mt-1 text-xs text-slate-400">{t("settings.emailHint")}</p></div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2"><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.phone")}</label><input className={inputClass} value={form.phone} onChange={(e) => update("phone", e.target.value)} /></div><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.address")}</label><input className={inputClass} value={form.address} onChange={(e) => update("address", e.target.value)} /></div></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessDescription")}</label><textarea rows={5} className={inputClass} value={form.business_description} onChange={(e) => update("business_description", e.target.value)} /></div>
          </div>
        </div>

        <div className="space-y-5">
          <div className={`${cardClass} p-6`}>
            <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-xl">💬</div><div><h3 className="font-black text-slate-950">{t("settings.conversationMessagesTitle")}</h3><p className="text-xs text-slate-500">{t("settings.conversationMessagesSubtitle")}</p></div></div>
            <div className="space-y-4">
              <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.welcomeMessage")}</label><textarea rows={4} className={inputClass} value={form.welcome_message} onChange={(e) => update("welcome_message", e.target.value)} placeholder={t("settings.welcomeMessagePlaceholder")} /></div>
              <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.defaultReply")}</label><textarea rows={4} className={inputClass} value={form.default_reply} onChange={(e) => update("default_reply", e.target.value)} placeholder={t("settings.defaultReplyPlaceholder")} /></div>
              <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.closingMessage")}</label><textarea rows={3} className={inputClass} value={form.closing_message} onChange={(e) => update("closing_message", e.target.value)} placeholder={t("settings.closingMessagePlaceholder")} /></div>
            </div>
          </div>

          <div className={`${cardClass} p-6`}>
            <div className="mb-4">
              <h3 className="font-black text-slate-950">{t("settings.defaultLanguageTitle")}</h3>
              <p className="text-xs text-slate-500">{t("settings.defaultLanguageSubtitle")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={langSaving}
                onClick={() => handleDefaultLanguageChange("ar")}
                className={`rounded-xl border px-4 py-2 text-xs font-bold transition disabled:opacity-50 ${
                  defaultLanguage === "ar" ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                {t("settings.defaultLanguageArabic")}
              </button>
              <button
                type="button"
                disabled={langSaving}
                onClick={() => handleDefaultLanguageChange("en")}
                className={`rounded-xl border px-4 py-2 text-xs font-bold transition disabled:opacity-50 ${
                  defaultLanguage === "en" ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                {t("settings.defaultLanguageEnglish")}
              </button>
            </div>
            {langMsg && <p className="mt-3 text-xs font-bold text-indigo-700">{langMsg}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
