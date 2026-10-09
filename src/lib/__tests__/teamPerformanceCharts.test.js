import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countOrNull,
  cycleRows,
  detailFor,
  durationRows,
  groupTimeline,
  handledSolvedRows,
  rangeDayKeys,
  sharePercents,
  workloadShares,
} from "../../pages/client/performance/teamCharts.js";

// Team Performance analytics charts — pure mappers over the unchanged
// team-performance response. MOCKED fixtures only (no DEV / customer data).
// See engineering/reports/claude/2026-10-09-team-performance-analytics.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const emp = (id, extra = {}) => ({
  user_id: id,
  name: id,
  is_active: true,
  conversations_handled: 0,
  conversations_solved: 0,
  avg_first_response_sec: null,
  avg_resolution_sec: null,
  first_response_sample: 0,
  resolution_sample: 0,
  current_workload: 0,
  ...extra,
});

test("countOrNull keeps null/invalid as null, never 0", () => {
  assert.equal(countOrNull(null), null);
  assert.equal(countOrNull(undefined), null);
  assert.equal(countOrNull(""), null);
  assert.equal(countOrNull("abc"), null);
  assert.equal(countOrNull(-3), null);
  assert.equal(countOrNull(0), 0);
  assert.equal(countOrNull("7"), 7);
});

test("handled vs solved: maps the table values, keeps server order, null stays null", () => {
  const r = handledSolvedRows([
    emp("a", { conversations_handled: 4, conversations_solved: 3 }),
    emp("b", { conversations_handled: null, conversations_solved: 2 }),
    emp("c", { name: "  ", is_active: false }),
  ]);
  assert.deepEqual(r.rows.map((x) => [x.id, x.handled, x.solved]), [["a", 4, 3], ["b", null, 2], ["c", 0, 0]]);
  assert.equal(r.rows[2].name, "—");
  assert.equal(r.rows[2].active, false);
  assert.equal(r.max, 4);
  assert.equal(r.anyActivity, true);
});

test("handled vs solved: zero activity -> flagged, scale stays 1 (no division by zero)", () => {
  const r = handledSolvedRows([emp("a"), emp("b")]);
  assert.equal(r.anyActivity, false);
  assert.equal(r.max, 1);
  assert.deepEqual(handledSolvedRows([]), { rows: [], max: 1, anyActivity: false });
});

test("share percents: each slice rounded from its real count; equal counts -> equal %", () => {
  assert.deepEqual(sharePercents([1, 1, 1]), [33, 33, 33]);
  assert.deepEqual(sharePercents([2, 1]), [67, 33]);
  assert.deepEqual(sharePercents([5]), [100]);
  assert.deepEqual(sharePercents([0, 0]), [0, 0]);
  for (const n of [3, 7, 10, 25]) {
    const counts = Array.from({ length: n }, (_, i) => (i % 4) + 1);
    const sum = sharePercents(counts).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) <= Math.ceil(n / 2), `n=${n} sum=${sum}`);
  }
});

test("workload donut: only real nonnegative counts become slices; empty when total is 0", () => {
  const r = workloadShares([
    emp("a", { current_workload: 3 }),
    emp("b", { current_workload: 1 }),
    emp("c", { current_workload: 0 }),
    emp("d", { current_workload: null }),
    emp("e", { current_workload: -2 }),
  ]);
  assert.equal(r.total, 4);
  assert.deepEqual(r.slices.map((s) => [s.id, s.count, s.pct]), [["a", 3, 75], ["b", 1, 25]]);
  assert.equal(r.idle, 1);
  assert.equal(r.unknown, 2);
  const empty = workloadShares([emp("a"), emp("b")]);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.slices, []);
});

test("workload donut: 25 employees fold into top 5 + Others (sum of real counts)", () => {
  const team = Array.from({ length: 25 }, (_, i) => emp(`u${String(i).padStart(2, "0")}`, { current_workload: i + 1 }));
  const r = workloadShares(team);
  assert.equal(r.slices.length, 6);
  assert.equal(r.total, (25 * 26) / 2);
  const others = r.slices[5];
  assert.equal(others.id, "__others");
  assert.equal(others.others, 20);
  assert.equal(others.count, r.total - [25, 24, 23, 22, 21].reduce((a, b) => a + b, 0));
  assert.ok(Math.abs(r.slices.reduce((a, s) => a + s.pct, 0) - 100) <= 3);
  assert.equal(r.slices.reduce((a, s) => a + s.count, 0), r.total);
});

test("duration comparison: null or zero-sample employees are excluded, never plotted as 0", () => {
  const r = durationRows(
    [
      emp("slow", { avg_first_response_sec: 600, first_response_sample: 2 }),
      emp("fast", { avg_first_response_sec: 30, first_response_sample: 5 }),
      emp("none", { avg_first_response_sec: null, first_response_sample: 0 }),
      emp("zeroSample", { avg_first_response_sec: 0, first_response_sample: 0 }),
      emp("instant", { avg_first_response_sec: 0, first_response_sample: 1 }),
    ],
    "avg_first_response_sec",
    "first_response_sample"
  );
  assert.deepEqual(r.rows.map((x) => [x.id, x.sec]), [["instant", 0], ["fast", 30], ["slow", 600]]);
  assert.deepEqual(r.missing.map((m) => m.id), ["none", "zeroSample"]);
  assert.equal(r.max, 600);
  const none = durationRows([emp("a")], "avg_resolution_sec", "resolution_sample");
  assert.deepEqual(none.rows, []);
  assert.equal(none.missing.length, 1);
  assert.equal(none.max, 1);
});

