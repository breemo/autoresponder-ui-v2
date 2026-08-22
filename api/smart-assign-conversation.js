import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { hasPermission } from "../src/lib/permissions.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

// Smart Assignment V1 — reacts to a Supabase Database Webhook on
// conversation_state, computes an eligible/ranked employee, and records a
// RECOMMENDATION (never ownership) via the shared lifecycle RPC's new
// 'system_assign' action.
//
// ---------------------------------------------------------------------
// Trust model — deliberately different from every other endpoint in api/
// ---------------------------------------------------------------------
// Every other endpoint in this app trusts only `actor_user_id` from the
// request and re-derives client_id/role/permission server-side from a
// human's own membership row (see resolveActingMembership in
// api/_lib/clientAuthz.js). There is no human actor here — the caller is
// Supabase's own Database Webhook delivery system, not a browser. This
// endpoint is instead protected by a server-only shared secret
// (SMART_ASSIGN_WEBHOOK_SECRET — see api/_lib/supabaseServer.js's own
// service-role-key pattern for the equivalent "server secret, never
// shipped to the browser" precedent). Once that secret is verified,
// client_id/conversation_id are read directly from the webhook's own
// payload (record) — this is safe specifically because the payload comes
// from Supabase's own database change feed, not from arbitrary browser
// input; it is not re-validated against any "acting user's own client"
// the way every other endpoint's client_id is, because there is no acting
// user for this endpoint to derive one from.
//
// ---------------------------------------------------------------------
// Expected Supabase Database Webhook payload (UPDATE event)
// ---------------------------------------------------------------------
// Supabase's Database Webhooks (Database → Webhooks in the dashboard,
// backed by supabase_functions.http_request) POST a JSON body shaped:
//   { type: "UPDATE", table: "conversation_state", schema: "public",
//     record: { ...new row... }, old_record: { ...old row... } }
// This is documented, stable behavior for UPDATE events specifically
// (INSERT/DELETE payloads differ but are irrelevant here — this endpoint
// is only ever meant to be wired to UPDATE). If either `record` or
// `old_record` is missing/malformed, this endpoint cannot safely
// determine whether this is a genuine transition and does nothing (see
// isEnteringWaitingHuman below) rather than guessing.
function isEnteringWaitingHuman(record, oldRecord) {
  return record?.conversation_status === "waiting_human" && oldRecord?.conversation_status !== "waiting_human";
}

// "Today" for Smart Assignment V1's "accepted today" ranking tier is a
// fixed UTC+03:00 calendar day — a temporary, explicit product decision
// for V1 (see the implementation report), not per-client configuration.
// Returns the UTC instant corresponding to 00:00 in UTC+03:00 "today".
function getTodayStartUtcForUtcPlus3(now = new Date()) {
  const UTC_PLUS_3_MS = 3 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + UTC_PLUS_3_MS);
  const midnightUtcPlus3AsUtcMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - UTC_PLUS_3_MS;
  return new Date(midnightUtcPlus3AsUtcMs).toISOString();
}

// Eligible = same client, active, effective Inbox permission — reusing
// the exact same hasPermission() this app already uses everywhere else
// (src/lib/permissions.js), never a re-derived/duplicated role check.
// is_active is filtered in the query itself (not re-checked here) so
// there's exactly one place that decides "active".
async function fetchEligibleCandidates(supabase, clientId) {
  const { data, error } = await supabase
    .from("client_users")
    .select("id, user_id, role, permissions_overrides")
    .eq("client_id", clientId)
    .eq("is_active", true);

  if (error) throw error;

  return (data || [])
    .filter((membership) => hasPermission(membership.role, membership.permissions_overrides, PERMISSIONS.INBOX))
    .map((membership) => ({ client_users_id: membership.id, user_id: membership.user_id }));
}

