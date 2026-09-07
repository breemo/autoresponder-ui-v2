// Shared display helpers for the Team / My Performance pages. Pure — no
// metric calculation lives here (the engine is server-side in
// api/_lib/teamPerformance.js); this only formats what the endpoint returns.

// Human-readable duration from whole seconds. Returns "—" for null/undefined
// (i.e. "not enough data") so callers never render a misleading 0s average.
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// Plain integer count — always shows a real 0, never a blank.
export function formatCount(n) {
  return Number(n || 0).toLocaleString();
}

// The four range presets the endpoint understands (custom adds from/to).
export const RANGE_OPTIONS = ["today", "week", "month", "custom"];

// A short local date label for trend axes / timeline rows.
export function shortDate(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(lang === "en" ? "en-US" : "ar-EG", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export function shortDateTime(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(lang === "en" ? "en-US" : "ar-EG", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
