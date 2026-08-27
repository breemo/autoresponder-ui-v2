import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";
import LocationsSection from "./LocationsSection.jsx";

const inputClass = "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-50 disabled:bg-slate-50 disabled:text-slate-500";
const cardClass = "rounded-3xl border border-slate-200 bg-white shadow-sm";

// AI Engine V1 — Phase 2. Working hours (clients.working_hours jsonb):
//   { "timezone": "Asia/Hebron", "days": { "sunday": [{"open","close"}], "friday": [] } }
// One empty-array day = closed that day. Multiple entries in one day's
// array = multiple periods (split shifts). No holiday/exception
// scheduling yet (out of scope for v1, per the approved architecture).
// UNCHANGED in this UI/UX pass — only how it's edited/displayed moved.
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
// exact same schedule into one summary row — "Sun – Thu / 9:00 AM –
// 5:00 PM" instead of 5 identical lines. Non-consecutive matches (e.g.
// Sunday and Saturday happening to share hours but Monday differs) are
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
      label = `${t(`settings.daysShort.${first}`)} – ${t(`settings.daysShort.${last}`)}`;
    } else {
      label = t(`settings.days.${group.days[0]}`);
    }
    return { label, text: periodsToText(wh.days[group.days[0]], t) };
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
// ONLY inside the Edit Hours drawer now — never on the main settings page
// (see BusinessHoursSummaryCard for what the page itself shows). A day
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