// Ranking tier 1: fewest conversation_state rows currently owned
// (waiting_human + assigned_user_id = candidate) — served by
// conversation_state_client_status_assigned_idx (client_id,
// conversation_status, assigned_user_id).
async function fetchCurrentWorkloadCounts(supabase, clientId, candidateUserIds) {
  const { data, error } = await supabase
    .from("conversation_state")
    .select("assigned_user_id")
    .eq("client_id", clientId)
    .eq("conversation_status", "waiting_human")
    .in("assigned_user_id", candidateUserIds);

  if (error) throw error;

  const counts = new Map();
  for (const row of data || []) {
    counts.set(row.assigned_user_id, (counts.get(row.assigned_user_id) || 0) + 1);
  }
  return counts;
}

// Ranking tier 2: fewest 'accepted' conversation_events today (UTC+03:00
// calendar day) — served by conversation_events_client_actor_created_idx
// (client_id, actor_user_id, created_at).
async function fetchAcceptedTodayCounts(supabase, clientId, candidateUserIds, todayStartUtc) {
  const { data, error } = await supabase
    .from("conversation_events")
    .select("actor_user_id")
    .eq("client_id", clientId)
    .eq("event_type", "accepted")
    .in("actor_user_id", candidateUserIds)
    .gte("created_at", todayStartUtc);

  if (error) throw error;

  const counts = new Map();
  for (const row of data || []) {
    counts.set(row.actor_user_id, (counts.get(row.actor_user_id) || 0) + 1);
  }
  return counts;
}

// Ranking tier 3: oldest previous system assignment — MAX(created_at) per
// candidate over 'system_assigned' events, sourced from conversation_events
// (the permanent history) rather than conversation_state.system_assigned_at,
// since the latter only reflects the single most recent recommendation for
// one conversation and would understate an employee's true assignment
// history across multiple conversations/reopen cycles. Served by
// conversation_events_client_target_created_idx (client_id, target_user_id,
// created_at). A candidate with no prior row ranks as "never assigned",
// which must sort BEFORE any candidate with a real timestamp (oldest-first
// fairness) — represented here as `null`, sorted first in rankCandidates.
async function fetchLastSystemAssignedAt(supabase, clientId, candidateUserIds) {
  const { data, error } = await supabase
    .from("conversation_events")
    .select("target_user_id, created_at")
    .eq("client_id", clientId)
    .eq("event_type", "system_assigned")
    .in("target_user_id", candidateUserIds)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const latest = new Map();
  for (const row of data || []) {
    // Rows arrive newest-first; keep only the first (= latest) one seen
    // per target_user_id.
    if (!latest.has(row.target_user_id)) latest.set(row.target_user_id, row.created_at);
  }
  return latest;
}

