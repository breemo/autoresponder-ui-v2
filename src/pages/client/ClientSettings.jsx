import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-500";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

// AI Engine V1 — Phase 2. Working hours (clients.working_hours jsonb):
//   { "timezone": "Asia/Hebron", "days": { "sunday": [{"open","close"}], "friday": [] } }
// One empty-array day = closed that day. Multiple entries in one day's
// array = multiple periods (split shifts). No holiday/exception
// scheduling yet (out of scope for v1, per the approved architecture).
const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function emptyWorkingHours() {
  const days = {};
  for (const day of DAY_KEYS) days[day] = [];
  return { timezone: "", days };
}

// Normalizes whatever is currently stored (possibly null, possibly a
// partial/older shape) into the complete, always-7-day form shape the
// editor below assumes. Never throws on malformed data — an unexpected
// shape just degrades to "closed" for that day rather than crashing the
// settings page.
function normalizeWorkingHours(raw) {
  const result = emptyWorkingHours();
  if (!raw || typeof raw !== "object") return result;

  result.timezone = typeof raw.timezone === "string" ? raw.timezone : "";

  const rawDays = raw.days && typeof raw.days === "object" ? raw.days : {};
  for (const day of DAY_KEYS) {
    const periods = Array.isArray(rawDays[day]) ? rawDays[day] : [];
    result.days[day] = periods
      .filter((p) => p && typeof p === "object")
      .map((p) => ({ open: typeof p.open === "string" ? p.open : "", close: typeof p.close === "string" ? p.close : "" }));
  }
  return result;
}

// Drops incomplete periods (missing open or close) and empty timezone —
// never invents a value. If truly nothing is set (no timezone, every day
// empty), returns null so the column stays genuinely unset rather than
// storing a misleadingly "complete-looking" empty object.
function workingHoursToPayload(wh) {
  const timezone = wh.timezone.trim();
  const days = {};
  let hasAnyPeriod = false;

  for (const day of DAY_KEYS) {
    const periods = (wh.days[day] || []).filter((p) => p.open && p.close);
    days[day] = periods;
    if (periods.length > 0) hasAnyPeriod = true;
  }

  if (!timezone && !hasAnyPeriod) return null;

  return { timezone: timezone || null, days };
}

