import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BuildingStorefrontIcon, ChatBubbleLeftRightIcon, ClockIcon, LanguageIcon, PencilSquareIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../context/AuthContext.jsx";
import { useLanguage } from "../../context/LanguageContext.jsx";
import LocationsSection from "./LocationsSection.jsx";
import { Card, PageHeader, cx, ui } from "../../components/app/primitives.jsx";
import { Drawer, Notice, SectionHeader } from "../../components/app/Overlay.jsx";

// Account Settings — presentation-only redesign. Field set, helper text,
// working-hours model/validation, the single Save Settings request and its
// payload, the default-language action and the Locations section are all
// unchanged; only layout and styling follow the Client Portal design system.
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

// Main-page card: read-only summary + Edit/Add Hours (opens the drawer).
function BusinessHoursSummaryCard({ workingHours, onEdit, t }) {
  const hasAnySchedule = DAY_KEYS.some((day) => workingHours.days[day].length > 0);
  const summary = useMemo(() => (hasAnySchedule ? groupWorkingHoursSummary(workingHours, t) : []), [workingHours, hasAnySchedule, t]);

  return (
    <Card as="section" aria-labelledby="settings-hours-title" data-section="hours">
      <SectionHeader
        id="settings-hours-title"
        icon={ClockIcon}
        tone="amber"
        title={t("settings.workingHoursTitle")}
        subtitle={t("settings.workingHoursSubtitle")}
        action={
          <button type="button" onClick={onEdit} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50">
            <PencilSquareIcon className="h-4 w-4" />
            {hasAnySchedule ? t("settings.workingHoursEditButton") : t("settings.workingHoursAddButton")}
          </button>
        }
      />

      {!hasAnySchedule ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-500">{t("settings.workingHoursNotSet")}</p>
      ) : (
        <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200/80 text-sm">
          {summary.map((row, i) => (
            <div key={i} className="flex items-start justify-between gap-3 px-3 py-2">
              <dt className="font-medium text-slate-700">{row.label}</dt>
              <dd className="text-slate-600" dir="ltr">{row.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {hasAnySchedule && workingHours.timezone && (
        <p className="mt-2 text-xs text-slate-500">
          {t("settings.timezone")}: <span dir="ltr">{workingHours.timezone}</span>
        </p>
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

  const field = (key, labelKey, extra = {}) => (
    <div className={extra.className}>
      <label htmlFor={`settings-${key}`} className={ui.label}>{t(labelKey)}</label>
      <input
        id={`settings-${key}`}
        className={inputClass}
        value={form[key]}
        onChange={(e) => update(key, e.target.value)}
        disabled={extra.disabled}
        dir={extra.dir || "auto"}
        placeholder={extra.placeholder}
      />
      {extra.hint && <p className="mt-1 text-xs text-slate-500">{extra.hint}</p>}
    </div>
  );

  const messageField = (key, labelKey, placeholderKey) => (
    <div>
      <label htmlFor={`settings-${key}`} className={ui.label}>{t(labelKey)}</label>
      <textarea
        id={`settings-${key}`}
        rows={3}
        dir="auto"
        className={cx(inputClass, "min-h-[96px] resize-y leading-6")}
        value={form[key]}
        onChange={(e) => update(key, e.target.value)}
        placeholder={t(placeholderKey)}
      />
    </div>
  );

  const saveButton = (
    <button type="button" onClick={handleSave} disabled={loading} className={ui.btnPrimary}>
      {loading ? t("settings.saving") : t("settings.save")}
    </button>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t("settings.title")} description={t("settings.subtitle")} actions={saveButton} />

      {msg && <Notice tone={isSuccessMsg ? "success" : "error"}>{msg}</Notice>}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        {/* Main column */}
        <div className="min-w-0 space-y-4">
          {/* A. Business Information */}
          <Card as="section" aria-labelledby="settings-business-title" data-section="business">
            <SectionHeader id="settings-business-title" icon={BuildingStorefrontIcon} title={t("settings.businessInfoTitle")} subtitle={t("settings.businessInfoSubtitle")} />
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
              {field("business_name", "settings.businessName")}
              {field("email", "settings.email", { disabled: true, dir: "ltr", hint: t("settings.emailHint") })}
              {field("phone", "settings.phone", { dir: "ltr" })}
              {field("website", "settings.website", { dir: "ltr", placeholder: t("settings.websitePlaceholder") })}
              {field("address", "settings.address", { className: "md:col-span-2" })}
              <div className="md:col-span-2">
                <label htmlFor="settings-business_description" className={ui.label}>{t("settings.businessDescription")}</label>
                <textarea
                  id="settings-business_description"
                  rows={3}
                  dir="auto"
                  className={cx(inputClass, "min-h-[96px] resize-y leading-6")}
                  value={form.business_description}
                  onChange={(e) => update("business_description", e.target.value)}
                />
              </div>
            </div>
          </Card>

          {/* Business Locations — own load/save lifecycle (each action persists
              immediately via the locations API), not part of Save Settings. */}
          <LocationsSection clientId={clientId} actorUserId={user?.id} />

          {/* C. Conversation Messages */}
          <Card as="section" aria-labelledby="settings-messages-title" data-section="messages">
            <SectionHeader id="settings-messages-title" icon={ChatBubbleLeftRightIcon} tone="emerald" title={t("settings.conversationMessagesTitle")} subtitle={t("settings.conversationMessagesSubtitle")} />
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-3">
              {messageField("welcome_message", "settings.welcomeMessage", "settings.welcomeMessagePlaceholder")}
              {messageField("default_reply", "settings.defaultReply", "settings.defaultReplyPlaceholder")}
              {messageField("closing_message", "settings.closingMessage", "settings.closingMessagePlaceholder")}
            </div>
          </Card>
        </div>

        {/* Side column */}
        <div className="min-w-0 space-y-4">
          {/* B. Business Hours (summary; edited in the drawer) */}
          <BusinessHoursSummaryCard workingHours={workingHours} onEdit={openHoursDrawer} t={t} />

          {/* D. Language & Regional */}
          <Card as="section" aria-labelledby="settings-regional-title" data-section="regional">
            <SectionHeader id="settings-regional-title" icon={LanguageIcon} tone="sky" title={t("settings.regionalSettingsTitle")} subtitle={t("settings.regionalSettingsSubtitle")} />

            <p id="settings-default-language" className={ui.label}>{t("settings.defaultLanguageTitle")}</p>
            <div role="group" aria-labelledby="settings-default-language" className="inline-flex h-9 items-center rounded-xl border border-slate-200 bg-white p-0.5">
              {[
                ["ar", "settings.defaultLanguageArabic"],
                ["en", "settings.defaultLanguageEnglish"],
              ].map(([lang, key]) => (
                <button
                  key={lang}
                  type="button"
                  disabled={langSaving}
                  aria-pressed={defaultLanguage === lang}
                  onClick={() => handleDefaultLanguageChange(lang)}
                  className={cx(
                    "h-full rounded-lg px-4 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50",
                    defaultLanguage === lang ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
                  )}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            {langMsg && <p role="status" className="mt-2 text-xs font-medium text-emerald-700">{langMsg}</p>}
            <p className="mt-2 text-xs text-slate-500">{t("settings.defaultLanguageSubtitle")}</p>

            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="text-xs font-medium text-slate-500">{t("settings.timezone")}</p>
              <div className="mt-0.5 flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-800" dir="ltr">{workingHours.timezone || "—"}</span>
                <button type="button" onClick={openHoursDrawer} className="text-xs font-semibold text-indigo-600 hover:underline">
                  {t("settings.timezoneEditHint")}
                </button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <div className="flex justify-end">{saveButton}</div>

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
