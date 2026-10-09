import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  BoltIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClockIcon,
  InboxStackIcon,
  InformationCircleIcon,
  TrophyIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../../context/AuthContext.jsx";
import { formatCount, formatDuration, shortDateTime } from "../../lib/performanceFormat.js";
import { PageHeader, Skeleton, cx, ui } from "../../components/app/primitives.jsx";
import { Drawer } from "../../components/app/Overlay.jsx";
import { EmptyBox, RangePicker, TrendChart, AttributionNote, usePerformance } from "./performance/PerformanceShared.jsx";
import { cycleRows, detailFor, durationRows, groupTimeline, handledSolvedRows, rangeDayKeys, workloadShares } from "./performance/teamCharts.js";

// Team Performance dashboard — client users with PERMISSIONS.TEAM_MANAGEMENT.
// Every number comes from the server-side engine (api/_lib/teamPerformance.js)
// via the unchanged usePerformance request; the charts below only re-plot the
// per-employee values the table already shows (mappers in teamCharts.js).
// No metric math, no invented comparisons. null durations stay "—"; zero
// samples stay "Not enough data". The API has no team-level daily series, so
// there is no team trend chart (only the per-employee trend in the drawer).

// One color per metric, everywhere on the page.
const METRIC_COLORS = { handled: "#4f46e5", solved: "#10b981", firstResponse: "#f59e0b", resolution: "#0ea5e9" };
const SLICE_COLORS = ["#4f46e5", "#7c3aed", "#2563eb", "#a855f7", "#0ea5e9", "#6366f1"];
const OTHERS_COLOR = "#cbd5e1";

const dayLabel = (key, lang) => {
  try {
    return new Date(`${key}T00:00:00Z`).toLocaleDateString(lang === "en" ? "en-US" : "ar-EG", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return key;
  }
};

// Clock time on the same fixed UTC+3 business clock the server groups days by.
const shortTime = (iso, lang) => {
  try {
    return new Date(iso).toLocaleTimeString(lang === "en" ? "en-US" : "ar-EG", { hour: "2-digit", minute: "2-digit", timeZone: "Etc/GMT-3" });
  } catch {
    return "—";
  }
};

// "This week · Oct 5 – Oct 9" from the range the server actually applied.
function RangeChip({ range, pointInTime = false }) {
  const { t, i18n } = useTranslation();
  let text;
  if (pointInTime) text = t("teamDashboard.pointInTime");
  else {
    const keys = rangeDayKeys(range);
    const preset = { today: t("teamPerformance.rangeToday"), week: t("teamPerformance.rangeWeek"), month: t("teamPerformance.rangeMonth"), custom: t("teamPerformance.rangeCustom") }[range?.range];
    const span = keys ? (keys.from === keys.to ? dayLabel(keys.from, i18n.language) : `${dayLabel(keys.from, i18n.language)} – ${dayLabel(keys.to, i18n.language)}`) : "";
    text = [preset, span].filter(Boolean).join(" · ");
  }
  if (!text) return null;
  return (
    <span
      className={cx("inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-medium ring-1 ring-inset", pointInTime ? "bg-violet-50 text-violet-700 ring-violet-100" : "bg-indigo-50 text-indigo-700 ring-indigo-100")}
      data-range-chip={pointInTime ? "now" : "range"}
    >
      <bdi>{text}</bdi>
    </span>
  );
}

function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

// Long lists scroll inside the card (keyboard focusable) instead of growing the page.
function ScrollList({ label, children, testId }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} data-testid={testId} className="max-h-[26rem] overflow-y-auto rounded-lg pe-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
      {children}
    </div>
  );
}

function Bar({ value, max, color, label }) {
  const isNull = value === null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
        {!isNull && <div className="h-full rounded-full" style={{ width: `${(value / max) * 100}%`, backgroundColor: color }} />}
      </div>
      <span className={cx("w-14 shrink-0 text-end text-[11px] font-semibold tabular-nums", isNull ? "text-slate-300" : "text-slate-700")} aria-label={label}>
        {isNull ? "—" : formatCount(value)}
      </span>
    </div>
  );
}