function WorkingHoursEditor({ value, onChange, t }) {
  function setTimezone(timezone) {
    onChange({ ...value, timezone });
  }

  function setDayClosed(day, closed) {
    onChange({
      ...value,
      days: { ...value.days, [day]: closed ? [] : [{ open: "09:00", close: "17:00" }] },
    });
  }

  function updatePeriod(day, index, field, fieldValue) {
    const periods = value.days[day].map((p, i) => (i === index ? { ...p, [field]: fieldValue } : p));
    onChange({ ...value, days: { ...value.days, [day]: periods } });
  }

  function addPeriod(day) {
    onChange({ ...value, days: { ...value.days, [day]: [...value.days[day], { open: "09:00", close: "17:00" }] } });
  }

  function removePeriod(day, index) {
    onChange({ ...value, days: { ...value.days, [day]: value.days[day].filter((_, i) => i !== index) } });
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.timezone")}</label>
        <input
          className={inputClass}
          value={value.timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder={t("settings.timezonePlaceholder")}
        />
      </div>

      <div className="space-y-3">
        {DAY_KEYS.map((day) => {
          const periods = value.days[day];
          const closed = periods.length === 0;
          return (
            <div key={day} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-bold text-slate-800">{t(`settings.days.${day}`)}</span>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input type="checkbox" checked={closed} onChange={(e) => setDayClosed(day, e.target.checked)} />
                  {t("settings.workingHoursClosed")}
                </label>
              </div>

              {!closed && (
                <div className="mt-3 space-y-2">
                  {periods.map((period, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-slate-500">{t("settings.workingHoursFrom")}</span>
                      <input
                        type="time"
                        value={period.open}
                        onChange={(e) => updatePeriod(day, index, "open", e.target.value)}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      />
                      <span className="text-xs font-semibold text-slate-500">{t("settings.workingHoursTo")}</span>
                      <input
                        type="time"
                        value={period.close}
                        onChange={(e) => updatePeriod(day, index, "close", e.target.value)}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      />
                      {periods.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removePeriod(day, index)}
                          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                        >
                          {t("settings.workingHoursRemovePeriod")}
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => addPeriod(day)}
                    className="text-xs font-semibold text-indigo-600 hover:underline"
                  >
                    + {t("settings.workingHoursAddPeriod")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ClientSettings() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const { setClientDefaultLanguage } = useLanguage();
  // client_id is resolved once at login via client_users (see Login.jsx).
  const clientId = user?.client_id || null;
  const [form, setForm] = useState({ business_name: "", email: "", phone: "", address: "", business_description: "", welcome_message: "", default_reply: "", closing_message: "", website: "" });
  const [workingHours, setWorkingHours] = useState(emptyWorkingHours());
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
      setForm({ business_name: data.business_name || "", email: data.email || "", phone: data.phone || "", address: data.address || "", business_description: data.business_description || "", welcome_message: data.welcome_message || "", default_reply: data.default_reply || "", closing_message: data.closing_message || "", website: data.website || "" });
      // Absent if the language migration hasn't been applied yet — stays
      // null, and the buttons below simply show neither as selected.
      setDefaultLanguage(data.default_language || null);
      // working_hours/timezone: absent (undefined) before the AI Engine V1
      // Phase 1 migration is applied — normalizeWorkingHours degrades that
      // to the same empty/all-closed shape as a genuinely unset value, so
      // this page never crashes on an older schema.
      const normalized = normalizeWorkingHours(data.working_hours);
      if (!normalized.timezone && data.timezone) normalized.timezone = data.timezone;
      setWorkingHours(normalized);
    }
  }

  async function handleSave() {
    try {
      setLoading(true); setMsg("");
      const workingHoursPayload = workingHoursToPayload(workingHours);
      const { error: clientError } = await supabase
        .from("clients")
        .update({
          business_name: form.business_name,
          phone: form.phone,
          address: form.address,
          business_description: form.business_description,
          welcome_message: form.welcome_message,
          default_reply: form.default_reply,
          closing_message: form.closing_message,
          website: form.website || null,
          timezone: workingHours.timezone.trim() || null,
          working_hours: workingHoursPayload,
        })
        .eq("id", clientId);
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
        <div className="space-y-5">
          <div className={`${cardClass} p-6`}>
            <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl">🏢</div><div><h3 className="font-black text-slate-950">{t("settings.businessInfoTitle")}</h3><p className="text-xs text-slate-500">{t("settings.businessInfoSubtitle")}</p></div></div>
            <div className="space-y-4">
              <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessName")}</label><input className={inputClass} value={form.business_name} onChange={(e) => update("business_name", e.target.value)} /></div>
              <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.email")}</label><input className={inputClass} value={form.email} disabled /><p className="mt-1 text-xs text-slate-400">{t("settings.emailHint")}</p></div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2"><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.phone")}</label><input className={inputClass} value={form.phone} onChange={(e) => update("phone", e.target.value)} /></div><div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.address")}</label><input className={inputClass} value={form.address} onChange={(e) => update("address", e.target.value)} /></div></div>
              <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.website")}</label><input className={inputClass} value={form.website} onChange={(e) => update("website", e.target.value)} placeholder={t("settings.websitePlaceholder")} /></div>
              <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessDescription")}</label><textarea rows={5} className={inputClass} value={form.business_description} onChange={(e) => update("business_description", e.target.value)} /></div>
            </div>
          </div>

          <div className={`${cardClass} p-6`}>
            <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-xl">🕒</div><div><h3 className="font-black text-slate-950">{t("settings.workingHoursTitle")}</h3><p className="text-xs text-slate-500">{t("settings.workingHoursSubtitle")}</p></div></div>
            <WorkingHoursEditor value={workingHours} onChange={setWorkingHours} t={t} />
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
