import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";

// SaaS-settings visual language for this page (full redesign pass):
// no card containers for simple values, no decorative icons — typography
// hierarchy + hairline dividers + compact settings rows. Business Profile
// remains the one real inline form (explicit product decision — those
// fields belong together as a natural editing surface). Everything else
// (Business Hours, Timezone, Conversation messages) is a settings ROW
// with a preview and an Edit/Change action that opens ONE reusable
// drawer — see <SettingsDrawer> below, the single interaction pattern
// used everywhere on this page except Default Language, which is a
// trivial 2-option inline control with its own pre-existing immediate-
// save behavior, called out explicitly rather than hidden.
const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-500";

// AI Engine V1 — Phase 2. Working hours (clients.working_hours jsonb):
//   { "timezone": "Asia/Hebron", "days": { "sunday": [{"open","close"}], "friday": [] } }
// One empty-array day = closed that day. Multiple entries in one day's
// array = multiple periods (split shifts). No holiday/exception
// scheduling yet (out of scope for v1, per the approved architecture).
// UNCHANGED in this visual pass — only presentation moved.
const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday"];

// A practical, curated list rather than the full ~450-zone IANA database —
// "searchable/select-style", not "make the user scroll a giant list".
// Asia/Hebron included per explicit requirement; the rest cover this
// product's actual market plus common reference zones. The <input> below
// still accepts any typed IANA string (never blocks on an unlisted zone),
// this list only powers the <datalist> suggestions.
const COMMON_TIMEZONES = [
  "Asia/Hebron",
  "Asia/Gaza",
  "Asia/Jerusalem",
  "Asia/Amman",
  "Asia/Beirut",
  "Asia/Damascus",
  "Asia/Baghdad",
  "Asia/Riyadh",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Dubai",
  "Africa/Cairo",
  "Europe/Istanbul",
  "Europe/London",
  "UTC",
];

const MESSAGE_FIELDS = {
  welcome_message: { labelKey: "settings.welcomeMessage", placeholderKey: "settings.welcomeMessagePlaceholder" },
  default_reply: { labelKey: "settings.defaultReply", placeholderKey: "settings.defaultReplyPlaceholder" },
  closing_message: { labelKey: "settings.closingMessage", placeholderKey: "settings.closingMessagePlaceholder" },
};

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

