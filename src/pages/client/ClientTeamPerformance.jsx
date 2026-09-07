import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext.jsx";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { formatCount, formatDuration, shortDateTime } from "../../lib/performanceFormat.js";
import {
  Card,
  EmptyBox,
  KpiCard,
  RangePicker,
  TrendChart,
  AttributionNote,
  usePerformance,
} from "./performance/PerformanceShared.jsx";

// Team Performance — client users with PERMISSIONS.TEAM_MANAGEMENT.
// Every number comes from the server-side engine (api/_lib/teamPerformance.js),
// scoped to the acting user's own client. No metric math in the browser.

function EventLabel({ type }) {
  const { t } = useTranslation();
  const map = {
    accepted: t("teamPerformance.eventAccepted"),
    solved: t("teamPerformance.eventSolved"),
    reopened: t("teamPerformance.eventReopened"),
    transferred: t("teamPerformance.eventTransferred"),
  };
  const tone = {
    accepted: "bg-indigo-50 text-indigo-700",
    solved: "bg-emerald-50 text-emerald-700",
    reopened: "bg-amber-50 text-amber-700",
    transferred: "bg-slate-100 text-slate-600",
  }[type] || "bg-slate-100 text-slate-600";
  return <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${tone}`}>{map[type] || type}</span>;
}

function EmployeeDetail({ detail, employee }) {
  const { t, i18n } = useTranslation();
  if (!employee) return null;
  return (
    <Card
      title={t("teamPerformance.detailTitle", { name: employee.name || "—" })}
      className="mt-5"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label={t("teamPerformance.conversationsHandled")} value={employee.conversations_handled} />
        <KpiCard label={t("teamPerformance.conversationsSolved")} value={employee.conversations_solved} />
        <KpiCard label={t("teamPerformance.handlingCycles")} value={employee.handling_cycles} />
        <KpiCard label={t("teamPerformance.humanMessagesSent")} value={employee.human_messages_sent} />
        <KpiCard
          label={t("teamPerformance.avgFirstResponse")}
          value={employee.avg_first_response_sec}
          kind="duration"
          hint={t("teamPerformance.avgFirstResponseHint")}
        />
        <KpiCard
          label={t("teamPerformance.avgResolution")}
          value={employee.avg_resolution_sec}
          kind="duration"
          hint={t("teamPerformance.avgResolutionHint")}
        />
        <KpiCard label={t("teamPerformance.currentWorkload")} value={employee.current_workload} />
        <KpiCard label={t("teamPerformance.manualReopens")} value={employee.manual_reopens} />
      </div>

      <div className="mt-5">
        <p className="mb-2 text-sm font-black text-slate-950">{t("teamPerformance.trendTitle")}</p>
        <TrendChart trend={detail?.trend} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-black text-slate-950">{t("teamPerformance.recentCycles")}</p>
          {(detail?.recent_cycles || []).length === 0 ? (
            <EmptyBox>{t("teamPerformance.notEnoughData")}</EmptyBox>
          ) : (
            <div className="space-y-2">
              {detail.recent_cycles.map((c) => (
                <div key={`${c.conversation_id}-${c.accepted_at}`} className="rounded-xl border border-slate-100 p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-500">{shortDateTime(c.accepted_at, i18n.language)}</span>
                    <span className="font-bold text-slate-700">
                      {c.solved_at ? formatDuration(c.resolution_sec) : t("teamPerformance.cycleOpen")}
                    </span>
                  </div>
                  <div className="mt-1 text-slate-400">
                    {t("teamPerformance.avgFirstResponse")}: {formatDuration(c.first_response_sec)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm font-black text-slate-950">{t("teamPerformance.activityTimeline")}</p>
          {(detail?.timeline || []).length === 0 ? (
            <EmptyBox>{t("teamPerformance.notEnoughData")}</EmptyBox>
          ) : (
            <div className="space-y-2">
              {detail.timeline.map((e, i) => (
                <div key={i} className="flex items-center justify-between rounded-xl border border-slate-100 p-3 text-xs">
                  <EventLabel type={e.event_type} />
                  <span className="text-slate-400">{shortDateTime(e.created_at, i18n.language)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
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

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <RangePicker value={range} onChange={setRange} />
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
        >
          <ArrowPathIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {t("common.refresh")}
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {t("teamPerformance.loadError")}
        </div>
      )}

      {loading && !data ? (
        <EmptyBox>{t("teamPerformance.loading")}</EmptyBox>
      ) : !data ? null : (
        <>
          <Card title={t("teamPerformance.summaryTitle")}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <KpiCard label={t("teamPerformance.conversationsHandled")} value={team?.conversations_handled} />
              <KpiCard label={t("teamPerformance.conversationsSolved")} value={team?.conversations_solved} />
              <KpiCard
                label={t("teamPerformance.avgFirstResponse")}
                value={team?.avg_first_response_sec}
                kind="duration"
                hint={t("teamPerformance.avgFirstResponseHint")}
              />
              <KpiCard
                label={t("teamPerformance.avgResolution")}
                value={team?.avg_resolution_sec}
                kind="duration"
                hint={t("teamPerformance.avgResolutionHint")}
              />
              <KpiCard label={t("teamPerformance.currentWorkload")} value={team?.current_workload} />
              <KpiCard label={t("teamPerformance.solvedToday")} value={team?.solved_today} />
            </div>
          </Card>

          <Card
            title={t("teamPerformance.tableTitle")}
            action={
              <Link
                to="/client/team"
                className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
              >
                {t("navigation.team")}
              </Link>
            }
          >
            {employees.length === 0 ? (
              <EmptyBox>{t("teamPerformance.noEmployees")}</EmptyBox>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs font-bold text-slate-500">
                      <th className="py-2 pe-3">{t("teamPerformance.employee")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.conversationsHandled")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.handlingCycles")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.conversationsSolved")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.humanMessagesSent")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.avgFirstResponse")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.avgResolution")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.currentWorkload")}</th>
                      <th className="px-3 py-2">{t("teamPerformance.manualReopens")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((e) => {
                      const selected = e.user_id === selectedId;
                      return (
                        <tr
                          key={e.user_id}
                          onClick={() => setSelectedId(selected ? null : e.user_id)}
                          className={`cursor-pointer border-b border-slate-100 transition hover:bg-slate-50 ${
                            selected ? "bg-indigo-50/50" : ""
                          }`}
                        >
                          <td className="py-2.5 pe-3">
                            <span className="font-bold text-slate-900">{e.name || "—"}</span>
                            {e.is_active === false && (
                              <span className="ms-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">
                                {t("common.inactive")}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 font-semibold text-slate-700">{formatCount(e.conversations_handled)}</td>
                          <td className="px-3 py-2.5 text-slate-600">{formatCount(e.handling_cycles)}</td>
                          <td className="px-3 py-2.5 font-semibold text-slate-700">{formatCount(e.conversations_solved)}</td>
                          <td className="px-3 py-2.5 text-slate-600">{formatCount(e.human_messages_sent)}</td>
                          <td className="px-3 py-2.5 text-slate-600">
                            {e.first_response_sample === 0 ? (
                              <span className="text-slate-300">{t("teamPerformance.notEnoughData")}</span>
                            ) : (
                              formatDuration(e.avg_first_response_sec)
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">
                            {e.resolution_sample === 0 ? (
                              <span className="text-slate-300">{t("teamPerformance.notEnoughData")}</span>
                            ) : (
                              formatDuration(e.avg_resolution_sec)
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">{formatCount(e.current_workload)}</td>
                          <td className="px-3 py-2.5 text-slate-600">{formatCount(e.manual_reopens)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-4">
              <AttributionNote telemetrySince={data.telemetry_since} />
            </div>
          </Card>

          {selectedEmployee ? (
            <EmployeeDetail detail={data.detail} employee={selectedEmployee} />
          ) : employees.length > 0 ? (
            <p className="px-1 text-xs font-medium text-slate-400">{t("teamPerformance.selectEmployee")}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
