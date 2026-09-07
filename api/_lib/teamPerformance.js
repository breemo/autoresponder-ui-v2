import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";

// Team Productivity V1 — CLIENT-SCOPED employee performance metrics.
//
// Two experiences share this one metrics engine:
//   scope=team : PERMISSIONS.TEAM_MANAGEMENT — every employee of the
//                acting user's own client; optional employee_user_id
//                drill-down (must be a member of the same client).
//   scope=me   : any active member — server FORCES employee = actor.user.id.
//
// Authoritative data ONLY (per the approved audit):
//   public.conversation_events  — accepted / solved / reopened / transferred
//   public.conversations        — current waiting_human ownership
//   public.messages             — human outbound (reply_source='human',
//                                 direction='outbound'), attributed by
//                                 sent_by_user_id (telemetry live since
//                                 commit dbdc2b8 — older rows are NULL and
//                                 are NEVER guessed)
//   public.client_users + public.users — the employee roster + names
//
// NOT used: conversation_state (legacy), system_assigned_user_id
// (recommendation only, never handling), conversation.started_at →
// solved_at (folds in closed gaps), conversations.assigned_user_id for
// HISTORICAL ownership (mutable snapshot).
//
// Tenant scope is ALWAYS actor.membership.client_id, re-derived
// server-side. No client_id / role / permission / arbitrary employee id
// from the browser can change it.

const UTC_PLUS_3_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A handling cycle (accepted → solved) is paired within this look-back so
// a solve inside the selected range can be matched to its earlier accept.
const CYCLE_PAIRING_HORIZON_DAYS = 90;
const FETCH_CAP = 100000;
const CYCLE_EVENT_TYPES = ["accepted", "solved", "reopened"];
const TIMELINE_EVENT_TYPES = ["accepted", "solved", "reopened", "transferred"];

// ---------------------------------------------------------------------
// UTC+3 business-day range resolution (consistent with Smart Assignment's
// existing UTC+3 "today").
// ---------------------------------------------------------------------
export function resolveRange({ range, from, to } = {}, now = new Date()) {
  const nowMs = now.getTime();
  const wallNowMs = nowMs + UTC_PLUS_3_MS; // "now" as a UTC+3 wall clock
  const w = new Date(wallNowMs);
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth();
  const d = w.getUTCDate();
  const dow = w.getUTCDay(); // 0=Sun .. 6=Sat

  const toRealIso = (wallMs) => new Date(wallMs - UTC_PLUS_3_MS).toISOString();
  const todayStartWall = Date.UTC(y, mo, d);

  let resolved = range;
  let fromWall;
  let toWall = wallNowMs;

  if (range === "week") {
    const daysSinceMonday = (dow + 6) % 7; // ISO week starts Monday
    fromWall = todayStartWall - daysSinceMonday * DAY_MS;
  } else if (range === "month") {
    fromWall = Date.UTC(y, mo, 1);
  } else if (range === "custom" && from) {
    const [fy, fm, fd] = String(from).split("-").map(Number);
    fromWall = Date.UTC(fy, (fm || 1) - 1, fd || 1);
    if (to) {
      const [ty, tm, td] = String(to).split("-").map(Number);
      toWall = Math.min(Date.UTC(ty, (tm || 1) - 1, td || 1) + DAY_MS - 1, wallNowMs);
    }
    resolved = "custom";
  } else {
    fromWall = todayStartWall;
    resolved = "today";
  }

  return {
    range: resolved,
    from: toRealIso(fromWall),
    to: toRealIso(toWall),
    today_start: toRealIso(todayStartWall),
  };
}

function utcPlus3DayKey(iso) {
  return new Date(new Date(iso).getTime() + UTC_PLUS_3_MS).toISOString().slice(0, 10);
}

function inRange(iso, fromIso, toIso) {
  const t = new Date(iso).getTime();
  return t >= new Date(fromIso).getTime() && t <= new Date(toIso).getTime();
}