function cloneWorkingHours(wh) {
  const days = {};
  for (const day of DAY_KEYS) days[day] = wh.days[day].map((p) => ({ ...p }));
  return { timezone: wh.timezone, days };
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

// v1 rule, per explicit product decision: no overnight periods. A period
// is invalid if either time is missing, or close <= open (string
// comparison is correct for same-day "HH:MM" values). Returns
// { "sunday-0": "message", ... } — empty object = fully valid.
function validateWorkingHours(wh, t) {
  const errors = {};
  for (const day of DAY_KEYS) {
    (wh.days[day] || []).forEach((period, index) => {
      if (!period.open || !period.close) return; // incomplete rows are silently dropped on save, not an error
      if (period.close <= period.open) {
        errors[`${day}-${index}`] = t("settings.workingHoursInvalidPeriod");
      }
    });
  }
  return errors;
}

function formatTime12h(time, t) {
  if (!time) return "";
  const [hStr, mStr] = time.split(":");
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return time;
  const period = h >= 12 ? t("settings.pm") : t("settings.am");
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr || "00"} ${period}`;
}

function periodsToText(periods, t) {
  if (!periods || periods.length === 0) return t("settings.workingHoursClosed");
  return periods.map((p) => `${formatTime12h(p.open, t)} – ${formatTime12h(p.close, t)}`).join(", ");
}

function dayScheduleKey(periods) {
  if (!periods || periods.length === 0) return "closed";
  return periods.map((p) => `${p.open}-${p.close}`).join(",");
}

// Groups CONSECUTIVE days (in Sunday->Saturday order) that share the
// exact same schedule into one summary row — "Sun–Thu · 9:00 AM –
// 5:00 PM" instead of 5 identical lines. Non-consecutive matches are
// deliberately NOT merged — only real runs, matching how a person reads
// a weekly schedule.
function groupWorkingHoursSummary(wh, t) {
  const groups = [];
  let current = null;
  for (const day of DAY_KEYS) {
    const key = dayScheduleKey(wh.days[day]);
    if (current && current.key === key) {
      current.days.push(day);
    } else {
      current = { key, days: [day] };
      groups.push(current);
    }
  }

  return groups.map((group) => {
    let label;
    if (group.days.length === DAY_KEYS.length) {
      label = t("settings.workingHoursEveryDay");
    } else if (group.days.length > 1) {
      const first = group.days[0];
      const last = group.days[group.days.length - 1];
      label = `${t(`settings.daysShort.${first}`)}–${t(`settings.daysShort.${last}`)}`;
    } else {
      label = t(`settings.days.${group.days[0]}`);
    }
    return `${label} · ${periodsToText(wh.days[group.days[0]], t)}`;
  });
}

function TimezoneField({ value, onChange, t }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.timezone")}</label>
      <input
        list="ar-timezone-options"
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("settings.timezonePlaceholder")}
      />
      <datalist id="ar-timezone-options">
        {COMMON_TIMEZONES.map((tz) => (
          <option key={tz} value={tz} />
        ))}
      </datalist>
    </div>
  );
}

// Compact one-row-per-day schedule + bulk-copy toolbar + timezone. Lives
// ONLY inside the shared drawer — never on the main settings page. A day
// with periods.length === 0 is "closed" — no separate boolean needed,
// matching the storage shape exactly.
function WorkingHoursEditor({ value, onChange, errors, t }) {
  const [copySource, setCopySource] = useState("sunday");

  function setDayOpen(day, open) {
    onChange({
      ...value,
      days: { ...value.days, [day]: open ? [{ open: "09:00", close: "17:00" }] : [] },
    });
  }

  function updatePeriod(day, index, field, fieldValue) {
    const periods = value.days[day].map((p, i) => (i === index ? { ...p, [field]: fieldValue } : p));
    onChange({ ...value, days: { ...value.days, [day]: periods } });
  }

  function addPeriod(day) {
    const last = value.days[day][value.days[day].length - 1];
    const next = last ? { open: last.close, close: last.close } : { open: "09:00", close: "17:00" };
    onChange({ ...value, days: { ...value.days, [day]: [...value.days[day], next] } });
  }

  function removePeriod(day, index) {
    onChange({ ...value, days: { ...value.days, [day]: value.days[day].filter((_, i) => i !== index) } });
  }

  function applyCopy(targetDays) {
    const source = value.days[copySource] || [];
    const cloned = source.map((p) => ({ ...p }));
    const days = { ...value.days };
    for (const day of targetDays) {
      if (day === copySource) continue;
      days[day] = cloned.map((p) => ({ ...p }));
    }
    onChange({ ...value, days });
  }

  return (
    <div className="space-y-4">
      <TimezoneField value={value.timezone} onChange={(timezone) => onChange({ ...value, timezone })} t={t} />

      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50 p-3">
        <span className="text-xs font-semibold text-slate-500">{t("settings.workingHoursCopyFrom")}</span>
        <select
          value={copySource}
          onChange={(e) => setCopySource(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold"
        >
          {DAY_KEYS.map((day) => (
            <option key={day} value={day}>{t(`settings.days.${day}`)}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => applyCopy(WEEKDAY_KEYS)}
          className="rounded-xl border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
        >
          {t("settings.workingHoursApplyWeekdays")}
        </button>
        <button
          type="button"
          onClick={() => applyCopy(DAY_KEYS)}
          className="rounded-xl border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
        >
          {t("settings.workingHoursApplyAllDays")}
        </button>
      </div>

      <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
        {DAY_KEYS.map((day) => {
          const periods = value.days[day];
          const open = periods.length > 0;
          return (
            <div key={day} className="px-3 py-2.5 sm:px-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label className="flex w-full items-center justify-between gap-3 sm:w-36">
                  <span className="text-sm font-bold text-slate-800">{t(`settings.days.${day}`)}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={open}
                    onClick={() => setDayOpen(day, !open)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${open ? "bg-emerald-500" : "bg-slate-300"}`}
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${open ? "left-[calc(100%-1.375rem)]" : "left-0.5"}`} />
                  </button>
                </label>

                {!open && <span className="text-xs font-semibold text-slate-400">{t("settings.workingHoursClosed")}</span>}

                {open && (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    {periods.map((period, index) => {
                      const errorKey = `${day}-${index}`;
                      const hasError = Boolean(errors[errorKey]);
                      return (
                        <div key={index} className="flex flex-wrap items-center gap-1.5">
                          <input
                            type="time"
                            value={period.open}
                            onChange={(e) => updatePeriod(day, index, "open", e.target.value)}
                            className={`rounded-xl border px-2 py-1.5 text-sm ${hasError ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                          />
                          <span className="text-slate-400">→</span>
                          <input
                            type="time"
                            value={period.close}
                            onChange={(e) => updatePeriod(day, index, "close", e.target.value)}
                            className={`rounded-xl border px-2 py-1.5 text-sm ${hasError ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                          />
                          {periods.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removePeriod(day, index)}
                              className="rounded-lg px-1.5 py-1 text-xs font-bold text-rose-500 hover:bg-rose-50"
                              aria-label={t("settings.workingHoursRemovePeriod")}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => addPeriod(day)}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50"
                    >
                      + {t("settings.workingHoursAddPeriod")}
                    </button>
                  </div>
                )}
              </div>

              {Object.keys(errors).some((k) => k.startsWith(`${day}-`)) && (
                <p className="mt-1 text-xs font-semibold text-rose-600">{t("settings.workingHoursInvalidPeriod")}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One compact settings row: label + description (preview/summary/value)
// on the start side, an optional "Edit ›" / "Change ›" action on the end
// side. This — not a card — is the base unit of the Business
// Configuration and Conversation sections.
function SettingsRow({ label, actionLabel, onAction, children }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-slate-100 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-800">{label}</p>
        <div className="mt-0.5 space-y-0.5 text-sm text-slate-500">{children}</div>
      </div>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 self-start text-sm font-semibold text-indigo-600 transition hover:text-indigo-700 sm:self-center"
        >
          {actionLabel} <span aria-hidden="true">›</span>
        </button>
      )}
    </div>
  );
}

function SectionHeading({ children }) {
  return <h3 className="mb-1 text-xs font-bold uppercase tracking-[0.15em] text-slate-500">{children}</h3>;
}

// The ONE reusable focused-editing surface for this page: Business Hours
// (full editor) and each Conversation message field (single textarea)
// all render through this exact shell — same header/footer/Apply-Cancel
// behavior everywhere, per the approved interaction model. Draft-only:
// Apply commits into this page's in-memory form state (no network call);
// closing via ✕/backdrop discards the draft. The page's single "Save
// Settings" button is the only thing that ever persists to Supabase.
function SettingsDrawer({ title, subtitle, onApply, onCancel, applyDisabled, hint, children, t }) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-slate-950/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="h-full w-full max-w-xl overflow-y-auto border-s border-slate-200 bg-white shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 p-5 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-black text-slate-950">{title}</h2>
              {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
            </div>
            <button type="button" onClick={onCancel} className="rounded-2xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {children}
          {hint}
          <div className="flex gap-3 border-t border-slate-100 pt-5">
            <button
              type="button"
              onClick={onApply}
              disabled={applyDisabled}
              className="flex-1 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {t("settings.workingHoursApply")}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
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
  const [savedForm, setSavedForm] = useState(form);
  const [workingHours, setWorkingHours] = useState(emptyWorkingHours());
  const [savedWorkingHours, setSavedWorkingHours] = useState(workingHours);
  const [defaultLanguage, setDefaultLanguage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [langSaving, setLangSaving] = useState(false);
  const [langMsg, setLangMsg] = useState("");

  // activeDrawer: null | "hours" | "welcome_message" | "default_reply" | "closing_message"
  const [activeDrawer, setActiveDrawer] = useState(null);
  const [hoursDraft, setHoursDraft] = useState(null);
  const [messageDraft, setMessageDraft] = useState("");

  useEffect(() => { if (clientId) loadClient(); }, [clientId]);

  // Auto-dismissing success indicator for the immediate-save Default
  // Language control — a small transient confirmation, not a persistent
  // "saves automatically" label (per explicit product decision: the
  // interaction should be self-explanatory, not narrated).
  useEffect(() => {
    if (!langMsg) return;
    const timeout = setTimeout(() => setLangMsg(""), 2500);
    return () => clearTimeout(timeout);
  }, [langMsg]);

  async function loadClient() {
    const { data, error } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (error) return console.error("Error loading client settings:", error);
    if (data) {
      const loadedForm = { business_name: data.business_name || "", email: data.email || "", phone: data.phone || "", address: data.address || "", business_description: data.business_description || "", welcome_message: data.welcome_message || "", default_reply: data.default_reply || "", closing_message: data.closing_message || "", website: data.website || "" };
      setForm(loadedForm);
      setSavedForm(loadedForm);
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
      setSavedWorkingHours(normalized);
    }
  }

  function openHoursDrawer() {
    setHoursDraft(cloneWorkingHours(workingHours));
    setActiveDrawer("hours");
  }

  function openMessageDrawer(field) {
    setMessageDraft(form[field]);
    setActiveDrawer(field);
  }

  function closeDrawer() {
    setActiveDrawer(null);
    setHoursDraft(null);
    setMessageDraft("");
  }

  const hoursDraftErrors = useMemo(() => (hoursDraft ? validateWorkingHours(hoursDraft, t) : {}), [hoursDraft, t]);
  const hoursDraftHasErrors = Object.keys(hoursDraftErrors).length > 0;

  function applyDrawer() {
    if (activeDrawer === "hours") {
      if (hoursDraftHasErrors) return; // Apply is disabled in this state; defensive no-op
      setWorkingHours(hoursDraft);
    } else if (activeDrawer) {
      setForm((prev) => ({ ...prev, [activeDrawer]: messageDraft }));
    }
    closeDrawer();
  }

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedForm) || JSON.stringify(workingHours) !== JSON.stringify(savedWorkingHours),
    [form, savedForm, workingHours, savedWorkingHours]
  );

  async function handleSave() {
    // Safety net only — the drawer's own Apply button already blocks on
    // invalid periods, so workingHours here should always be valid by
    // the time Save is reachable; this just avoids ever persisting a bad
    // value if that ever changes.
    if (Object.keys(validateWorkingHours(workingHours, t)).length > 0) {
      setMsg(t("settings.workingHoursHasErrors"));
      return;
    }
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
      setSavedForm(form);
      setSavedWorkingHours(workingHours);
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

  const hasSchedule = DAY_KEYS.some((day) => workingHours.days[day].length > 0);
  const hoursSummaryLines = useMemo(() => (hasSchedule ? groupWorkingHoursSummary(workingHours, t) : []), [workingHours, hasSchedule, t]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-indigo-600">{t("settings.badge")}</p>
          <h2 className="mt-1 text-2xl font-black text-slate-950">{t("settings.title")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("settings.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          {isDirty && <span className="text-xs font-semibold text-amber-600">• {t("settings.unsavedChanges")}</span>}
          <button onClick={handleSave} disabled={loading} className="h-11 rounded-2xl bg-indigo-600 px-5 text-sm font-bold text-white shadow-lg shadow-indigo-200 disabled:opacity-60">{loading ? t("settings.saving") : t("settings.save")}</button>
        </div>
      </div>

      {msg && <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${isSuccessMsg ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-red-100 bg-red-50 text-red-700"}`}>{msg}</div>}

      {/* A. Business Profile — the one real inline form. */}
      <section>
        <SectionHeading>{t("settings.businessInfoTitle")}</SectionHeading>
        <div className="space-y-4 pt-3">
          <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessName")}</label><input className={inputClass} value={form.business_name} onChange={(e) => update("business_name", e.target.value)} /></div>
          <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessDescription")}</label><textarea rows={3} className={inputClass} value={form.business_description} onChange={(e) => update("business_description", e.target.value)} /></div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.email")}</label><input className={inputClass} value={form.email} disabled /><p className="mt-1 text-xs text-slate-400">{t("settings.emailHint")}</p></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.phone")}</label><input className={inputClass} value={form.phone} onChange={(e) => update("phone", e.target.value)} /></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.website")}</label><input className={inputClass} value={form.website} onChange={(e) => update("website", e.target.value)} placeholder={t("settings.websitePlaceholder")} /></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.address")}</label><input className={inputClass} value={form.address} onChange={(e) => update("address", e.target.value)} /></div>
          </div>
        </div>
      </section>

      {/* B. Business Configuration — Business Hours, Timezone, Default
          Language, as compact dividered rows. Timezone appears once,
          routed to the same drawer as Business Hours. */}
      <section>
        <SectionHeading>{t("settings.businessConfigTitle")}</SectionHeading>
        <div>
          <SettingsRow
            label={t("settings.workingHoursTitle")}
            actionLabel={hasSchedule ? t("settings.workingHoursEditButton") : t("settings.workingHoursAddButton")}
            onAction={openHoursDrawer}
          >
            {hasSchedule ? hoursSummaryLines.map((line, i) => <p key={i}>{line}</p>) : <p className="text-slate-400">{t("settings.workingHoursNotSet")}</p>}
          </SettingsRow>

          <SettingsRow label={t("settings.timezone")} actionLabel={t("settings.change")} onAction={openHoursDrawer}>
            <p>{workingHours.timezone || "—"}</p>
          </SettingsRow>

          <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-sm font-semibold text-slate-800">{t("settings.defaultLanguageTitle")}</p>
            <div className="flex items-center gap-3">
              {langMsg && <span className="text-xs font-semibold text-emerald-600">{langMsg}</span>}
              <div className="inline-flex rounded-full border border-slate-200 p-0.5">
                <button
                  type="button"
                  disabled={langSaving}
                  onClick={() => handleDefaultLanguageChange("ar")}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                    defaultLanguage === "ar" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t("settings.defaultLanguageArabic")}
                </button>
                <button
                  type="button"
                  disabled={langSaving}
                  onClick={() => handleDefaultLanguageChange("en")}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                    defaultLanguage === "en" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t("settings.defaultLanguageEnglish")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* C. Conversation — one row per message, truncated preview, same
          drawer pattern as Business Hours. */}
      <section>
        <SectionHeading>{t("settings.conversationMessagesTitle")}</SectionHeading>
        <div>
          {Object.entries(MESSAGE_FIELDS).map(([field, meta]) => (
            <SettingsRow key={field} label={t(meta.labelKey)} actionLabel={t("common.edit")} onAction={() => openMessageDrawer(field)}>
              <p className="truncate" dir="auto">
                {form[field] ? `“${form[field]}”` : <span className="text-slate-400">{t(meta.placeholderKey)}</span>}
              </p>
            </SettingsRow>
          ))}
        </div>
      </section>

      {activeDrawer === "hours" && hoursDraft && (
        <SettingsDrawer
          title={t("settings.workingHoursDrawerTitle")}
          subtitle={t("settings.workingHoursDrawerSubtitle")}
          onApply={applyDrawer}
          onCancel={closeDrawer}
          applyDisabled={hoursDraftHasErrors}
          hint={<p className="text-xs text-slate-400">{t("settings.workingHoursDrawerHint")}</p>}
          t={t}
        >
          <WorkingHoursEditor value={hoursDraft} onChange={setHoursDraft} errors={hoursDraftErrors} t={t} />
          {hoursDraftHasErrors && (
            <div className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
              {t("settings.workingHoursHasErrors")}
            </div>
          )}
        </SettingsDrawer>
      )}

      {activeDrawer && activeDrawer !== "hours" && (
        <SettingsDrawer
          title={t(MESSAGE_FIELDS[activeDrawer].labelKey)}
          subtitle={t("settings.editFieldSubtitle")}
          onApply={applyDrawer}
          onCancel={closeDrawer}
          applyDisabled={false}
          t={t}
        >
          <textarea
            rows={6}
            className={inputClass}
            value={messageDraft}
            onChange={(e) => setMessageDraft(e.target.value)}
            placeholder={t(MESSAGE_FIELDS[activeDrawer].placeholderKey)}
            autoFocus
          />
        </SettingsDrawer>
      )}
    </div>
  );
}