// B. Grouped horizontal bars — readable for 1 or 25 employees, RTL-native.
function HandledSolvedChart({ employees }) {
  const { t } = useTranslation();
  const { rows, max, anyActivity } = handledSolvedRows(employees);
  const handledLabel = t("teamPerformance.conversationsHandled");
  const solvedLabel = t("teamPerformance.conversationsSolved");
  return (
    <div data-testid="team-distribution">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <LegendDot color={METRIC_COLORS.handled} label={handledLabel} />
        <LegendDot color={METRIC_COLORS.solved} label={solvedLabel} />
      </div>
      {!anyActivity && <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500" data-testid="distribution-empty">{t("teamDashboard.noActivity")}</p>}
      <ScrollList label={t("teamDashboard.distributionTitle")}>
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} data-chart-row={r.id} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
              <span className={cx("truncate text-xs font-medium", r.active ? "text-slate-800" : "text-slate-400")} title={r.name}>{r.name}</span>
              <div className="min-w-0 space-y-1">
                <Bar value={r.handled} max={max} color={METRIC_COLORS.handled} label={`${handledLabel}: ${r.handled ?? "—"}`} />
                <Bar value={r.solved} max={max} color={METRIC_COLORS.solved} label={`${solvedLabel}: ${r.solved ?? "—"}`} />
              </div>
            </li>
          ))}
        </ul>
      </ScrollList>
    </div>
  );
}

// C. Workload donut — share of open conversations assigned right now.
function WorkloadDonut({ employees }) {
  const { t } = useTranslation();
  const { total, slices, idle, unknown } = workloadShares(employees);
  if (total === 0) {
    return (
      <div data-testid="team-workload" data-empty="true">
        <EmptyBox>{t("teamDashboard.workloadEmpty")}</EmptyBox>
      </div>
    );
  }
  const colorAt = (s, i) => (s.id === "__others" ? OTHERS_COLOR : SLICE_COLORS[i % SLICE_COLORS.length]);
  const sliceName = (s) => (s.id === "__others" ? t("teamDashboard.workloadOthers", { count: s.others }) : s.name);
  const summary = t("teamDashboard.workloadSummary", { total: formatCount(total), count: slices.reduce((a, s) => a + (s.others || 1), 0) });
  return (
    <div data-testid="team-workload">
      <div className="relative mx-auto h-44 w-44" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="count" nameKey="id" innerRadius="66%" outerRadius="100%" paddingAngle={slices.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {slices.map((s, i) => <Cell key={s.id} fill={colorAt(s, i)} />)}
            </Pie>
            <Tooltip formatter={(v, _n, item) => [`${formatCount(v)} · ${item.payload.pct}%`, sliceName(item.payload)]} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums text-slate-900" data-testid="workload-total">{formatCount(total)}</span>
          <span className="max-w-[7rem] text-center text-[11px] leading-tight text-slate-500">{t("teamDashboard.workloadTotal")}</span>
        </div>
      </div>
      <ul className="mt-4 space-y-2" data-testid="workload-legend">
        {slices.map((s, i) => (
          <li key={s.id} data-slice={s.id} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorAt(s, i) }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium text-slate-700" title={sliceName(s)}>{sliceName(s)}</span>
            <span className="shrink-0 font-semibold tabular-nums text-slate-900">{formatCount(s.count)}</span>
            <span className="w-10 shrink-0 text-end tabular-nums text-slate-500" data-pct>{s.pct}%</span>
          </li>
        ))}
      </ul>
      {(idle > 0 || unknown > 0) && (
        <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          {t("teamDashboard.workloadIdle", { count: idle + unknown })}
        </p>
      )}
    </div>
  );
}

