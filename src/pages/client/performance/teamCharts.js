// Pure chart-data mappers for the Team Performance dashboard.
// They only RESHAPE values the team-performance endpoint already returns
// (api/_lib/teamPerformance.js) — no metric is computed here. Rules:
//   - a missing / non-numeric value stays null (never coerced to 0);
//   - a duration is plotted only when it has a real sample (sample > 0);
//   - workload percentages are shares of real nonnegative counts only.

const UTC_PLUS_3_MS = 3 * 60 * 60 * 1000;

// A finite, nonnegative number, or null.
export function countOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const nameOf = (e) => (e && String(e.name || "").trim()) || "—";

// B. Handled vs solved, one row per employee (server order kept).
// `max` is the shared scale for both bars; at least 1 so empty bars stay 0%.
export function handledSolvedRows(employees = []) {
  const rows = (employees || []).map((e) => ({
    id: e.user_id,
    name: nameOf(e),
    active: e.is_active !== false,
    handled: countOrNull(e.conversations_handled),
    solved: countOrNull(e.conversations_solved),
  }));
  const max = Math.max(1, ...rows.flatMap((r) => [r.handled ?? 0, r.solved ?? 0]));
  const anyActivity = rows.some((r) => (r.handled ?? 0) > 0 || (r.solved ?? 0) > 0);
  return { rows, max, anyActivity };
}

// Each slice's own share, rounded to a whole percent. Equal counts always get
// equal percentages, so the rounded values may add up to 99–101.
export function sharePercents(counts = []) {
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => (total ? Math.round((c / total) * 100) : 0));
}

// C. Current workload share (point-in-time, not range-filtered).
// Only employees with a real count > 0 become slices; beyond `maxSlices`
// the smallest are folded into one "others" slice (a sum of real counts).
export function workloadShares(employees = [], maxSlices = 6) {
  const valid = [];
  let unknown = 0;
  let idle = 0;
  for (const e of employees || []) {
    const c = countOrNull(e.current_workload);
    if (c === null) unknown += 1;
    else if (c === 0) idle += 1;
    else valid.push({ id: e.user_id, name: nameOf(e), active: e.is_active !== false, count: c });
  }
  valid.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = valid.reduce((a, s) => a + s.count, 0);
  let slices = valid;
  if (valid.length > maxSlices) {
    const head = valid.slice(0, maxSlices - 1);
    const rest = valid.slice(maxSlices - 1);
    slices = [...head, { id: "__others", name: null, others: rest.length, count: rest.reduce((a, s) => a + s.count, 0) }];
  }
  const pcts = sharePercents(slices.map((s) => s.count));
  return { total, slices: slices.map((s, i) => ({ ...s, pct: pcts[i] })), idle, unknown };
}

// D / E. Duration comparison. Employees without a real sample (sample 0 or
// a null average) are listed separately as "not enough data", never as 0.
export function durationRows(employees = [], valueKey, sampleKey) {
  const rows = [];
  const missing = [];
  for (const e of employees || []) {
    const sec = countOrNull(e[valueKey]);
    const sample = countOrNull(e[sampleKey]);
    if (sec === null || sample === 0) missing.push({ id: e.user_id, name: nameOf(e) });
    else rows.push({ id: e.user_id, name: nameOf(e), active: e.is_active !== false, sec, sample });
  }
  rows.sort((a, b) => a.sec - b.sec || a.name.localeCompare(b.name));
  const max = Math.max(1, ...rows.map((r) => r.sec));
  return { rows, missing, max };
}

// The resolved range the server actually used ({from,to} real ISO instants of
// UTC+3 business days) as UTC+3 day keys, for labelling every chart.
export function rangeDayKeys(range) {
  const key = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t + UTC_PLUS_3_MS).toISOString().slice(0, 10) : null;
  };
  if (!range) return null;
  const from = key(range.from);
  const to = key(range.to);
  return from && to ? { from, to } : null;
}

// The drill-down detail belongs to the selected employee only (guards the
// moment between selecting another employee and the refetch landing).
export function detailFor(detail, selectedId) {
  if (!detail || !selectedId) return null;
  return detail.employee_user_id && detail.employee_user_id !== selectedId ? null : detail;
}

// Recent cycles with a bar scale shared by first-response and resolution.
export function cycleRows(cycles = []) {
  const rows = (cycles || []).map((c) => ({
    ...c,
    first: countOrNull(c.first_response_sec),
    resolution: c.solved_at ? countOrNull(c.resolution_sec) : null,
  }));
  const max = Math.max(1, ...rows.flatMap((r) => [r.first ?? 0, r.resolution ?? 0]));
  return { rows, max };
}

// Activity timeline grouped by UTC+3 day (newest first, order kept inside).
export function groupTimeline(events = []) {
  const groups = [];
  const byKey = new Map();
  for (const e of events || []) {
    const t = Date.parse(e.created_at);
    const day = Number.isFinite(t) ? new Date(t + UTC_PLUS_3_MS).toISOString().slice(0, 10) : "";
    if (!byKey.has(day)) {
      const g = { day, events: [] };
      byKey.set(day, g);
      groups.push(g);
    }
    byKey.get(day).events.push(e);
  }
  return groups;
}
