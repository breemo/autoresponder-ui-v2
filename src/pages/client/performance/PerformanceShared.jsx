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
    <div className={`min-w-0 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function EmptyBox({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-5 text-center text-sm font-medium text-slate-500">
      {children}
    </div>
  );
}

// One KPI. `kind`: "count" | "duration". A null duration -> "—".
export function KpiCard({ label, value, kind = "count", hint, sample }) {
  const display = kind === "duration" ? formatDuration(value) : formatCount(value);
  const isEmptyDuration = kind === "duration" && (value === null || value === undefined);
  return (
    <div className="min-w-0 rounded-2xl border border-slate-200/80 bg-white px-3.5 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <p className="text-xs font-medium leading-snug text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums tracking-tight ${isEmptyDuration ? "text-slate-300" : "text-slate-900"}`}>
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
      <div role="group" className="inline-flex h-9 items-center rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
        {presets.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange({ range: key, from: draftFrom, to: draftTo })}
            aria-pressed={value.range === key}
            className={`h-full rounded-lg px-3 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              value.range === key ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {value.range === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
            {t("teamPerformance.customFrom")}
            <input
              type="date"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
            {t("teamPerformance.customTo")}
            <input
              type="date"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50"
            />
          </label>
          <button
            type="button"
            disabled={!draftFrom}
            onClick={() => onChange({ range: "custom", from: draftFrom, to: draftTo })}
            className="inline-flex h-9 items-center rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-40"
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
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">{t("teamPerformance.attributionNoData")}</p>
    );
  }
  const since = t("teamPerformance.attributionSince", {
    date: shortDate(telemetrySince, i18n.language),
  });
  return (
    <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
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