// The 4-tier deterministic ranking itself. candidates: [{client_users_id,
// user_id}]. Returns the same array sorted best-first (index 0 = the
// employee to recommend).
function rankCandidates(candidates, workloadCounts, acceptedTodayCounts, lastSystemAssignedAt) {
  return [...candidates].sort((a, b) => {
    const workloadDiff = (workloadCounts.get(a.user_id) || 0) - (workloadCounts.get(b.user_id) || 0);
    if (workloadDiff !== 0) return workloadDiff;

    const acceptedDiff = (acceptedTodayCounts.get(a.user_id) || 0) - (acceptedTodayCounts.get(b.user_id) || 0);
    if (acceptedDiff !== 0) return acceptedDiff;

    const aLast = lastSystemAssignedAt.get(a.user_id) || null;
    const bLast = lastSystemAssignedAt.get(b.user_id) || null;
    // Never-assigned (null) ranks before any real timestamp.
    if (aLast !== bLast) {
      if (aLast === null) return -1;
      if (bLast === null) return 1;
      return new Date(aLast).getTime() - new Date(bLast).getTime();
    }

    // Stable deterministic tie-breaker.
    return a.client_users_id < b.client_users_id ? -1 : a.client_users_id > b.client_users_id ? 1 : 0;
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ assigned: false, reason: "method_not_allowed" });
  }

  const providedSecret = req.headers["x-smart-assign-secret"];
  const expectedSecret = process.env.SMART_ASSIGN_WEBHOOK_SECRET;
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ assigned: false, reason: "unauthorized" });
  }

  const record = req.body?.record;
  const oldRecord = req.body?.old_record;

  if (!record || !oldRecord) {
    // Can't safely confirm this is a genuine transition without both —
    // 200, not an error: this is a payload shape we don't act on, not a
    // failure of this endpoint. See the module comment's documented
    // expected payload shape.
    return res.status(200).json({ assigned: false, reason: "missing_payload_data" });
  }

  if (!isEnteringWaitingHuman(record, oldRecord)) {
    // Covers every case Step 3 asked to ignore: repeated UPDATE while
    // already waiting_human (old.conversation_status is also
    // 'waiting_human', including this function's OWN system_assign write,
    // which never changes conversation_status), active, closed, and any
    // conversation that never reaches waiting_human at all (e.g.
    // welcome_only / manual-follow-up-only conversations, which by
    // definition never have this transition fire for them).
    return res.status(200).json({ assigned: false, reason: "not_a_waiting_human_transition" });
  }

  const clientId = record.client_id;
  const conversationId = record.conversation_id;

  if (!clientId || !conversationId) {
    return res.status(200).json({ assigned: false, reason: "missing_client_or_conversation_id" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ assigned: false, reason: "server_not_configured" });
  }

  let candidates;
  try {
    candidates = await fetchEligibleCandidates(supabase, clientId);
  } catch (error) {
    console.error("smart-assign-conversation: failed to fetch eligible candidates:", error);
    return res.status(500).json({ assigned: false, reason: "eligibility_lookup_failed" });
  }

  if (candidates.length === 0) {
    // Per spec: never fail the conversation — it just stays available for
    // manual claiming, exactly as it already behaves today without Smart
    // Assignment.
    return res.status(200).json({ assigned: false, reason: "no_eligible_employee" });
  }

  const candidateUserIds = candidates.map((c) => c.user_id);
  const todayStartUtc = getTodayStartUtcForUtcPlus3();

  let workloadCounts, acceptedTodayCounts, lastSystemAssignedAt;
  try {
    [workloadCounts, acceptedTodayCounts, lastSystemAssignedAt] = await Promise.all([
      fetchCurrentWorkloadCounts(supabase, clientId, candidateUserIds),
      fetchAcceptedTodayCounts(supabase, clientId, candidateUserIds, todayStartUtc),
      fetchLastSystemAssignedAt(supabase, clientId, candidateUserIds),
    ]);
  } catch (error) {
    console.error("smart-assign-conversation: failed to fetch ranking data:", error);
    return res.status(500).json({ assigned: false, reason: "ranking_lookup_failed" });
  }

  const ranked = rankCandidates(candidates, workloadCounts, acceptedTodayCounts, lastSystemAssignedAt);
  const winner = ranked[0];

  const { data: rows, error: rpcError } = await supabase.rpc("apply_conversation_lifecycle_action", {
    p_client_id: clientId,
    p_conversation_id: conversationId,
    p_actor_user_id: null,
    p_action: "system_assign",
    p_target_user_id: winner.user_id,
    p_expected_updated_at: record.updated_at,
  });

  if (rpcError) {
    console.error("apply_conversation_lifecycle_action RPC failed (action=system_assign):", {
      code: rpcError.code,
      message: rpcError.message,
      details: rpcError.details,
      hint: rpcError.hint,
      conversation_id: conversationId,
      client_id: clientId,
    });
    return res.status(500).json({ assigned: false, reason: "rpc_failed" });
  }

  const result = rows?.[0];

  if (!result || result.outcome === "not_found") {
    return res.status(200).json({ assigned: false, reason: "conversation_not_found" });
  }

  if (result.outcome === "skipped") {
    // Duplicate delivery of this same transition (already processed), or
    // the conversation stopped being eligible between the webhook firing
    // and this call running (e.g. accepted in the meantime, or no longer
    // waiting_human) — see the RPC's own header comment. Not an error.
    return res.status(200).json({ assigned: false, reason: "skipped_not_eligible_or_duplicate" });
  }

  return res.status(200).json({ assigned: true, target_user_id: result.system_assigned_user_id });
}
