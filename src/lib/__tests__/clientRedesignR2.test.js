import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterMembers, relativeFrom, summarizeMembers } from "../../pages/client/team/teamSummary.js";

// Full redesign of Account Settings, Team Members and Team Performance.
// See engineering/reports/claude/2026-10-09-settings-team-performance-redesign.md.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const M = [
  { name: "Owner", email: "o@x", role: "owner", is_active: true },
  { name: "سارة", email: "s@x", role: "agent", is_active: true },
  { name: "Tech", email: "t@x", role: "it", is_active: false },
  { name: "Ali", email: "a@x", role: "agent", is_active: false },
];

test("team overview counts derive only from the loaded list", () => {
  assert.deepEqual(summarizeMembers(M), { total: 4, active: 2, inactive: 2, roles: { owner: 1, agent: 2, it: 1 } });
  assert.deepEqual(summarizeMembers([]), { total: 0, active: 0, inactive: 0, roles: { owner: 0, agent: 0, it: 0 } });
});

test("team local filters: search, role, status combine", () => {
  assert.deepEqual(filterMembers(M, { query: "سار" }).map((m) => m.email), ["s@x"]);
  assert.deepEqual(filterMembers(M, { role: "agent" }).map((m) => m.email), ["s@x", "a@x"]);
  assert.deepEqual(filterMembers(M, { role: "agent", status: "inactive" }).map((m) => m.email), ["a@x"]);
  assert.deepEqual(filterMembers(M, { query: "T@X" }).map((m) => m.email), ["t@x"]);
  assert.equal(filterMembers(M).length, 4);
});

test("relative time: never fabricates a value for missing timestamps", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(relativeFrom(null, now), null);
  assert.equal(relativeFrom("not a date", now), null);
  assert.deepEqual(relativeFrom("2026-10-09T11:59:30Z", now), { unit: "second", n: 30 });
  assert.deepEqual(relativeFrom("2026-10-06T12:00:00Z", now), { unit: "day", n: 3 });
  assert.deepEqual(relativeFrom("2026-08-09T12:00:00Z", now), { unit: "month", n: 2 });
});

test("Team: role change, permissions and owner rules still wired the same way", () => {
  const s = read("src/pages/client/ClientTeam.jsx");
  assert.match(s, /onChange=\{\(e\) => handleChangeRole\(member, e\.target\.value\)\}/);
  assert.match(s, /onChange=\{\(\) => handleAddRoleChange\(r\)\}/);
  assert.match(s, /lockedOn=\{permsModal\.member\.role === "owner" \? PERMISSIONS\.TEAM_MANAGEMENT : null\}/);
  assert.match(s, /resolvePermissions\(member\.role, member\.permissions_overrides\)/);
  const grid = read("src/pages/client/team/teamUi.jsx");
  assert.match(grid, /<input type="checkbox" className="sr-only" checked=\{checked\} disabled=\{locked\} onChange=\{\(\) => onToggle\(key\)\} \/>/);
});

test("Team Performance: same request, no invented comparisons, null-safe", () => {
  const s = read("src/pages/client/ClientTeamPerformance.jsx");
  assert.match(s, /usePerformance\(\{\s*user,\s*scope: "team",\s*range,\s*employeeUserId: selectedId,\s*\}\)/);
  assert.match(s, /sample === 0 \? <NotEnough \/>/);
  assert.match(s, /<AttributionNote telemetrySince=\{data\.telemetry_since\} \/>/);
  assert.doesNotMatch(s, /vs (last|previous)|%\s*change|trend(Up|Down)/i);
  for (const k of ["conversations_handled", "handling_cycles", "conversations_solved", "human_messages_sent", "avg_first_response_sec", "avg_resolution_sec", "current_workload", "manual_reopens"]) assert.ok(s.includes(`e.${k}`), k);
  assert.ok(read("src/pages/client/performance/PerformanceShared.jsx").includes('resource: "team-performance"'));
});

test("Account Settings: unsaved baseline mirrors the loaded form keys; Save unchanged", () => {
  const s = read("src/pages/client/ClientSettings.jsx");
  const formKeys = s.match(/const \[form, setForm\] = useState\(\{ ([^}]*) \}\);/)[1].split(",").map((x) => x.split(":")[0].trim());
  const snap = s.match(/setSavedSnapshot\(JSON\.stringify\(\{ form: \{ ([^}]*) \}/)[1].split(",").map((x) => x.split(":")[0].trim());
  assert.deepEqual(snap, formKeys);
  assert.match(s, /onSummaryChange=\{setLocationSummary\}/);
  assert.equal((s.match(/\.from\("clients"\)/g) || []).length, 2);
  assert.doesNotMatch(s.slice(s.indexOf("function HoursOverview"), s.indexOf("function BusinessHoursDrawer")), /supabase|fetch\(|setWorkingHours/);
  const loc = read("src/pages/client/LocationsSection.jsx");
  assert.match(loc, /onClick=\{handleToggleComplete\}/);
});

test("new strings: EN/AR parity", () => {
  const en = JSON.parse(read("src/locales/en/translation.json"));
  const ar = JSON.parse(read("src/locales/ar/translation.json"));
  for (const ns of ["accountSettings", "teamMembers", "teamDashboard"]) assert.deepEqual(Object.keys(en[ns]).sort(), Object.keys(ar[ns]).sort(), ns);
});