function avg(nums) {
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

// ---------------------------------------------------------------------
// The metrics engine. `roster` is the already-authorized list of
// { user_id, name, role, is_active }. Returns { employees:[...], team:{...},
// detail?:{...} }. All durations are whole seconds.
// ---------------------------------------------------------------------
export async function computePerformance(
  supabase,
  { clientId, roster, fromIso, toIso, todayStartIso, now = new Date(), drillEmployeeId = null }
) {
  const rosterIds = new Set(roster.map((r) => r.user_id));
  const nowIso = now.toISOString();
  const pairingFromIso = new Date(new Date(fromIso).getTime() - CYCLE_PAIRING_HORIZON_DAYS * DAY_MS).toISOString();

  const [
    { data: eventRows, error: eventErr },
    { data: msgRows, error: msgErr },
    { data: workloadRows, error: workloadErr },
    { data: timelineRows, error: timelineErr },
    { data: telemetryRows, error: telemetryErr },
  ] = await Promise.all([
    supabase
      .from("conversation_events")
      .select("conversation_id, event_type, actor_user_id, created_at")
      .eq("client_id", clientId)
      .in("event_type", CYCLE_EVENT_TYPES)
      .gte("created_at", pairingFromIso)
      .lte("created_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(FETCH_CAP),
    supabase
      .from("messages")
      .select("conversation_id, created_at, sent_by_user_id")
      .eq("client_id", clientId)
      .eq("direction", "outbound")
      .eq("reply_source", "human")
      .gte("created_at", pairingFromIso)
      .lte("created_at", nowIso)
      .limit(FETCH_CAP),
    supabase
      .from("conversations")
      .select("assigned_user_id")
      .eq("client_id", clientId)
      .eq("conversation_status", "waiting_human")
      .not("assigned_user_id", "is", null)
      .limit(20000),
    drillEmployeeId
      ? supabase
          .from("conversation_events")
          .select("conversation_id, event_type, created_at")
          .eq("client_id", clientId)
          .eq("actor_user_id", drillEmployeeId)
          .in("event_type", TIMELINE_EVENT_TYPES)
          .order("created_at", { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [] }),
    // Per-tenant telemetry activation point: the earliest human message
    // that carries a real sender attribution.
    supabase
      .from("messages")
      .select("created_at")
      .eq("client_id", clientId)
      .eq("reply_source", "human")
      .not("sent_by_user_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1),
  ]);

  if (eventErr) throw eventErr;
  if (msgErr) throw msgErr;
  if (workloadErr) throw workloadErr;
  if (timelineErr) throw timelineErr;
  if (telemetryErr) throw telemetryErr;

  const telemetrySince = telemetryRows?.[0]?.created_at || null;

  // ---- human messages grouped by conversation (time-ascending) --------
  const humanMsgsByConv = new Map();
  for (const m of msgRows || []) {
    if (!m.conversation_id) continue;
    if (!humanMsgsByConv.has(m.conversation_id)) humanMsgsByConv.set(m.conversation_id, []);
    humanMsgsByConv.get(m.conversation_id).push(m);
  }
  for (const arr of humanMsgsByConv.values()) {
    arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  // ---- events grouped by conversation (time-ascending) ---------------
  const eventsByConv = new Map();
  for (const e of eventRows || []) {
    if (!e.conversation_id) continue;
    if (!eventsByConv.has(e.conversation_id)) eventsByConv.set(e.conversation_id, []);
    eventsByConv.get(e.conversation_id).push(e);
  }

  // ---- build handling cycles: each `accepted` paired with the next
  //      `solved` on the same conversation before the next `accepted` ----
  const cycles = []; // { owner, convId, acceptedAt, solvedAt|null, firstResponseSec|null }
  for (const [convId, evs] of eventsByConv.entries()) {
    const accepts = evs.filter((e) => e.event_type === "accepted");
    const solves = evs.filter((e) => e.event_type === "solved");
    for (let i = 0; i < accepts.length; i += 1) {
      const a = accepts[i];
      const acceptedMs = new Date(a.created_at).getTime();
      const nextAcceptMs = i + 1 < accepts.length ? new Date(accepts[i + 1].created_at).getTime() : Infinity;
      const solve = solves.find((s) => {
        const sMs = new Date(s.created_at).getTime();
        return sMs > acceptedMs && sMs <= nextAcceptMs;
      });
      const cycleEndMs = solve ? new Date(solve.created_at).getTime() : Math.min(nextAcceptMs, now.getTime());

      // first attributable human outbound message inside the cycle window
      let firstResponseSec = null;
      const msgs = humanMsgsByConv.get(convId) || [];
      for (const m of msgs) {
        const mMs = new Date(m.created_at).getTime();
        if (mMs < acceptedMs || mMs >= cycleEndMs) continue;
        // attribute by the cycle window; if a sender IS recorded it must
        // be this cycle's owner (defensive — post outbound-auth-fix only
        // the owner can send during their window).
        if (m.sent_by_user_id && m.sent_by_user_id !== a.actor_user_id) continue;
        firstResponseSec = Math.max(0, Math.round((mMs - acceptedMs) / 1000));
        break;
      }

      cycles.push({
        owner: a.actor_user_id,
        convId,
        acceptedAt: a.created_at,
        solvedAt: solve ? solve.created_at : null,
        resolutionSec: solve ? Math.max(0, Math.round((new Date(solve.created_at).getTime() - acceptedMs) / 1000)) : null,
        firstResponseSec,
      });
    }
  }

  // ---- workload by employee (point-in-time, NOT range) --------------
  const workloadByEmp = new Map();
  for (const w of workloadRows || []) {
    if (!w.assigned_user_id) continue;
    workloadByEmp.set(w.assigned_user_id, (workloadByEmp.get(w.assigned_user_id) || 0) + 1);
  }

  // ---- per-employee aggregation ------------------------------------
  const perEmp = new Map();
  const ensure = (uid) => {
    if (!perEmp.has(uid)) {
      perEmp.set(uid, {
        handledConvIds: new Set(),
        claims: 0,
        solvedConvIds: new Set(),
        solvedTodayCount: 0,
        manualReopens: 0,
        humanMessages: 0,
        resolutionSecs: [],
        firstResponseSecs: [],
      });
    }
    return perEmp.get(uid);
  };

  // raw events -> claims / solved / manual reopens / solved-today
  for (const e of eventRows || []) {
    const uid = e.actor_user_id;
    if (!uid || !rosterIds.has(uid)) continue;
    if (e.event_type === "accepted" && inRange(e.created_at, fromIso, toIso)) {
      const bucket = ensure(uid);
      bucket.claims += 1;
      bucket.handledConvIds.add(e.conversation_id);
    } else if (e.event_type === "solved") {
      if (inRange(e.created_at, fromIso, toIso)) ensure(uid).solvedConvIds.add(e.conversation_id);
      if (inRange(e.created_at, todayStartIso, nowIso)) ensure(uid).solvedTodayCount += 1;
    } else if (e.event_type === "reopened" && inRange(e.created_at, fromIso, toIso)) {
      // actor_user_id != null => a MANUAL employee reopen. Auto/customer
      // reopens have actor_user_id = null and never count here.
      ensure(uid).manualReopens += 1;
    }
  }

  // cycles whose accept falls in the selected range -> resolution / first response
  for (const c of cycles) {
    if (!c.owner || !rosterIds.has(c.owner)) continue;
    if (!inRange(c.acceptedAt, fromIso, toIso)) continue;
    const bucket = ensure(c.owner);
    if (c.resolutionSec !== null) bucket.resolutionSecs.push(c.resolutionSec);
    if (c.firstResponseSec !== null) bucket.firstResponseSecs.push(c.firstResponseSec);
  }

  // human messages sent — DIRECT attribution only (sent_by_user_id),
  // within the selected range. NULL rows are never attributed.
  for (const m of msgRows || []) {
    const uid = m.sent_by_user_id;
    if (!uid || !rosterIds.has(uid)) continue;
    if (!inRange(m.created_at, fromIso, toIso)) continue;
    ensure(uid).humanMessages += 1;
  }

  const employees = roster.map((r) => {
    const b = perEmp.get(r.user_id) || null;
    return {
      user_id: r.user_id,
      name: r.name,
      role: r.role,
      is_active: r.is_active,
      conversations_handled: b ? b.handledConvIds.size : 0,
      handling_cycles: b ? b.claims : 0,
      conversations_solved: b ? b.solvedConvIds.size : 0,
      human_messages_sent: b ? b.humanMessages : 0,
      avg_first_response_sec: b ? avg(b.firstResponseSecs) : null,
      avg_resolution_sec: b ? avg(b.resolutionSecs) : null,
      current_workload: workloadByEmp.get(r.user_id) || 0,
      manual_reopens: b ? b.manualReopens : 0,
      solved_today: b ? b.solvedTodayCount : 0,
      first_response_sample: b ? b.firstResponseSecs.length : 0,
      resolution_sample: b ? b.resolutionSecs.length : 0,
    };
  });

  // ---- team summary ------------------------------------------------
  const teamHandledConvs = new Set();
  const teamSolvedConvs = new Set();
  let teamSolvedToday = 0;
  const teamResolutionSecs = [];
  const teamFirstResponseSecs = [];
  for (const e of eventRows || []) {
    if (!e.actor_user_id || !rosterIds.has(e.actor_user_id)) continue;
    if (e.event_type === "accepted" && inRange(e.created_at, fromIso, toIso)) teamHandledConvs.add(e.conversation_id);
    if (e.event_type === "solved") {
      if (inRange(e.created_at, fromIso, toIso)) teamSolvedConvs.add(e.conversation_id);
      if (inRange(e.created_at, todayStartIso, nowIso)) teamSolvedToday += 1;
    }
  }
  for (const c of cycles) {
    if (!c.owner || !rosterIds.has(c.owner)) continue;
    if (!inRange(c.acceptedAt, fromIso, toIso)) continue;
    if (c.resolutionSec !== null) teamResolutionSecs.push(c.resolutionSec);
    if (c.firstResponseSec !== null) teamFirstResponseSecs.push(c.firstResponseSec);
  }
  let teamWorkload = 0;
  for (const [uid, n] of workloadByEmp.entries()) if (rosterIds.has(uid)) teamWorkload += n;

  const team = {
    conversations_handled: teamHandledConvs.size,
    conversations_solved: teamSolvedConvs.size,
    avg_first_response_sec: avg(teamFirstResponseSecs),
    avg_resolution_sec: avg(teamResolutionSecs),
    current_workload: teamWorkload,
    solved_today: teamSolvedToday,
    first_response_sample: teamFirstResponseSecs.length,
    resolution_sample: teamResolutionSecs.length,
  };

  // ---- drill-down detail (single employee) ------------------------
  let detail = null;
  if (drillEmployeeId && rosterIds.has(drillEmployeeId)) {
    const trendMap = new Map(); // dayKey -> { handled, solved }
    // seed every day in range so the trend has no gaps
    for (
      let t = new Date(fromIso).getTime();
      t <= new Date(toIso).getTime();
      t += DAY_MS
    ) {
      trendMap.set(utcPlus3DayKey(new Date(t).toISOString()), { day: "", handled: 0, solved: 0 });
    }
    for (const e of eventRows || []) {
      if (e.actor_user_id !== drillEmployeeId) continue;
      if (!inRange(e.created_at, fromIso, toIso)) continue;
      const key = utcPlus3DayKey(e.created_at);
      if (!trendMap.has(key)) trendMap.set(key, { day: "", handled: 0, solved: 0 });
      const row = trendMap.get(key);
      if (e.event_type === "accepted") row.handled += 1;
      if (e.event_type === "solved") row.solved += 1;
    }
    const trend = [...trendMap.entries()]
      .map(([day, v]) => ({ ...v, day }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    const myCycles = cycles
      .filter((c) => c.owner === drillEmployeeId && inRange(c.acceptedAt, fromIso, toIso))
      .sort((a, b) => new Date(b.acceptedAt) - new Date(a.acceptedAt))
      .slice(0, 15)
      .map((c) => ({
        conversation_id: c.convId,
        accepted_at: c.acceptedAt,
        solved_at: c.solvedAt,
        resolution_sec: c.resolutionSec,
        first_response_sec: c.firstResponseSec,
      }));

    const timeline = (timelineRows || []).map((r) => ({
      conversation_id: r.conversation_id,
      event_type: r.event_type,
      created_at: r.created_at,
    }));

    detail = { employee_user_id: drillEmployeeId, trend, recent_cycles: myCycles, timeline };
  }

  return { employees, team, detail, telemetry_since: telemetrySince };
}

// ---------------------------------------------------------------------
// Authorization decision — pure, unit-testable.
//   scope=me   : any resolved member; ALWAYS forces employee = actor.user.id.
//   scope=team : requires PERMISSIONS.TEAM_MANAGEMENT; an optional
//                requestedEmployeeId (drill-down) must be in the acting
//                user's own client roster.
// Returns { ok:true, scope, drillEmployeeId } or { ok:false, status, message }.
// ---------------------------------------------------------------------
export function resolvePerformanceScope(actor, { scope, requestedEmployeeId, rosterIds }) {
  if (scope === "me") {
    return { ok: true, scope: "me", drillEmployeeId: actor.user.id };
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.TEAM_MANAGEMENT)) {
    return { ok: false, status: 403, message: "Forbidden" };
  }
  const requested = typeof requestedEmployeeId === "string" ? requestedEmployeeId.trim() : "";
  if (requested && !(rosterIds instanceof Set ? rosterIds.has(requested) : false)) {
    return { ok: false, status: 404, message: "الموظف غير موجود ضمن هذا الفريق" };
  }
  return { ok: true, scope: "team", drillEmployeeId: requested || null };
}

// ---------------------------------------------------------------------
// HTTP handler — dispatched from api/conversation.js (?resource=team-performance).
// ---------------------------------------------------------------------
export async function handleTeamPerformance(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("team-performance: SUPABASE_SERVICE_ROLE_KEY is not set — refusing to serve metrics (conversation_events/messages reads return empty under RLS, not an error).");
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await resolveActingMembership(supabase, req.query?.actor_user_id);
  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }

  // TENANT SCOPE — always the acting membership's own client. No client_id
  // parameter is read anywhere in this handler.
  const clientId = actor.membership.client_id;
  const scope = req.query?.scope === "me" ? "me" : "team";
  const range = resolveRange({
    range: req.query?.range,
    from: req.query?.from,
    to: req.query?.to,
  });

  // Roster: every member of THIS client, active or not (an inactive
  // member may still own historical rows and should still be labelled).
  const { data: rosterRows, error: rosterErr } = await supabase
    .from("client_users")
    .select("user_id, role, is_active, users(name, email)")
    .eq("client_id", clientId);
  if (rosterErr) {
    console.error("team-performance: failed to load roster:", rosterErr);
    return res.status(500).json({ success: false, message: "Failed to load the team" });
  }
  const roster = (rosterRows || []).map((r) => ({
    user_id: r.user_id,
    name: r.users?.name || r.users?.email || "",
    role: r.role,
    is_active: r.is_active,
  }));
  const rosterIds = new Set(roster.map((r) => r.user_id));

  const decision = resolvePerformanceScope(actor, {
    scope,
    requestedEmployeeId: req.query?.employee_user_id,
    rosterIds,
  });
  if (!decision.ok) {
    return res.status(decision.status).json({ success: false, message: decision.message });
  }

  try {
    if (decision.scope === "me") {
      const meFromRoster = roster.find((r) => r.user_id === actor.user.id);
      const me = meFromRoster || {
        user_id: actor.user.id,
        name: actor.user.name || actor.user.email || "",
        role: actor.membership.role,
        is_active: actor.membership.is_active !== false,
      };
      const result = await computePerformance(supabase, {
        clientId,
        roster: [me],
        fromIso: range.from,
        toIso: range.to,
        todayStartIso: range.today_start,
        now: new Date(),
        drillEmployeeId: decision.drillEmployeeId, // FORCED to actor.user.id
      });
      return res.status(200).json({
        success: true,
        scope: "me",
        range,
        employee: result.employees[0],
        detail: result.detail,
        telemetry_since: result.telemetry_since,
      });
    }

    const result = await computePerformance(supabase, {
      clientId,
      roster,
      fromIso: range.from,
      toIso: range.to,
      todayStartIso: range.today_start,
      now: new Date(),
      drillEmployeeId: decision.drillEmployeeId,
    });

    return res.status(200).json({
      success: true,
      scope: "team",
      range,
      employees: result.employees,
      team: result.team,
      detail: result.detail,
      telemetry_since: result.telemetry_since,
    });
  } catch (error) {
    console.error("team-performance: failed to compute metrics:", error);
    return res.status(500).json({ success: false, message: "فشل في تحميل مقاييس الأداء" });
  }
}