// D / E. Horizontal duration comparison. No sample -> listed as "Not enough data".
function DurationChart({ employees, valueKey, sampleKey, color, teamAvg, testId, label }) {
  const { t, i18n } = useTranslation();
  const { rows, missing, max } = durationRows(employees, valueKey, sampleKey);
  const scaleMax = Math.max(max, teamAvg ?? 0);
  const avgPct = teamAvg === null || teamAvg === undefined ? null : (teamAvg / scaleMax) * 100;
  return (
    <div data-testid={testId}>
      {rows.length === 0 ? (
        <EmptyBox>{t("teamDashboard.durationEmpty")}</EmptyBox>
      ) : (
        <>
          {avgPct !== null && (
            <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
              <span className="h-3 w-0.5 rounded bg-slate-500" aria-hidden="true" />
              {t("teamDashboard.teamAverage")}: <span className="tabular-nums">{formatDuration(teamAvg)}</span>
            </div>
          )}
          <ScrollList label={label}>
            <ul className="space-y-2.5">
              {rows.map((r) => (
                <li key={r.id} data-chart-row={r.id} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
                  <span className={cx("truncate text-xs font-medium", r.active ? "text-slate-800" : "text-slate-400")} title={r.name}>{r.name}</span>
                  <div className="relative h-2.5 min-w-0 rounded-full bg-slate-100">
                    <div className="h-full rounded-full" style={{ width: `${(r.sec / scaleMax) * 100}%`, backgroundColor: color }} />
                    {avgPct !== null && <span className="absolute -top-1 h-[18px] w-0.5 rounded bg-slate-500/70" style={{ insetInlineStart: `calc(${avgPct}% - 1px)` }} aria-hidden="true" />}
                  </div>
                  <span className="text-end text-xs tabular-nums">
                    <span className="font-semibold text-slate-900">{formatDuration(r.sec)}</span>
                    <span className="ms-1 text-[11px] text-slate-400">{t("teamDashboard.samples", { count: r.sample })}</span>
                  </span>
                </li>
              ))}
            </ul>
          </ScrollList>
        </>
      )}
      {missing.length > 0 && (
        <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-500" data-missing>
          <span className="font-semibold">{t("teamDashboard.notEnoughList")}</span>{" "}
          {missing.map((m, i) => (
            <React.Fragment key={m.id}>
              {i > 0 && (i18n.language === "en" ? ", " : "، ")}
              <bdi>{m.name}</bdi>
            </React.Fragment>
          ))}
        </p>
      )}
    </div>
  );
}

const KPI_TONES = {
  indigo: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  sky: "bg-sky-50 text-sky-600 ring-sky-100",
  violet: "bg-violet-50 text-violet-600 ring-violet-100",
  amber: "bg-amber-50 text-amber-600 ring-amber-100",
  rose: "bg-rose-50 text-rose-600 ring-rose-100",
};

function Kpi({ icon: Icon, tone, label, value, kind = "count", hint, large = false }) {
  const isNull = value === null || value === undefined;
  const display = kind === "duration" ? formatDuration(value) : formatCount(value);
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2.5">
        <span className={cx("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset", KPI_TONES[tone])}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <p className="min-w-0 text-xs font-medium leading-snug text-slate-500">{label}</p>
      </div>
      <p className={cx("mt-3 text-2xl font-bold tabular-nums tracking-tight", large && "text-indigo-950", isNull && kind === "duration" ? "text-slate-300" : "text-slate-900")} data-kpi={label}>
        {display}
      </p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-slate-400">{hint}</p>}
    </div>
  );
}

