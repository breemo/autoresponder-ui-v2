import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
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

// Team Performance dashboard — client users with PERMISSIONS.TEAM_MANAGEMENT.
// Every number comes from the server-side engine (api/_lib/teamPerformance.js)
// via the unchanged usePerformance request; the charts below only re-plot the
// per-employee values the table already shows. No metric math, no invented
// comparisons. null durations stay "—"; zero samples stay "Not enough data".

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
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
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
function EmployeeDetail({ detail, employee, loading }) {
  const { t, i18n } = useTranslation();
  if (!employee) return null;
  return (
    <div className="space-y-5" data-testid="employee-detail">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={ChatBubbleLeftRightIcon} tone="indigo" label={t("teamPerformance.conversationsHandled")} value={employee.conversations_handled} />
        <Kpi icon={CheckCircleIcon} tone="emerald" label={t("teamPerformance.conversationsSolved")} value={employee.conversations_solved} />
        <Kpi icon={ArrowPathIcon} tone="sky" label={t("teamPerformance.handlingCycles")} value={employee.handling_cycles} />
        <Kpi icon={InboxStackIcon} tone="violet" label={t("teamPerformance.humanMessagesSent")} value={employee.human_messages_sent} />
        <Kpi icon={BoltIcon} tone="amber" label={t("teamPerformance.avgFirstResponse")} value={employee.avg_first_response_sec} kind="duration" hint={t("teamPerformance.avgFirstResponseHint")} />
        <Kpi icon={ClockIcon} tone="sky" label={t("teamPerformance.avgResolution")} value={employee.avg_resolution_sec} kind="duration" hint={t("teamPerformance.avgResolutionHint")} />
        <Kpi icon={UserGroupIcon} tone="indigo" label={t("teamPerformance.currentWorkload")} value={employee.current_workload} />
        <Kpi icon={ArrowUturnLeftIcon} tone="rose" label={t("teamPerformance.manualReopens")} value={employee.manual_reopens} />
      </div>

      <Panel title={t("teamPerformance.trendTitle")} icon={ChartBarIcon}>
        {loading && !detail ? <Skeleton className="h-60 w-full" /> : <TrendChart trend={detail?.trend} />}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t("teamPerformance.recentCycles")} icon={ArrowPathIcon} bodyClass="p-0">
          {(detail?.recent_cycles || []).length === 0 ? (
            <div className="p-4"><EmptyBox>{t("teamPerformance.notEnoughData")}</EmptyBox></div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {detail.recent_cycles.map((c) => (
                <li key={`${c.conversation_id}-${c.accepted_at}`} className="flex items-center justify-between gap-3 px-4 py-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800">{shortDateTime(c.accepted_at, i18n.language)}</p>
                    <p className="mt-0.5 text-slate-500">
                      {t("teamPerformance.avgFirstResponse")}: <span className="tabular-nums">{formatDuration(c.first_response_sec)}</span>
                    </p>
                  </div>
                  <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums", c.solved_at ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
                    {c.solved_at ? formatDuration(c.resolution_sec) : t("teamPerformance.cycleOpen")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t("teamPerformance.activityTimeline")} icon={ClockIcon}>
          {(detail?.timeline || []).length === 0 ? (
            <EmptyBox>{t("teamPerformance.notEnoughData")}</EmptyBox>
          ) : (
            <ol className="divide-y divide-slate-100">
              {detail.timeline.map((e, i) => (
                <li key={i} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <EventLabel type={e.event_type} />
                    <span className="text-[11px] text-slate-500">{shortDateTime(e.created_at, i18n.language)}</span>
                  </div>
                </li>
              ))}
            </ol>
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

  // Re-plot of the per-employee values (same numbers as the table).
  const chartData = useMemo(
    () => employees.map((e) => ({ name: e.name || "—", handled: e.conversations_handled ?? 0, solved: e.conversations_solved ?? 0 })),
    [employees]
  );
  const maxHandled = Math.max(1, ...employees.map((e) => e.conversations_handled || 0));
  const workload = [...employees].filter((e) => (e.current_workload || 0) > 0).sort((a, b) => (b.current_workload || 0) - (a.current_workload || 0));
  const maxWorkload = Math.max(1, ...workload.map((e) => e.current_workload || 0));

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
            <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-slate-500 rtl:tracking-normal">{t("teamPerformance.summaryTitle")}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Kpi large icon={ChatBubbleLeftRightIcon} tone="indigo" label={t("teamPerformance.conversationsHandled")} value={team?.conversations_handled} />
              <Kpi large icon={CheckCircleIcon} tone="emerald" label={t("teamPerformance.conversationsSolved")} value={team?.conversations_solved} />
              <Kpi icon={BoltIcon} tone="amber" label={t("teamPerformance.avgFirstResponse")} value={team?.avg_first_response_sec} kind="duration" hint={t("teamPerformance.avgFirstResponseHint")} />
              <Kpi icon={ClockIcon} tone="sky" label={t("teamPerformance.avgResolution")} value={team?.avg_resolution_sec} kind="duration" hint={t("teamPerformance.avgResolutionHint")} />
              <Kpi icon={UserGroupIcon} tone="violet" label={t("teamPerformance.currentWorkload")} value={team?.current_workload} />
              <Kpi icon={TrophyIcon} tone="rose" label={t("teamPerformance.solvedToday")} value={team?.solved_today} />
            </div>
          </section>

          {/* Team at a glance — re-plot of the table's own values only */}
          {employees.length > 0 && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <Panel title={t("teamDashboard.distributionTitle")} icon={ChartBarIcon} className="xl:col-span-2">
                <div className="h-64" data-testid="team-distribution" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={4}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                      <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 11 }} interval={0} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 11 }} width={32} />
                      <Tooltip cursor={{ fill: "#f1f5f9" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="handled" name={t("teamPerformance.conversationsHandled")} fill="#4f46e5" radius={[6, 6, 0, 0]} maxBarSize={36} />
                      <Bar dataKey="solved" name={t("teamPerformance.conversationsSolved")} fill="#10b981" radius={[6, 6, 0, 0]} maxBarSize={36} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
              <Panel title={t("teamDashboard.workloadTitle")} icon={UserGroupIcon}>
                {workload.length === 0 ? (
                  <EmptyBox>{t("teamDashboard.workloadEmpty")}</EmptyBox>
                ) : (
                  <ul className="space-y-3" data-testid="team-workload">
                    {workload.map((e) => (
                      <li key={e.user_id} className="flex items-center gap-3">
                        <Initial name={e.name} active={e.is_active !== false} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate font-medium text-slate-800">{e.name || "—"}</span>
                            <span className="font-semibold tabular-nums text-slate-900">{formatCount(e.current_workload)}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-violet-500" style={{ width: `${((e.current_workload || 0) / maxWorkload) * 100}%` }} />
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
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
            <EmployeeDetail detail={data.detail} employee={selectedEmployee} loading={loading} />
          </Drawer>
        </>
      )}
    </div>
  );
}