test("date range: labels follow the range the server applied (UTC+3 business days)", () => {
  // week of Mon 2026-10-05 .. Fri 2026-10-09 (server from = 2026-10-05 00:00 UTC+3)
  assert.deepEqual(rangeDayKeys({ range: "week", from: "2026-10-04T21:00:00.000Z", to: "2026-10-09T09:15:00.000Z" }), { from: "2026-10-05", to: "2026-10-09" });
  assert.deepEqual(rangeDayKeys({ range: "today", from: "2026-10-08T21:00:00.000Z", to: "2026-10-09T20:59:00.000Z" }), { from: "2026-10-09", to: "2026-10-09" });
  assert.equal(rangeDayKeys(null), null);
  assert.equal(rangeDayKeys({ range: "week" }), null);
});

test("detail belongs to the selected employee only (no stale drill-down)", () => {
  const d = { employee_user_id: "a", trend: [] };
  assert.equal(detailFor(d, "a"), d);
  assert.equal(detailFor(d, "b"), null);
  assert.equal(detailFor(d, null), null);
  assert.equal(detailFor(null, "a"), null);
});

test("recent cycles: open cycles have no resolution; null first response stays null", () => {
  const r = cycleRows([
    { conversation_id: "c1", accepted_at: "2026-10-09T08:00:00Z", solved_at: "2026-10-09T09:00:00Z", resolution_sec: 3600, first_response_sec: 120 },
    { conversation_id: "c2", accepted_at: "2026-10-09T10:00:00Z", solved_at: null, resolution_sec: null, first_response_sec: null },
  ]);
  assert.deepEqual(r.rows.map((c) => [c.first, c.resolution]), [[120, 3600], [null, null]]);
  assert.equal(r.max, 3600);
  assert.equal(cycleRows([]).max, 1);
});

test("timeline groups by UTC+3 day keeping server order", () => {
  const g = groupTimeline([
    { event_type: "solved", created_at: "2026-10-09T10:00:00Z" },
    { event_type: "accepted", created_at: "2026-10-09T08:00:00Z" },
    { event_type: "accepted", created_at: "2026-10-08T22:30:00Z" }, // 01:30 on Oct 9 UTC+3
    { event_type: "reopened", created_at: "2026-10-08T12:00:00Z" },
  ]);
  assert.deepEqual(g.map((x) => [x.day, x.events.length]), [["2026-10-09", 3], ["2026-10-08", 1]]);
  assert.deepEqual(groupTimeline(null), []);
});

test("page: same request, charts use the mappers, empty states + range labels + responsive guards", () => {
  const s = read("src/pages/client/ClientTeamPerformance.jsx");
  assert.match(s, /usePerformance\(\{\s*user,\s*scope: "team",\s*range,\s*employeeUserId: selectedId,\s*\}\)/);
  for (const fn of ["handledSolvedRows(employees)", "workloadShares(employees)", "durationRows(employees, valueKey, sampleKey)", "detailFor(data?.detail, selectedId)"]) assert.ok(s.includes(fn), fn);
  assert.ok(s.includes('valueKey="avg_first_response_sec" sampleKey="first_response_sample"'));
  assert.ok(s.includes('valueKey="avg_resolution_sec" sampleKey="resolution_sample"'));
  // no null -> 0 coercion in the charts
  assert.doesNotMatch(s, /conversations_(handled|solved) \?\? 0/);
  // empty states
  for (const k of ["teamDashboard.workloadEmpty", "teamDashboard.durationEmpty", "teamDashboard.noActivity", "teamDashboard.notEnoughList"]) assert.ok(s.includes(k), k);
  // range labelling: period charts carry the applied range; workload says "right now"
  assert.equal((s.match(/<RangeChip range=\{data\.range\} \/>/g) || []).length, 4);
  assert.ok(s.includes("<RangeChip pointInTime />"));
  assert.ok(s.includes('hint={t("teamDashboard.todayOnly")}'));
  // responsive: long lists scroll inside the card, rows can shrink, no fixed chart widths
  assert.ok(s.includes("max-h-[26rem] overflow-y-auto"));
  assert.ok(s.includes("minmax(0,7.5rem)_minmax(0,1fr)"));
  assert.match(s, /grid-cols-1 gap-4 lg:grid-cols-2/);
  // no invented comparisons / scores
  assert.doesNotMatch(s, /vs (last|previous)|%\s*change|trend(Up|Down)|score|rank/i);
});

test("analytics strings: EN/AR parity, no 'AI Assistant'", () => {
  const en = JSON.parse(read("src/locales/en/translation.json"));
  const ar = JSON.parse(read("src/locales/ar/translation.json"));
  assert.deepEqual(Object.keys(en.teamDashboard).sort(), Object.keys(ar.teamDashboard).sort());
  for (const k of ["pointInTime", "todayOnly", "workloadOthers", "durationEmpty", "teamAverage", "samples"]) assert.ok(en.teamDashboard[k] && ar.teamDashboard[k], k);
  assert.equal(/ai assistant/i.test(JSON.stringify(en.teamDashboard)), false);
});