function Panel({ title, subtitle, icon: Icon, action, children, className, bodyClass = "p-4" }) {
  return (
    <section className={cx("min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]", className)}>
      {(title || action) && (
        <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-slate-400" />}
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-slate-900">{title}</h2>
              {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

function Initial({ name, active = true, size = "h-8 w-8 text-xs" }) {
  return (
    <span className={cx("relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold", size, active ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500")}>
      {String(name || "?").trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function EventLabel({ type }) {
  const { t } = useTranslation();
  const map = {
    accepted: t("teamPerformance.eventAccepted"),
    solved: t("teamPerformance.eventSolved"),
    reopened: t("teamPerformance.eventReopened"),
    transferred: t("teamPerformance.eventTransferred"),
  };
  const tone = {
    accepted: "bg-indigo-500",
    solved: "bg-emerald-500",
    reopened: "bg-amber-500",
    transferred: "bg-slate-400",
  }[type] || "bg-slate-400";
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-medium text-slate-800">
      <span className={cx("h-2 w-2 rounded-full", tone)} />
      {map[type] || type}
    </span>
  );
}

function NotEnough() {
  const { t } = useTranslation();
  return <span className="inline-flex whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">{t("teamPerformance.notEnoughData")}</span>;
}

// Employee detail — same sections as before (KPIs, trend, recent cycles,
// activity timeline), shown in a wide side panel instead of below the table.
function EmployeeDetail({ detail, employee, loading, range }) {
  const { t, i18n } = useTranslation();
  if (!employee) return null;
  const cycles = cycleRows(detail?.recent_cycles);
  const timeline = groupTimeline(detail?.timeline);
  return (
    <div className="space-y-5" data-testid="employee-detail">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={ChatBubbleLeftRightIcon} tone="indigo" label={t("teamPerformance.conversationsHandled")} value={employee.conversations_handled} />
        <Kpi icon={CheckCircleIcon} tone="emerald" label={t("teamPerformance.conversationsSolved")} value={employee.conversations_solved} />
        <Kpi icon={ArrowPathIcon} tone="sky" label={t("teamPerformance.handlingCycles")} value={employee.handling_cycles} />
        <Kpi icon={InboxStackIcon} tone="violet" label={t("teamPerformance.humanMessagesSent")} value={employee.human_messages_sent} />
        <Kpi icon={BoltIcon} tone="amber" label={t("teamPerformance.avgFirstResponse")} value={employee.avg_first_response_sec} kind="duration" hint={t("teamPerformance.avgFirstResponseHint")} />
        <Kpi icon={ClockIcon} tone="sky" label={t("teamPerformance.avgResolution")} value={employee.avg_resolution_sec} kind="duration" hint={t("teamPerformance.avgResolutionHint")} />
        <Kpi icon={UserGroupIcon} tone="indigo" label={t("teamPerformance.currentWorkload")} value={employee.current_workload} hint={t("teamDashboard.pointInTime")} />
        <Kpi icon={ArrowUturnLeftIcon} tone="rose" label={t("teamPerformance.manualReopens")} value={employee.manual_reopens} />
      </div>

      <Panel title={t("teamPerformance.trendTitle")} subtitle={t("teamDashboard.trendSubtitle")} icon={ChartBarIcon} action={<RangeChip range={range} />}>
        {loading && !detail ? <Skeleton className="h-60 w-full" /> : <TrendChart trend={detail?.trend} />}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title={t("teamPerformance.recentCycles")}
          icon={ArrowPathIcon}
          bodyClass="p-0"
          action={
            cycles.rows.length > 0 && (
              <div className="flex flex-col items-end gap-1 sm:flex-row sm:gap-3">
                <LegendDot color={METRIC_COLORS.firstResponse} label={t("teamDashboard.firstResponse")} />
                <LegendDot color={METRIC_COLORS.resolution} label={t("teamDashboard.resolution")} />
              </div>
            )
          }
        >
          {loading && !detail ? (
            <div className="p-4"><Skeleton className="h-40 w-full" /></div>
          ) : cycles.rows.length === 0 ? (
            <div className="p-4"><EmptyBox>{t("teamPerformance.notEnoughData")}</EmptyBox></div>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="detail-cycles">
              {cycles.rows.map((c) => (
                <li key={`${c.conversation_id}-${c.accepted_at}`} className="px-4 py-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-slate-800">{shortDateTime(c.accepted_at, i18n.language)}</p>
                    <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums", c.solved_at ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
                      {c.solved_at ? t("teamPerformance.eventSolved") : t("teamPerformance.cycleOpen")}
                    </span>
                  </div>
                  <dl className="mt-2 space-y-1.5">
                    {[
                      ["first", t("teamDashboard.firstResponse"), c.first, METRIC_COLORS.firstResponse],
                      ["resolution", t("teamDashboard.resolution"), c.resolution, METRIC_COLORS.resolution],
                    ].map(([k, label, sec, color]) => (
                      <div key={k} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_4.5rem] items-center gap-2" data-cycle-metric={k}>
                        <dt className="truncate text-[11px] text-slate-500">{label}</dt>
                        <div className="h-1.5 min-w-0 overflow-hidden rounded-full bg-slate-100">
                          {sec !== null && <div className="h-full rounded-full" style={{ width: `${(sec / cycles.max) * 100}%`, backgroundColor: color }} />}
                        </div>
                        <dd className={cx("text-end text-[11px] font-semibold tabular-nums", sec === null ? "text-slate-300" : "text-slate-800")}>{formatDuration(sec)}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t("teamPerformance.activityTimeline")} icon={ClockIcon}>
          {loading && !detail ? (
            <Skeleton className="h-40 w-full" />
          ) : timeline.length === 0 ? (
            <EmptyBox>{t("teamPerformance.notEnoughData")}</EmptyBox>
          ) : (
            <div className="space-y-4" data-testid="detail-timeline">
              {timeline.map((g) => (
                <section key={g.day || "none"}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 rtl:tracking-normal">{g.day ? dayLabel(g.day, i18n.language) : "—"}</h3>
                  <ol className="relative space-y-2.5 border-s border-slate-200 ps-4">
                    {g.events.map((e, i) => (
                      <li key={i} className="flex items-center justify-between gap-3">
                        <EventLabel type={e.event_type} />
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-500">{shortTime(e.created_at, i18n.language)}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

export default function ClientTeamPerformance() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [range, setRange] = useState({ range: "week", from: "", to: "" });
  const [selectedId, setSelectedId] = useState(null);

  const { data, loading, error, reload } = usePerformance({
    user,
    scope: "team",
    range,
    employeeUserId: selectedId,
  });

  const employees = data?.employees || [];
  const team = data?.team || null;
  const selectedEmployee = selectedId ? employees.find((e) => e.user_id === selectedId) : null;

  const detail = detailFor(data?.detail, selectedId);
  const maxHandled = Math.max(1, ...employees.map((e) => e.conversations_handled || 0));

  const metricCell = (value, kind, sample) => {
    if (kind === "duration") return sample === 0 ? <NotEnough /> : <span className="tabular-nums">{formatDuration(value)}</span>;
    return <span className="tabular-nums">{formatCount(value)}</span>;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("navigation.teamPerformance")}
        description={(t("pageTitles.client.teamPerformance", { returnObjects: true }) || [])[1]}
        actions={
          <>
            <RangePicker value={range} onChange={setRange} />
            <button type="button" onClick={reload} disabled={loading} className={ui.btnSecondary}>
              <ArrowPathIcon className={cx("h-4 w-4", loading && "animate-spin")} />
              {t("common.refresh")}
            </button>
          </>
        }
      />

      {error && (
        <div role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700">
          {t("teamPerformance.loadError")}
        </div>
      )}

      {loading && !data ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-28 w-full rounded-2xl" />)}
          </div>
          <Skeleton className="h-64 w-full rounded-2xl" />
          <p className="sr-only">{t("teamPerformance.loading")}</p>
        </div>
      ) : !data ? null : (
        <>
          {/* KPI band */}
          <section aria-label={t("teamPerformance.summaryTitle")} data-testid="team-kpis">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 rtl:tracking-normal">{t("teamPerformance.summaryTitle")}</h2>
              <RangeChip range={data.range} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Kpi large icon={ChatBubbleLeftRightIcon} tone="indigo" label={t("teamPerformance.conversationsHandled")} value={team?.conversations_handled} />
              <Kpi large icon={CheckCircleIcon} tone="emerald" label={t("teamPerformance.conversationsSolved")} value={team?.conversations_solved} />
              <Kpi icon={BoltIcon} tone="amber" label={t("teamPerformance.avgFirstResponse")} value={team?.avg_first_response_sec} kind="duration" hint={t("teamPerformance.avgFirstResponseHint")} />
              <Kpi icon={ClockIcon} tone="sky" label={t("teamPerformance.avgResolution")} value={team?.avg_resolution_sec} kind="duration" hint={t("teamPerformance.avgResolutionHint")} />
              <Kpi icon={UserGroupIcon} tone="violet" label={t("teamPerformance.currentWorkload")} value={team?.current_workload} hint={t("teamDashboard.pointInTime")} />
              <Kpi icon={TrophyIcon} tone="rose" label={t("teamPerformance.solvedToday")} value={team?.solved_today} hint={t("teamDashboard.todayOnly")} />
            </div>
          </section>

          {/* Team at a glance — re-plot of the table's own values only.
              No team trend: the API returns no team-level daily series. */}
          {employees.length > 0 && (
            <>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <Panel title={t("teamDashboard.distributionTitle")} subtitle={t("teamDashboard.distributionSubtitle")} icon={ChartBarIcon} className="xl:col-span-2" action={<RangeChip range={data.range} />}>
                  <HandledSolvedChart employees={employees} />
                </Panel>
                <Panel title={t("teamDashboard.workloadTitle")} subtitle={t("teamDashboard.workloadSubtitle")} icon={UserGroupIcon} action={<RangeChip pointInTime />}>
                  <WorkloadDonut employees={employees} />
                </Panel>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel title={t("teamDashboard.firstResponseTitle")} subtitle={t("teamDashboard.durationSubtitle")} icon={BoltIcon} action={<RangeChip range={data.range} />}>
                  <DurationChart employees={employees} valueKey="avg_first_response_sec" sampleKey="first_response_sample" color={METRIC_COLORS.firstResponse} teamAvg={team?.avg_first_response_sec ?? null} testId="team-first-response" label={t("teamDashboard.firstResponseTitle")} />
                </Panel>
                <Panel title={t("teamDashboard.resolutionTitle")} subtitle={t("teamDashboard.durationSubtitle")} icon={ClockIcon} action={<RangeChip range={data.range} />}>
                  <DurationChart employees={employees} valueKey="avg_resolution_sec" sampleKey="resolution_sample" color={METRIC_COLORS.resolution} teamAvg={team?.avg_resolution_sec ?? null} testId="team-resolution" label={t("teamDashboard.resolutionTitle")} />
                </Panel>
              </div>
            </>
          )}

          {/* Employee performance */}
          <Panel
            title={t("teamPerformance.tableTitle")}
            subtitle={employees.length > 0 ? t("teamPerformance.selectEmployee") : undefined}
            icon={UserGroupIcon}
            bodyClass="p-0"
            action={
              <Link to="/client/team" className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50">
                {t("navigation.team")}
              </Link>
            }
          >
            {employees.length === 0 ? (
              <div className="p-4"><EmptyBox>{t("teamPerformance.noEmployees")}</EmptyBox></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-50/80 text-[11px] uppercase tracking-wide text-slate-500 rtl:tracking-normal">
                    <tr>
                      <th className="sticky start-0 z-[1] bg-slate-50 py-3 pe-3 ps-4 text-start font-semibold">{t("teamPerformance.employee")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.conversationsHandled")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.handlingCycles")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.conversationsSolved")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.humanMessagesSent")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.avgFirstResponse")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.avgResolution")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.currentWorkload")}</th>
                      <th className="px-3 py-3 text-start font-semibold">{t("teamPerformance.manualReopens")}</th>
                      <th className="w-10 px-3 py-3" aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {employees.map((e) => {
                      const selected = e.user_id === selectedId;
                      return (
                        <tr
                          key={e.user_id}
                          onClick={() => setSelectedId(selected ? null : e.user_id)}
                          data-employee-id={e.user_id}
                          aria-selected={selected}
                          className={cx("group cursor-pointer transition hover:bg-indigo-50/40", selected && "bg-indigo-50/60")}
                        >
                          <td className={cx("sticky start-0 z-[1] py-3 pe-3 ps-4 transition group-hover:bg-indigo-50/40", selected ? "bg-indigo-50" : "bg-white")}>
                            <div className="flex items-center gap-2.5">
                              <Initial name={e.name} active={e.is_active !== false} />
                              <div className="min-w-0">
                                <button
                                  type="button"
                                  aria-pressed={selected}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    setSelectedId(selected ? null : e.user_id);
                                  }}
                                  className="block max-w-[180px] truncate rounded text-start font-semibold text-slate-900 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                >
                                  {e.name || "—"}
                                </button>
                                {e.is_active === false && (
                                  <span className="mt-0.5 block w-fit rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{t("common.inactive")}</span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <span className="w-8 font-semibold tabular-nums text-slate-900">{formatCount(e.conversations_handled)}</span>
                              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                                <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${((e.conversations_handled || 0) / maxHandled) * 100}%` }} />
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-slate-600">{metricCell(e.handling_cycles)}</td>
                          <td className="px-3 py-3 font-semibold text-emerald-700">{metricCell(e.conversations_solved)}</td>
                          <td className="px-3 py-3 text-slate-600">{metricCell(e.human_messages_sent)}</td>
                          <td className="px-3 py-3 text-slate-700">{metricCell(e.avg_first_response_sec, "duration", e.first_response_sample)}</td>
                          <td className="px-3 py-3 text-slate-700">{metricCell(e.avg_resolution_sec, "duration", e.resolution_sample)}</td>
                          <td className="px-3 py-3 text-slate-600">{metricCell(e.current_workload)}</td>
                          <td className="px-3 py-3 text-slate-600">{metricCell(e.manual_reopens)}</td>
                          <td className="px-3 py-3 text-slate-400">
                            <ChevronRightIcon className="h-4 w-4 transition group-hover:text-indigo-500 rtl:rotate-180" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-start gap-2 border-t border-slate-100 px-4 py-3" data-testid="attribution-note">
              <InformationCircleIcon className="mt-2 h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <AttributionNote telemetrySince={data.telemetry_since} />
              </div>
            </div>
          </Panel>

          <Drawer
            open={!!selectedEmployee}
            onClose={() => setSelectedId(null)}
            eyebrow={t("teamPerformance.tableTitle")}
            title={selectedEmployee ? t("teamPerformance.detailTitle", { name: selectedEmployee.name || "—" }) : ""}
            closeLabel={t("teamPerformance.back")}
            width="max-w-4xl"
            footer={
              <button type="button" onClick={() => setSelectedId(null)} className={ui.btnSecondary}>
                <ArrowUturnLeftIcon className="h-4 w-4 rtl:-scale-x-100" />
                {t("teamPerformance.back")}
              </button>
            }
          >
            <EmployeeDetail detail={detail} employee={selectedEmployee} loading={loading} range={data.range} />
          </Drawer>
        </>
      )}
    </div>
  );
}