// Main-page card: read-only summary only — no toggles, no time inputs,
// no bulk-copy controls. This is the entire point of the progressive-
// disclosure rework: a rarely-edited setting should not permanently
// occupy this much of the page. "Edit Hours" (or "Add Hours" if nothing
// is configured yet) is the only control here.
function BusinessHoursSummaryCard({ workingHours, onEdit, t }) {
  const hasAnySchedule = DAY_KEYS.some((day) => workingHours.days[day].length > 0);
  const summary = useMemo(() => (hasAnySchedule ? groupWorkingHoursSummary(workingHours, t) : []), [workingHours, hasAnySchedule, t]);

  return (
    <div className={`${cardClass} p-6`}>
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-xl">🕒</div>
        <div>
          <h3 className="font-black text-slate-950">{t("settings.workingHoursTitle")}</h3>
          <p className="text-xs text-slate-500">{t("settings.workingHoursSubtitle")}</p>
        </div>
      </div>

      {!hasAnySchedule ? (
        <p className="text-sm text-slate-400">{t("settings.workingHoursNotSet")}</p>
      ) : (
        <div className="space-y-1.5 text-sm">
          {summary.map((row, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <span className="font-semibold text-slate-700">{row.label}</span>
              <span className="text-slate-500">{row.text}</span>
            </div>
          ))}
          {workingHours.timezone && (
            <p className="pt-2 text-xs text-slate-400">{t("settings.timezone")}: {workingHours.timezone}</p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onEdit}
        className="mt-4 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-bold text-indigo-700 hover:bg-indigo-50"
      >
        {hasAnySchedule ? t("settings.workingHoursEditButton") : t("settings.workingHoursAddButton")}
      </button>
    </div>
  );
}

// Drawer on desktop (side panel, matches the exact pattern already used
// by AdminClientSettings.jsx's feature drawer for visual consistency
// across the app), full-width/full-screen on mobile (the panel is
// `w-full`, only capped by `max-w-xl` above the `sm` breakpoint).
//
// Save model, deliberately unambiguous (no double-save): "Apply" commits
// the draft into this page's `workingHours` form state ONLY — it does
// NOT call Supabase. The page's single "Save Settings" button (top of
// page, unchanged) is the only thing that ever persists to the database,
// for every field on this page including hours. Closing via ✕/backdrop
// discards the draft instead.
function BusinessHoursDrawer({ draft, onDraftChange, onApply, onCancel, t }) {
  const errors = useMemo(() => validateWorkingHours(draft, t), [draft, t]);
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-slate-950/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="h-full w-full max-w-xl overflow-y-auto border-s border-slate-200 bg-white shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 p-5 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-black text-slate-950">{t("settings.workingHoursDrawerTitle")}</h2>
              <p className="mt-1 text-sm text-slate-500">{t("settings.workingHoursDrawerSubtitle")}</p>
            </div>
            <button type="button" onClick={onCancel} className="rounded-2xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          <WorkingHoursEditor value={draft} onChange={onDraftChange} errors={errors} t={t} />

          {hasErrors && (
            <div className="rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
              {t("settings.workingHoursHasErrors")}
            </div>
          )}

          <p className="text-xs text-slate-400">{t("settings.workingHoursDrawerHint")}</p>

          <div className="flex gap-3 border-t border-slate-100 pt-5">
            <button
              type="button"
              onClick={onApply}
              disabled={hasErrors}
              className="flex-1 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {t("settings.workingHoursApply")}
            </button>
            <button type="button" onClick={onCancel} className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50">
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
  const [workingHours, setWorkingHours] = useState(emptyWorkingHours());
  const [hoursDraft, setHoursDraft] = useState(null); // non-null while the drawer is open
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

  function openHoursDrawer() {
    setHoursDraft(cloneWorkingHours(workingHours));
  }

  function applyHoursDraft() {
    if (Object.keys(validateWorkingHours(hoursDraft, t)).length > 0) return; // Apply is disabled in this state; defensive no-op
    setWorkingHours(hoursDraft);
    setHoursDraft(null);
  }

  function cancelHoursDrawer() {
    setHoursDraft(null); // discard — never touches the page's working hours state
  }

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

      {/* A. Business Information — one calm card, no tiny cards split out. */}
      <div className={`${cardClass} p-6`}>
        <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-xl">🏢</div><div><h3 className="font-black text-slate-950">{t("settings.businessInfoTitle")}</h3><p className="text-xs text-slate-500">{t("settings.businessInfoSubtitle")}</p></div></div>
        <div className="space-y-4">
          <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessName")}</label><input className={inputClass} value={form.business_name} onChange={(e) => update("business_name", e.target.value)} /></div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.email")}</label><input className={inputClass} value={form.email} disabled /><p className="mt-1 text-xs text-slate-400">{t("settings.emailHint")}</p></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.phone")}</label><input className={inputClass} value={form.phone} onChange={(e) => update("phone", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.website")}</label><input className={inputClass} value={form.website} onChange={(e) => update("website", e.target.value)} placeholder={t("settings.websitePlaceholder")} /></div>
            <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.address")}</label><input className={inputClass} value={form.address} onChange={(e) => update("address", e.target.value)} /></div>
          </div>
          <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.businessDescription")}</label><textarea rows={4} className={inputClass} value={form.business_description} onChange={(e) => update("business_description", e.target.value)} /></div>
        </div>
      </div>

      {/* AI Engine V1 — Business Voice + Authoritative Locations. Separate
          card, deliberately not merged into Business Information above —
          it owns its own load/save lifecycle (each action persists
          immediately via the locations API) rather than participating in
          this page's single "Save Settings" button. */}
      <LocationsSection clientId={clientId} actorUserId={user?.id} />

      {/* B. Business Hours (summary only) + D. Language & Regional — paired
          side by side so neither is a lonely, mostly-empty full-width card. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <BusinessHoursSummaryCard workingHours={workingHours} onEdit={openHoursDrawer} t={t} />

        <div className={`${cardClass} p-6`}>
          <div className="mb-4">
            <h3 className="font-black text-slate-950">{t("settings.regionalSettingsTitle")}</h3>
            <p className="text-xs text-slate-500">{t("settings.regionalSettingsSubtitle")}</p>
          </div>

          <p className="mb-2 text-xs font-bold text-slate-600">{t("settings.defaultLanguageTitle")}</p>
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
          {langMsg && <p className="mt-2 text-xs font-bold text-indigo-700">{langMsg}</p>}
          <p className="mt-2 text-[11px] text-slate-400">{t("settings.defaultLanguageSubtitle")}</p>

          <div className="mt-5 border-t border-slate-100 pt-4">
            <p className="text-xs font-bold text-slate-600">{t("settings.timezone")}</p>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="text-sm text-slate-700">{workingHours.timezone || "—"}</span>
              <button type="button" onClick={openHoursDrawer} className="text-xs font-semibold text-indigo-600 hover:underline">
                {t("settings.timezoneEditHint")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* C. Conversation Messages — compact, side by side on larger screens
          instead of one tall stacked column. */}
      <div className={`${cardClass} p-6`}>
        <div className="mb-5 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-xl">💬</div><div><h3 className="font-black text-slate-950">{t("settings.conversationMessagesTitle")}</h3><p className="text-xs text-slate-500">{t("settings.conversationMessagesSubtitle")}</p></div></div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.welcomeMessage")}</label><textarea rows={3} className={inputClass} value={form.welcome_message} onChange={(e) => update("welcome_message", e.target.value)} placeholder={t("settings.welcomeMessagePlaceholder")} /></div>
          <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.defaultReply")}</label><textarea rows={3} className={inputClass} value={form.default_reply} onChange={(e) => update("default_reply", e.target.value)} placeholder={t("settings.defaultReplyPlaceholder")} /></div>
          <div><label className="mb-1 block text-sm font-bold text-slate-700">{t("settings.closingMessage")}</label><textarea rows={3} className={inputClass} value={form.closing_message} onChange={(e) => update("closing_message", e.target.value)} placeholder={t("settings.closingMessagePlaceholder")} /></div>
        </div>
      </div>

      {hoursDraft && (
        <BusinessHoursDrawer
          draft={hoursDraft}
          onDraftChange={setHoursDraft}
          onApply={applyHoursDraft}
          onCancel={cancelHoursDrawer}
          t={t}
        />
      )}
    </div>
  );
}
