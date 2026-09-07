import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext.jsx";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { formatDuration, shortDateTime } from "../../lib/performanceFormat.js";
import {
  Card,
  EmptyBox,
  KpiCard,
  RangePicker,
  TrendChart,
  AttributionNote,
  usePerformance,
} from "./performance/PerformanceShared.jsx";

// My Performance — any active client employee. The server FORCES
// employee = authenticated actor.user.id; the browser never sends an
// employee id. Same server engine as Team Performance.

export default function ClientMyPerformance() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState({ range: "week", from: "", to: "" });

  const { data, loading, error, reload } = usePerformance({ user, scope: "me", range });

  const me = data?.employee || null;
  const detail = data?.detail || null;

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
      ) : !me ? null : (
        <>
          <Card title={t("teamPerformance.myTitle")}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <KpiCard label={t("teamPerformance.conversationsHandled")} value={me.conversations_handled} />
              <KpiCard label={t("teamPerformance.conversationsSolved")} value={me.conversations_solved} />
              <KpiCard label={t("teamPerformance.handlingCycles")} value={me.handling_cycles} />
              <KpiCard label={t("teamPerformance.humanMessagesSent")} value={me.human_messages_sent} />
              <KpiCard
                label={t("teamPerformance.avgFirstResponse")}
                value={me.avg_first_response_sec}
                kind="duration"
                hint={t("teamPerformance.avgFirstResponseHint")}
                sample={
                  me.first_response_sample
                    ? t("teamPerformance.sampleNote", { count: me.first_response_sample })
                    : t("teamPerformance.notEnoughData")
                }
              />
              <KpiCard
                label={t("teamPerformance.avgResolution")}
                value={me.avg_resolution_sec}
                kind="duration"
                hint={t("teamPerformance.avgResolutionHint")}
                sample={
                  me.resolution_sample
                    ? t("teamPerformance.sampleNote", { count: me.resolution_sample })
                    : t("teamPerformance.notEnoughData")
                }
              />
              <KpiCard label={t("teamPerformance.currentWorkload")} value={me.current_workload} />
              <KpiCard label={t("teamPerformance.manualReopens")} value={me.manual_reopens} />
            </div>
            <div className="mt-4">
              <AttributionNote telemetrySince={data.telemetry_since} />
            </div>
          </Card>

          <Card title={t("teamPerformance.trendTitle")}>
            <TrendChart trend={detail?.trend} />
          </Card>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card
              title={t("teamPerformance.myWorkloadTitle")}
              action={
                <Link
                  to="/client/messages"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
                >
                  {t("teamPerformance.openInInbox")}
                </Link>
              }
            >
              {me.current_workload === 0 ? (
                <EmptyBox>{t("teamPerformance.myWorkloadEmpty")}</EmptyBox>
              ) : (
                <p className="text-sm font-semibold text-slate-700">
                  {t("teamPerformance.currentWorkload")}: {me.current_workload}
                </p>
              )}
            </Card>

            <Card title={t("teamPerformance.recentCycles")}>
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
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
