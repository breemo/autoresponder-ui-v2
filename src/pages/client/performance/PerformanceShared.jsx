import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { formatCount, formatDuration, shortDate } from "../../../lib/performanceFormat.js";

// Shared, presentational-only building blocks for /client/team-performance
// and /client/my-performance. No metric math here — the two pages both hit
// the same server engine (api/_lib/teamPerformance.js).

export function Card({ title, subtitle, action, children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-lg font-black text-slate-950">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs font-medium text-slate-400">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function EmptyBox({ children }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-8 text-center text-sm font-semibold text-slate-400">
      {children}
    </div>
  );
}

// One KPI. `kind`: "count" | "duration". A null duration -> "—".
export function KpiCard({ label, value, kind = "count", hint, sample }) {
  const display = kind === "duration" ? formatDuration(value) : formatCount(value);
  const isEmptyDuration = kind === "duration" && (value === null || value === undefined);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-black tracking-tight ${isEmptyDuration ? "text-slate-300" : "text-slate-950"}`}>
        {display}
      </p>
      {hint && <p className="mt-1 text-[11px] leading-tight text-slate-400">{hint}</p>}
      {sample ? <p className="mt-0.5 text-[11px] text-slate-400">{sample}</p> : null}
    </div>
  );
}

// The Today / Week / Month / Custom control. `value` is { range, from, to }.
export function RangePicker({ value, onChange }) {
  const { t } = useTranslation();
  const [draftFrom, setDraftFrom] = useState(value.from || "");
  const [draftTo, setDraftTo] = useState(value.to || "");

  const presets = [
    ["today", t("teamPerformance.rangeToday")],
    ["week", t("teamPerformance.rangeWeek")],
    ["month", t("teamPerformance.rangeMonth")],
    ["custom", t("teamPerformance.rangeCustom")],
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {presets.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange({ range: key, from: draftFrom, to: draftTo })}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              value.range === key ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {value.range === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs font-semibold text-slate-500">
            {t("teamPerformance.customFrom")}
            <input
              type="date"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
            />
          </label>
          <label className="flex items-center gap-1 text-xs font-semibold text-slate-500">
            {t("teamPerformance.customTo")}
            <input
              type="date"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
            />
          </label>
          <button
            type="button"
            disabled={!draftFrom}
            onClick={() => onChange({ range: "custom", from: draftFrom, to: draftTo })}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
          >
            {t("teamPerformance.apply")}
          </button>
        </div>
      )}
    </div>
  );
}

// Handled / Solved daily trend (drill-down + My Performance).
export function TrendChart({ trend }) {
  const { t, i18n } = useTranslation();
  const data = useMemo(
    () => (trend || []).map((d) => ({ ...d, label: shortDate(`${d.day}T00:00:00Z`, i18n.language) })),
    [trend, i18n.language]
  );
  if (!data.length) return <EmptyBox>{t("teamPerformance.notEnoughData")}</EmptyBox>;
  return (
    <div className="h-60">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 11 }} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 11 }} />
          <Tooltip />
          <Legend />
          <Bar dataKey="handled" name={t("teamPerformance.eventAccepted")} fill="#4f46e5" radius={[4, 4, 0, 0]} />
          <Bar dataKey="solved" name={t("teamPerformance.eventSolved")} fill="#10b981" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// The subtle data-quality note about historical sent_by_user_id.
export function AttributionNote({ telemetrySince }) {
  const { t, i18n } = useTranslation();
  if (!telemetrySince) {
    return (
      <p className="text-[11px] leading-relaxed text-slate-400">{t("teamPerformance.attributionNoData")}</p>
    );
  }
  const since = t("teamPerformance.attributionSince", {
    date: shortDate(telemetrySince, i18n.language),
  });
  return (
    <p className="text-[11px] leading-relaxed text-slate-400">
      {t("teamPerformance.attributionNote", { since })}
    </p>
  );
}

// Shared fetch. Returns { data, loading, error, reload }.
export function usePerformance({ user, scope, range, employeeUserId }) {
  const [state, setState] = React.useState({ data: null, loading: true, error: "" });

  const params = useMemo(() => {
    const p = new URLSearchParams({
      resource: "team-performance",
      actor_user_id: user?.id || "",
      scope,
      range: range.range || "today",
    });
    if (range.range === "custom") {
      if (range.from) p.set("from", range.from);
      if (range.to) p.set("to", range.to);
    }
    if (employeeUserId) p.set("employee_user_id", employeeUserId);
    return p.toString();
  }, [user?.id, scope, range.range, range.from, range.to, employeeUserId]);

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const res = await fetch(`/api/conversation?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        throw new Error(body?.message || "load_failed");
      }
      setState({ data: body, loading: false, error: "" });
    } catch (e) {
      setState({ data: null, loading: false, error: e.message || "load_failed" });
    }
  }, [params]);

  React.useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}
