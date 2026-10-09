import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BuildingStorefrontIcon,
  ChatBubbleBottomCenterTextIcon,
  ChatBubbleLeftRightIcon,
  CheckBadgeIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  EnvelopeIcon,
  GlobeAltIcon,
  HandRaisedIcon,
  LanguageIcon,
  LockClosedIcon,
  MapPinIcon,
  PencilSquareIcon,
  PhoneIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";
import LocationsSection from "./LocationsSection.jsx";
import { Card, StatusPill, cx, ui } from "../../components/app/primitives.jsx";
import { Drawer, Notice, SectionHeader } from "../../components/app/Overlay.jsx";

// Account Settings workspace. Field set, helper text, working-hours model /
// validation, the single Save Settings request and payload, the default-
// language action and the Locations API are unchanged; only the layout and
// presentation are new. Setup status and the unsaved-changes bar are derived
// locally from already-loaded state.
const inputClass = ui.input;
const cardClass = ui.card;

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
      <label htmlFor="ar-timezone-input" className={ui.label}>{t("settings.timezone")}</label>
      <input
        id="ar-timezone-input"
        list="ar-timezone-options"
        dir="ltr"
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
// ONLY inside the Edit Hours drawer (see BusinessHoursSummaryCard for what
// the page itself shows). A day with periods.length === 0 is "closed" — no
// separate boolean needed, matching the storage shape exactly. Logic is
// unchanged; only classes differ.
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

  const timeInput = (hasError) =>
    cx("h-9 rounded-lg border bg-white px-2 text-sm text-slate-800 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50", hasError ? "border-rose-300 bg-rose-50" : "border-slate-200");

  return (
    <div className="space-y-4">
      <TimezoneField value={value.timezone} onChange={(timezone) => onChange({ ...value, timezone })} t={t} />

      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-3">
        <label htmlFor="ar-hours-copy" className="text-xs font-medium text-slate-600">{t("settings.workingHoursCopyFrom")}</label>
        <select
          id="ar-hours-copy"
          value={copySource}
          onChange={(e) => setCopySource(e.target.value)}
          className="h-8 rounded-lg border border-slate-200 bg-white pe-7 ps-2 text-xs font-medium text-slate-700 outline-none focus:border-indigo-300"
        >
          {DAY_KEYS.map((day) => (
            <option key={day} value={day}>{t(`settings.days.${day}`)}</option>
          ))}
        </select>
        <button type="button" onClick={() => applyCopy(WEEKDAY_KEYS)} className="inline-flex h-8 items-center rounded-lg border border-indigo-200 bg-white px-2.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">
          {t("settings.workingHoursApplyWeekdays")}
        </button>
        <button type="button" onClick={() => applyCopy(DAY_KEYS)} className="inline-flex h-8 items-center rounded-lg border border-indigo-200 bg-white px-2.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">
          {t("settings.workingHoursApplyAllDays")}
        </button>
      </div>

      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80">
        {DAY_KEYS.map((day) => {
          const periods = value.days[day];
          const open = periods.length > 0;
          return (
            <div key={day} className="px-3 py-2.5 sm:px-4" data-day={day}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex w-full items-center justify-between gap-3 sm:w-36">
                  <span id={`ar-day-${day}`} className="text-sm font-semibold text-slate-800">{t(`settings.days.${day}`)}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={open}
                    aria-labelledby={`ar-day-${day}`}
                    onClick={() => setDayOpen(day, !open)}
                    className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2", open ? "bg-emerald-500" : "bg-slate-300")}
                  >
                    <span className={cx("absolute h-4 w-4 rounded-full bg-white shadow transition-all", open ? "start-[18px]" : "start-0.5")} />
                  </button>
                </div>

                {!open && <span className="text-xs font-medium text-slate-400">{t("settings.workingHoursClosed")}</span>}

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
                            aria-label={`${t(`settings.days.${day}`)} ${index + 1} — open`}
                            onChange={(e) => updatePeriod(day, index, "open", e.target.value)}
                            className={timeInput(hasError)}
                          />
                          <span className="text-slate-400 rtl:rotate-180" aria-hidden="true">→</span>
                          <input
                            type="time"
                            value={period.close}
                            aria-label={`${t(`settings.days.${day}`)} ${index + 1} — close`}
                            onChange={(e) => updatePeriod(day, index, "close", e.target.value)}
                            className={timeInput(hasError)}
                          />
                          {periods.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removePeriod(day, index)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 hover:bg-rose-50"
                              aria-label={t("settings.workingHoursRemovePeriod")}
                              title={t("settings.workingHoursRemovePeriod")}
                            >
                              <XMarkIcon className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <button type="button" onClick={() => addPeriod(day)} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-50">
                      <PlusIcon className="h-3.5 w-3.5" />
                      {t("settings.workingHoursAddPeriod")}
                    </button>
                  </div>
                )}
              </div>

              {Object.keys(errors).some((k) => k.startsWith(`${day}-`)) && (
                <p className="mt-1 text-xs font-medium text-rose-600">{t("settings.workingHoursInvalidPeriod")}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "HH:MM" -> minutes since midnight (NaN when malformed).
function toMinutes(time) {
  const [h, m] = String(time || "").split(":").map((x) => parseInt(x, 10));
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN;
}

// Weekly overview: one row per day with a 24-hour track showing the stored
// periods to scale (positions use inset-inline-start, so RTL mirrors). Shows
// exactly what is configured — closed days stay "Closed", nothing invented.
function HoursOverview({ workingHours, onEdit, t }) {
  const hasAnySchedule = DAY_KEYS.some((day) => workingHours.days[day].length > 0);
  const todayKey = DAY_KEYS[new Date().getDay()];
  // Each "open – close" range is laid out in the page direction so Arabic
  // AM/PM markers (ص / م) stay attached to their own time.
  const pageDir = (typeof document !== "undefined" && document.documentElement.dir) || "ltr";
  const openDays = DAY_KEYS.filter((day) => workingHours.days[day].length > 0).length;

  return (
    <Card as="section" id="settings-hours" aria-labelledby="settings-hours-title" data-section="hours" className="scroll-mt-20">
      <SectionHeader
        id="settings-hours-title"
        icon={ClockIcon}
        tone="amber"
        title={t("settings.workingHoursTitle")}
        subtitle={t("settings.workingHoursSubtitle")}
        action={
          <button type="button" onClick={onEdit} className={ui.btnSecondary}>
            <PencilSquareIcon className="h-4 w-4" />
            {hasAnySchedule ? t("settings.workingHoursEditButton") : t("settings.workingHoursAddButton")}
          </button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusPill tone={hasAnySchedule ? "emerald" : "amber"} dot>
          {hasAnySchedule ? t("accountSettings.hoursConfigured") : t("accountSettings.hoursNotConfigured")}
        </StatusPill>
        {hasAnySchedule && <span className="text-xs text-slate-500">{t("accountSettings.openDays", { count: openDays })}</span>}
        <span className="ms-auto inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          <GlobeAltIcon className="h-3.5 w-3.5" />
          <span dir="ltr">{workingHours.timezone || t("accountSettings.timezoneNotSet")}</span>
        </span>
      </div>

      {!hasAnySchedule ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center">
          <ClockIcon className="h-8 w-8 text-slate-300" />
          <p className="text-sm font-medium text-slate-600">{t("settings.workingHoursNotSet")}</p>
          <button type="button" onClick={onEdit} className={cx(ui.btnPrimary, "mt-1")}>
            <PlusIcon className="h-4 w-4" />
            {t("settings.workingHoursAddButton")}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200/80" data-testid="hours-week">
          <div className="hidden grid-cols-[92px_minmax(0,1fr)_minmax(150px,auto)] gap-3 border-b border-slate-100 px-3 py-1.5 text-[10px] text-slate-400 sm:grid" aria-hidden="true">
            <span />
            <span className="flex justify-between" dir="ltr">
              <span>0:00</span>
              <span>6:00</span>
              <span>12:00</span>
              <span>18:00</span>
              <span>24:00</span>
            </span>
            <span />
          </div>
          <ul className="divide-y divide-slate-100">
            {DAY_KEYS.map((day) => {
              const periods = workingHours.days[day];
              const open = periods.length > 0;
              const isToday = day === todayKey;
              return (
                <li key={day} data-day-row={day} className={cx("grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3 px-3 py-2 sm:grid-cols-[92px_minmax(0,1fr)_minmax(150px,auto)]", isToday && "bg-indigo-50/40")}>
                  <span className={cx("flex items-center gap-1.5 text-[13px]", isToday ? "font-semibold text-indigo-700" : "font-medium text-slate-700")}>
                    {t(`settings.days.${day}`)}
                    {isToday && <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-label={t("accountSettings.today")} />}
                  </span>
                  <div className="relative hidden h-2.5 overflow-hidden rounded-full bg-slate-100 sm:block" aria-hidden="true">
                    {periods.map((p, i) => {
                      const s = toMinutes(p.open);
                      const e = toMinutes(p.close);
                      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
                      return <span key={i} className="absolute inset-y-0 rounded-full bg-emerald-500" style={{ insetInlineStart: `${(s / 1440) * 100}%`, width: `${((e - s) / 1440) * 100}%` }} />;
                    })}
                  </div>
                  <span className={cx("flex flex-wrap justify-end gap-x-2 text-xs sm:text-[13px]", open ? "font-medium text-slate-800" : "text-slate-400")}>
                    {open
                      ? periods.map((p, i) => (
                          <bdi key={i} dir={pageDir} className="whitespace-nowrap">
                            {formatTime12h(p.open, t)} – {formatTime12h(p.close, t)}
                          </bdi>
                        ))
                      : t("settings.workingHoursClosed")}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

// Drawer. Save model unchanged: "Apply" commits the draft into this page's
// workingHours form state ONLY (no request); the page's single "Save
// Settings" button persists everything. Close/backdrop/Escape discards.
function BusinessHoursDrawer({ draft, onDraftChange, onApply, onCancel, t }) {
  const errors = useMemo(() => validateWorkingHours(draft, t), [draft, t]);
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <Drawer
      open
      onClose={onCancel}
      title={t("settings.workingHoursDrawerTitle")}
      subtitle={t("settings.workingHoursDrawerSubtitle")}
      closeLabel={t("common.close")}
      width="max-w-2xl"
      footer={
        <>
          <button type="button" onClick={onCancel} className={ui.btnSecondary}>{t("common.cancel")}</button>
          <button type="button" onClick={onApply} disabled={hasErrors} className={ui.btnPrimary}>{t("settings.workingHoursApply")}</button>
        </>
      }
    >
      <div className="space-y-4">
        <WorkingHoursEditor value={draft} onChange={onDraftChange} errors={errors} t={t} />
        {hasErrors && <Notice tone="error">{t("settings.workingHoursHasErrors")}</Notice>}
        <p className="text-xs text-slate-500">{t("settings.workingHoursDrawerHint")}</p>
      </div>
    </Drawer>
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
      // Presentation-only baseline for the unsaved-changes bar (same values as setForm above).
      setSavedSnapshot(JSON.stringify({ form: { business_name: data.business_name || "", email: data.email || "", phone: data.phone || "", address: data.address || "", business_description: data.business_description || "", welcome_message: data.welcome_message || "", default_reply: data.default_reply || "", closing_message: data.closing_message || "", website: data.website || "" }, workingHours: normalized }));
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

  // ---- Presentation-only state: unsaved-changes tracking + setup status ----
  // `savedSnapshot` mirrors what was last loaded or successfully saved; it is
  // only compared against, never sent anywhere.
  const [savedSnapshot, setSavedSnapshot] = useState(null);
  const [locationSummary, setLocationSummary] = useState(null);
  const currentSnapshot = JSON.stringify({ form, workingHours });
  useEffect(() => {
    if (isSuccessMsg) setSavedSnapshot(currentSnapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg]);
  const dirty = savedSnapshot !== null && savedSnapshot !== currentSnapshot;

  const PROFILE_KEYS = ["business_name", "email", "phone", "website", "address", "business_description"];
  const MESSAGE_KEYS = ["welcome_message", "default_reply", "closing_message"];
  const profileDone = PROFILE_KEYS.filter((k) => String(form[k] || "").trim()).length;
  const messagesDone = MESSAGE_KEYS.filter((k) => String(form[k] || "").trim()).length;
  const hoursDone = DAY_KEYS.some((day) => workingHours.days[day].length > 0);

  const sections = [
    { id: "settings-profile", icon: BuildingStorefrontIcon, label: t("accountSettings.profileTitle"), done: profileDone === PROFILE_KEYS.length, detail: t("accountSettings.fieldsComplete", { done: profileDone, total: PROFILE_KEYS.length }) },
    { id: "settings-locations", icon: MapPinIcon, label: t("locations.title"), done: !!locationSummary && locationSummary.count > 0, detail: locationSummary ? t("accountSettings.locationsCount", { count: locationSummary.count }) : "…" },
    { id: "settings-hours", icon: ClockIcon, label: t("settings.workingHoursTitle"), done: hoursDone, detail: hoursDone ? t("accountSettings.hoursConfigured") : t("accountSettings.hoursNotConfigured") },
    { id: "settings-regional", icon: LanguageIcon, label: t("settings.regionalSettingsTitle"), done: !!defaultLanguage, detail: defaultLanguage === "ar" ? t("settings.defaultLanguageArabic") : defaultLanguage === "en" ? t("settings.defaultLanguageEnglish") : t("accountSettings.timezoneNotSet") },
    { id: "settings-messages", icon: ChatBubbleLeftRightIcon, label: t("settings.conversationMessagesTitle"), done: messagesDone === MESSAGE_KEYS.length, detail: t("accountSettings.messagesFilled", { done: messagesDone, total: MESSAGE_KEYS.length }) },
  ];
  const doneCount = sections.filter((s) => s.done).length;
  const goTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const saveButton = (extra) => (
    <button type="button" onClick={handleSave} disabled={loading} className={cx(ui.btnPrimary, extra)}>
      <CheckIcon className="h-4 w-4" />
      {loading ? t("settings.saving") : t("settings.save")}
    </button>
  );

  const iconInput = (key, labelKey, Icon, extra = {}) => (
    <div className={extra.className}>
      <label htmlFor={`settings-${key}`} className={ui.label}>{t(labelKey)}</label>
      <div className="relative">
        <Icon className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          id={`settings-${key}`}
          className={cx(inputClass, "ps-9", extra.disabled && "pe-9")}
          value={form[key]}
          onChange={(e) => update(key, e.target.value)}
          disabled={extra.disabled}
          dir={extra.dir || "auto"}
          placeholder={extra.placeholder}
        />
        {extra.disabled && <LockClosedIcon className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />}
      </div>
      {extra.hint && <p className="mt-1 text-xs text-slate-500">{extra.hint}</p>}
    </div>
  );

  const businessName = form.business_name || t("accountSettings.unnamedBusiness");

  return (
    <div className={cx("space-y-5", dirty && "pb-16")}>
      {/* Hero: identity + real setup status */}
      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]" data-testid="settings-hero">
        <div className="flex flex-col gap-4 border-b border-slate-100 bg-gradient-to-b from-indigo-50/60 to-white p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-xl font-bold text-white shadow-sm shadow-indigo-600/30">
              {String(businessName).trim().slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium text-indigo-600">{t("settings.title")}</p>
              <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 rtl:tracking-normal">
                <bdi>{businessName}</bdi>
              </h1>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                {form.email && (
                  <span className="inline-flex items-center gap-1" dir="ltr"><EnvelopeIcon className="h-3.5 w-3.5" />{form.email}</span>
                )}
                {form.website && (
                  <span className="inline-flex items-center gap-1" dir="ltr"><GlobeAltIcon className="h-3.5 w-3.5" />{form.website}</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[180px]">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-600">{t("accountSettings.setupStatus")}</span>
                <span className="font-semibold tabular-nums text-slate-900" data-testid="setup-count">{doneCount}/{sections.length}</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200/70">
                <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${(doneCount / sections.length) * 100}%` }} />
              </div>
            </div>
            {saveButton()}
          </div>
        </div>
        <p className="px-5 py-2.5 text-xs text-slate-500">{t("settings.subtitle")}</p>
      </section>

      {msg && <Notice tone={isSuccessMsg ? "success" : "error"}>{msg}</Notice>}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[240px_minmax(0,1fr)]">
        {/* Section navigation + status (sticky on desktop) */}
        <nav aria-label={t("accountSettings.navTitle")} className="xl:sticky xl:top-20">
          <ul className="flex gap-2 overflow-x-auto pb-1 xl:flex-col xl:gap-1 xl:overflow-visible xl:rounded-2xl xl:border xl:border-slate-200/80 xl:bg-white xl:p-2 xl:pb-2 xl:shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            {sections.map((s) => (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => goTo(s.id)}
                  className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl xl:whitespace-normal border border-slate-200/80 bg-white px-3 py-2 text-start transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 xl:border-0"
                >
                  <s.icon className="h-[18px] w-[18px] shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-slate-800 xl:whitespace-normal">{s.label}</span>
                    <span className="hidden truncate text-[11px] text-slate-500 xl:block">{s.detail}</span>
                  </span>
                  {s.done ? (
                    <CheckCircleIcon className="h-5 w-5 shrink-0 text-emerald-500" aria-label={t("accountSettings.sectionComplete")} />
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-label={t("accountSettings.sectionIncomplete")} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-5">
          {/* Business Profile */}
          <Card as="section" id="settings-profile" aria-labelledby="settings-business-title" data-section="business" className="scroll-mt-20">
            <SectionHeader
              id="settings-business-title"
              icon={BuildingStorefrontIcon}
              title={t("accountSettings.profileTitle")}
              subtitle={t("settings.businessInfoSubtitle")}
              action={<span className="text-xs font-medium tabular-nums text-slate-500">{t("accountSettings.fieldsComplete", { done: profileDone, total: PROFILE_KEYS.length })}</span>}
            />
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 rtl:tracking-normal">{t("accountSettings.identityGroup")}</p>
                {iconInput("business_name", "settings.businessName", BuildingStorefrontIcon)}
                <div>
                  <div className="flex items-center justify-between">
                    <label htmlFor="settings-business_description" className={ui.label}>{t("settings.businessDescription")}</label>
                    <span className="text-[11px] tabular-nums text-slate-400">{t("accountSettings.characters", { count: form.business_description.length })}</span>
                  </div>
                  <textarea
                    id="settings-business_description"
                    rows={5}
                    dir="auto"
                    className={cx(inputClass, "min-h-[132px] resize-y leading-6")}
                    value={form.business_description}
                    onChange={(e) => update("business_description", e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 rtl:tracking-normal">{t("settings.contactLocationTitle")}</p>
                {iconInput("email", "settings.email", EnvelopeIcon, { disabled: true, dir: "ltr", hint: t("settings.emailHint") })}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {iconInput("phone", "settings.phone", PhoneIcon, { dir: "ltr" })}
                  {iconInput("website", "settings.website", GlobeAltIcon, { dir: "ltr", placeholder: t("settings.websitePlaceholder") })}
                </div>
                {iconInput("address", "settings.address", MapPinIcon)}
              </div>
            </div>
          </Card>

          {/* Business Locations — own load/save lifecycle (each action
              persists immediately via the locations API). */}
          <div id="settings-locations" className="scroll-mt-20">
            <LocationsSection clientId={clientId} actorUserId={user?.id} onSummaryChange={setLocationSummary} />
          </div>

          {/* Hours + Language */}
          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
            <HoursOverview workingHours={workingHours} onEdit={openHoursDrawer} t={t} />

            <Card as="section" id="settings-regional" aria-labelledby="settings-regional-title" data-section="regional" className="scroll-mt-20">
              <SectionHeader id="settings-regional-title" icon={LanguageIcon} tone="sky" title={t("settings.regionalSettingsTitle")} subtitle={t("settings.regionalSettingsSubtitle")} />
              <p id="settings-default-language" className={ui.label}>{t("settings.defaultLanguageTitle")}</p>
              <div role="group" aria-labelledby="settings-default-language" className="grid grid-cols-2 gap-2">
                {[
                  ["ar", "settings.defaultLanguageArabic", "ع"],
                  ["en", "settings.defaultLanguageEnglish", "En"],
                ].map(([lang, key, glyph]) => {
                  const active = defaultLanguage === lang;
                  return (
                    <button
                      key={lang}
                      type="button"
                      disabled={langSaving}
                      aria-pressed={active}
                      onClick={() => handleDefaultLanguageChange(lang)}
                      className={cx(
                        "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-start transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50",
                        active ? "border-indigo-400 bg-indigo-50/70 ring-1 ring-indigo-300" : "border-slate-200 hover:border-slate-300"
                      )}
                    >
                      <span className={cx("inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold", active ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600")}>{glyph}</span>
                      <span className="min-w-0 flex-1 text-[13px] font-semibold text-slate-800">{t(key)}</span>
                      {active && <CheckCircleIcon className="h-5 w-5 text-indigo-600" />}
                    </button>
                  );
                })}
              </div>
              {langMsg && <p role="status" className="mt-2 text-xs font-medium text-emerald-700">{langMsg}</p>}
              <p className="mt-2 text-xs text-slate-500">{t("settings.defaultLanguageSubtitle")}</p>

              <div className="mt-4 flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 ring-1 ring-slate-200">
                  <GlobeAltIcon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium text-slate-500">{t("settings.timezone")}</p>
                  <p className="break-all text-sm font-semibold text-slate-900" dir="ltr">{workingHours.timezone || "—"}</p>
                </div>
                <button type="button" onClick={openHoursDrawer} className="shrink-0 text-xs font-semibold text-indigo-600 hover:underline">
                  {t("settings.timezoneEditHint")}
                </button>
              </div>
            </Card>
          </div>

          {/* Conversation Messages */}
          <Card as="section" id="settings-messages" aria-labelledby="settings-messages-title" data-section="messages" className="scroll-mt-20">
            <SectionHeader
              id="settings-messages-title"
              icon={ChatBubbleLeftRightIcon}
              tone="emerald"
              title={t("settings.conversationMessagesTitle")}
              subtitle={t("settings.conversationMessagesSubtitle")}
              action={<span className="text-xs font-medium tabular-nums text-slate-500">{t("accountSettings.messagesFilled", { done: messagesDone, total: MESSAGE_KEYS.length })}</span>}
            />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {[
                ["welcome_message", "settings.welcomeMessage", "settings.welcomeMessagePlaceholder", HandRaisedIcon, "bg-indigo-50 text-indigo-600"],
                ["default_reply", "settings.defaultReply", "settings.defaultReplyPlaceholder", ChatBubbleBottomCenterTextIcon, "bg-sky-50 text-sky-600"],
                ["closing_message", "settings.closingMessage", "settings.closingMessagePlaceholder", CheckBadgeIcon, "bg-emerald-50 text-emerald-600"],
              ].map(([key, labelKey, placeholderKey, Icon, tone]) => (
                <div key={key} className="flex min-w-0 flex-col rounded-xl border border-slate-200/80 bg-white" data-message={key}>
                  <div className="flex items-center gap-2.5 border-b border-slate-100 px-3 py-2.5">
                    <span className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", tone)}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <label htmlFor={`settings-${key}`} className="min-w-0 flex-1 text-[13px] font-semibold text-slate-900">{t(labelKey)}</label>
                    {String(form[key] || "").trim() ? <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-500" /> : <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />}
                  </div>
                  <div className="p-3">
                    <textarea
                      id={`settings-${key}`}
                      rows={5}
                      dir="auto"
                      className={cx(inputClass, "min-h-[120px] resize-y leading-6")}
                      value={form[key]}
                      onChange={(e) => update(key, e.target.value)}
                      placeholder={t(placeholderKey)}
                    />
                    <p className="mt-1 text-end text-[11px] tabular-nums text-slate-400">{t("accountSettings.characters", { count: form[key].length })}</p>
                  </div>
                  <div className="mt-auto rounded-b-xl border-t border-slate-100 bg-slate-50/70 px-3 py-3">
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 rtl:tracking-normal">{t("accountSettings.preview")}</p>
                    <div className="flex items-end gap-2">
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white">
                        {String(businessName).trim().slice(0, 1).toUpperCase()}
                      </span>
                      <p dir="auto" className={cx("max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-es-md px-3 py-2 text-[13px] leading-6 ring-1 ring-inset", form[key].trim() ? "bg-white text-slate-800 ring-slate-200" : "bg-transparent italic text-slate-400 ring-dashed ring-slate-200")}>
                        {form[key].trim() ? form[key] : t("accountSettings.previewEmpty")}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Unsaved-changes bar (same Save Settings action) */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_16px_rgba(15,23,42,0.06)] backdrop-blur" data-testid="unsaved-bar">
          <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-3 xl:ps-16">
            <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              {t("accountSettings.unsavedChanges")}
            </p>
            {saveButton()}
          </div>
        </div>
      )}

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
