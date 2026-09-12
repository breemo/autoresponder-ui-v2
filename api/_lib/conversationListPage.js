// Conversation List Pagination — read path only.
//
// Additive, opt-in extension of the existing GET /api/conversation
// ?resource=list endpoint (api/_lib/conversationsList.js). When the
// caller omits `limit`, that file's original, unbounded, all-conversations
// query runs unchanged. This module is only ever invoked when `limit` is
// present. No schema/migration change: every filter here uses columns
// (`client_id`, `contact_id`, `channel_identity_id`, `conversation_status`,
// `platform`, `last_message_at`, `updated_at`, `id`, plus the small set of
// columns already read from `leads`/`contacts`/`contact_channel_identities`/
// `messages`) the existing endpoint already selects.
//
// Cursor: the composite tuple (last_message_at, id), matching the
// APPROVED design — verified live: messages_bump_conversation_last_message_at_trg
// keeps conversations.last_message_at and conversations.updated_at
// current on every message insert (both fields, via GREATEST — never
// rewound), and apply_conversation_lifecycle_action (claim/close/reopen/
// takeover) always bumps updated_at even when it never touches
// last_message_at. id is the deterministic tiebreaker, exactly like the
// message-pagination cursor — two conversations can share the exact same
// last_message_at.
//
// NULL last_message_at (a conversation that exists but has no message
// yet — a brief, transient window between resolver-create and the first
// message insert in practice) sorts LAST under `NULLS LAST`, ordered
// among themselves by id. buildOlderThanFilter's third OR-clause
// (`last_message_at.is.null`) is what lets "load next page" correctly
// fall through from the last real-timestamp row into that bucket in ONE
// query, instead of getting permanently stuck at the boundary; once the
// cursor's own row was itself null (no before_last_message_at given),
// pagination continues within that bucket by id alone.
//
// Delta/poll query: NOT keyset pagination — a plain "anything with
// last_message_at OR updated_at newer than the last time I checked"
// catch-all, self-healing by design (idempotent upsert-by-id merge on the
// caller's side, so returning an already-known row again is harmless; a
// row that narrowly misses one tick is still newer than the NEXT tick's
// advancing watermark). See fetchConversationsDelta.

export const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 200;
// Safety caps only — bound a single request's worst case without limiting
// normal operation.
const SEARCH_FANOUT_LIMIT = 500;
const ENRICHMENT_MESSAGES_SAFETY_LIMIT = 2000;

const ID_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Identical column list to the existing (legacy) query in
// api/_lib/conversationsList.js — the paginated path must select exactly
// the same conversations columns, just with a bounded row set.
export const CONVERSATION_COLUMNS =
  "id, client_id, contact_id, channel_identity_id, platform, conversation_status, current_step, " +
  "assigned_user_id, assigned_at, " +
  "system_assigned_user_id, system_assigned_at, " +
  "solved_by, solved_at, reopened_by, reopened_at, closed_at, last_message_at, created_at, updated_at";

export function isValidCursorId(id) {
  return typeof id === "string" && ID_TOKEN_RE.test(id);
}

export function isValidCursorTimestamp(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

export function normalizePageLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_PAGE_LIMIT);
}

// Strips the characters that are structurally significant to PostgREST's
// `.or()` mini-language (comma / parens / double-quote) out of free-typed
// search text before it is ever embedded in an `.or()` filter string —
// the ONLY two call sites that do (contact_channel_identities' sender_id-
// or-display_name search, leads' name-or-phone search) both sanitize
// through this first. Every other search query below uses a plain
// `.ilike(column, pattern)` call instead, which never string-interpolates
// user text into a control grammar at all. A stripped character just
// narrows the match slightly (e.g. a literal comma in the typed term is
// dropped) — never a correctness or injection concern.
export function sanitizeSearchTerm(term) {
  return String(term || "").replace(/[,()"]/g, "");
}

function ilikePattern(term) {
  return `%${term}%`;
}

// Composite-cursor filter for "the next page strictly before
// (lastMessageAt, id)" in last_message_at DESC NULLS LAST, id DESC order.
export function buildOlderThanFilter(lastMessageAt, id) {
  return `last_message_at.lt."${lastMessageAt}",and(last_message_at.eq."${lastMessageAt}",id.lt."${id}"),last_message_at.is.null`;
}

// Delta/poll filter: anything with either watermark strictly newer than
// `since` (a wall-clock instant, NOT derived from any specific row — see
// the module comment above for why a per-row-derived watermark would be
// wrong here, unlike the message cursor).
export function buildDeltaFilter(since) {
  return `last_message_at.gt."${since}",updated_at.gt."${since}"`;
}

// Trims a DESC-fetched (limit+1) page down to `limit` rows and derives
// has_more — conversations already display newest-first, so (unlike the
// message page, which fetches DESC then reverses to ASC for display) no
// reordering is needed here. Never mutates the input.
export function trimPage(descRows, limit) {
  const rows = Array.isArray(descRows) ? descRows : [];
  const has_more = rows.length > limit;
  return { conversations: has_more ? rows.slice(0, limit) : rows.slice(), has_more };
}

// ---------------------------------------------------------------------
// Search — a small fan-out of independently-bounded, single-column (or
// same-table two-column) queries, never a client-wide scan of `messages`/
// `conversations`. No schema change: `leads.conversation_id` has no FK to
// `conversations` (confirmed in the Stage A migration's own note), so a
// PostgREST embedded-resource join isn't available — this is the
// smallest schema-change-free equivalent. Returns null when there is no
// active search term (caller then applies no id restriction at all);
// otherwise the Set of conversation ids to restrict to (possibly empty —
// a real "no matches").
// ---------------------------------------------------------------------
export async function resolveSearchConversationIds(supabase, { clientId, searchTerm }) {
  const rawTerm = (searchTerm || "").trim();
  if (!rawTerm) return null;

  const pattern = ilikePattern(rawTerm);
  const safeTerm = sanitizeSearchTerm(rawTerm);
  const safePattern = ilikePattern(safeTerm);
  const looksLikeUuid = UUID_RE.test(rawTerm);

  const [contactsRes, identitiesRes, leadsRes, candidateMessagesRes, exactConvRes] = await Promise.all([
    // customer_name's primary source.
    supabase.from("contacts").select("id").eq("client_id", clientId).ilike("display_name", pattern).limit(SEARCH_FANOUT_LIMIT),
    // customer_name's channel-profile-name source, and sender/phone.
    safeTerm
      ? supabase
          .from("contact_channel_identities")
          .select("id")
          .eq("client_id", clientId)
          .or(`sender_id.ilike."${safePattern}",display_name.ilike."${safePattern}"`)
          .limit(SEARCH_FANOUT_LIMIT)
      : Promise.resolve({ data: [] }),
    // lead_name / lead_phone.
    safeTerm
      ? supabase
          .from("leads")
          .select("conversation_id")
          .eq("client_id", clientId)
          .or(`name.ilike."${safePattern}",phone.ilike."${safePattern}"`)
          .limit(SEARCH_FANOUT_LIMIT)
      : Promise.resolve({ data: [] }),
    // Latest-message-text search, step 1 of 2: candidate messages whose
    // text matches — bounded by MATCH COUNT, never a client-wide scan.
    // Step 2 (below, after this Promise.all) keeps only the candidates
    // that are each conversation's ACTUAL latest message (preserving the
    // original "search the last message only" semantics, not historical
    // text), using conversations.last_message_at — kept accurate by the
    // verified messages_bump_conversation_last_message_at_trg trigger —
    // as the "is this the latest one" check. This avoids a DISTINCT ON
    // (not expressible through PostgREST's simple filters) without
    // needing a schema change or a full re-scan.
    supabase.from("messages").select("conversation_id, created_at").eq("client_id", clientId).ilike("message", pattern).limit(SEARCH_FANOUT_LIMIT),
    // conversation_id: exact match only (see module comment / report —
    // a partial/substring match on a uuid column isn't expressible
    // through PostgREST's simple filters without a schema change; this is
    // the one, explicitly-flagged narrowing from today's client-side
    // substring match).
    looksLikeUuid
      ? supabase.from("conversations").select("id").eq("client_id", clientId).eq("id", rawTerm)
      : Promise.resolve({ data: [] }),
  ]);

  const contactIds = (contactsRes.data || []).map((r) => r.id);
  const identityIds = (identitiesRes.data || []).map((r) => r.id);

  let convFromContactOrIdentity = [];
  if (contactIds.length || identityIds.length) {
    const clauses = [];
    if (contactIds.length) clauses.push(`contact_id.in.(${contactIds.join(",")})`);
    if (identityIds.length) clauses.push(`channel_identity_id.in.(${identityIds.join(",")})`);
    // Both id lists here are database-originated uuids (never raw user
    // text), so embedding them directly in `.or()` carries no
    // injection/parsing risk.
    const { data } = await supabase.from("conversations").select("id").eq("client_id", clientId).or(clauses.join(","));
    convFromContactOrIdentity = (data || []).map((r) => r.id);
  }

  // Latest-message-text search, step 2 of 2: a candidate message counts
  // ONLY if its created_at equals its own conversation's last_message_at
  // (i.e. it IS that conversation's latest message) — bounded by the
  // number of distinct conversations the candidate matches touched, not
  // by total message history.
  const candidateMessages = candidateMessagesRes.data || [];
  const candidateConvIds = [...new Set(candidateMessages.map((m) => m.conversation_id).filter(Boolean))];
  let latestMessageConvIds = [];
  if (candidateConvIds.length) {
    const { data: candidateConvRows } = await supabase
      .from("conversations")
      .select("id, last_message_at")
      .eq("client_id", clientId)
      .in("id", candidateConvIds);
    const lastMessageAtById = new Map((candidateConvRows || []).map((c) => [c.id, c.last_message_at]));
    const matchedIds = new Set();
    for (const m of candidateMessages) {
      if (m.conversation_id && m.created_at != null && lastMessageAtById.get(m.conversation_id) === m.created_at) {
        matchedIds.add(m.conversation_id);
      }
    }
    latestMessageConvIds = [...matchedIds];
  }

  const matched = new Set([
    ...convFromContactOrIdentity,
    ...(leadsRes.data || []).map((r) => r.conversation_id),
    ...latestMessageConvIds,
    ...(exactConvRes.data || []).map((r) => r.id),
  ]);

  return matched;
}

// leadsOnly: which conversation ids have a captured lead, client-wide.
// Bounded by lead COUNT (small relative to messages/conversations at any
// realistic scale), not by message/conversation volume — no redesign
// needed here, same conclusion as the read-only investigation.
export async function resolveLeadConversationIds(supabase, clientId) {
  const { data } = await supabase.from("leads").select("conversation_id").eq("client_id", clientId);
  return new Set((data || []).map((r) => r.conversation_id));
}

// A single client/status/channel/leadsOnly/search restriction, resolved
// once and applied identically to both the page query and (for the
// initial page only) the total_count query below — chaining two separate
// `.in("id", ...)` calls on the same query ANDs them together (same as
// today), so this changes nothing about which rows match.
function applyConversationFilters(query, { status, channel, leadIds, searchIds }) {
  let q = query;
  if (status) q = q.eq("conversation_status", status);
  if (channel) q = q.eq("platform", channel);
  if (leadIds !== null) q = q.in("id", [...leadIds]);
  if (searchIds !== null) q = q.in("id", [...searchIds]);
  return q;
}

// A bounded COUNT(*)-only query (head:true — no row data transferred),
// same precedent as api/_lib/dashboardSummary.js. Restricted by the exact
// same client/status/channel/leadsOnly/search criteria as the page query,
// so it always reflects "how many conversations match the active filters
// in total," not just how many are currently loaded.
export async function countMatchingConversations(supabase, { clientId, status, channel, leadIds, searchIds }) {
  let query = supabase.from("conversations").select("id", { count: "exact", head: true }).eq("client_id", clientId);
  query = applyConversationFilters(query, { status, channel, leadIds, searchIds });
  const { count, error } = await query;
  if (error) return { ok: false, status: 500, message: "DB_ERROR", error };
  return { ok: true, total_count: count || 0 };
}

// ---------------------------------------------------------------------
// The paginated `conversations` page query itself. Returns
// { ok, status, message, conversations: <raw DESC rows>, has_more,
// total_count } — total_count is present only for the initial page of a
// filter set (beforeId absent); it doesn't change page to page, so "load
// more" requests skip recomputing it. enrichment (messages/leads/
// contact_channel_identities/contacts/conversation_state/users) is the
// caller's job, scoped to just these page rows' ids (see
// api/_lib/conversationsList.js).
// ---------------------------------------------------------------------
export async function fetchConversationsPage(
  supabase,
  { clientId, limit, beforeLastMessageAt, beforeId, status, channel, leadsOnly, searchTerm }
) {
  const hasBefore = beforeId !== undefined;
  if (hasBefore && !isValidCursorId(beforeId)) {
    return { ok: false, status: 400, message: "Invalid before_id cursor" };
  }
  if (beforeLastMessageAt !== undefined && !isValidCursorTimestamp(beforeLastMessageAt)) {
    return { ok: false, status: 400, message: "Invalid before_last_message_at cursor" };
  }

  const pageLimit = normalizePageLimit(limit);

  const leadIds = leadsOnly ? await resolveLeadConversationIds(supabase, clientId) : null;
  const searchIds = searchTerm !== undefined ? await resolveSearchConversationIds(supabase, { clientId, searchTerm }) : null;

  let query = supabase.from("conversations").select(CONVERSATION_COLUMNS).eq("client_id", clientId);
  query = applyConversationFilters(query, { status, channel, leadIds, searchIds });

  if (hasBefore) {
    if (beforeLastMessageAt !== undefined) {
      query = query.or(buildOlderThanFilter(beforeLastMessageAt, beforeId));
    } else {
      // The cursor row itself had a null last_message_at -> we're already
      // inside the null bucket; the only remaining order is by id.
      query = query.is("last_message_at", null).lt("id", beforeId);
    }
  }

  query = query
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(pageLimit + 1);

  const { data, error } = await query;
  if (error) return { ok: false, status: 500, message: "DB_ERROR", error };

  const { conversations, has_more } = trimPage(data, pageLimit);
  const result = { ok: true, status: 200, conversations, has_more };

  if (!hasBefore) {
    const countResult = await countMatchingConversations(supabase, { clientId, status, channel, leadIds, searchIds });
    if (!countResult.ok) return countResult;
    result.total_count = countResult.total_count;
  }

  return result;
}

// Delta/poll query — unbounded by page, bounded only by the safety cap
// below (far above realistic activity between two poll ticks). Applies
// the SAME status/channel/leadsOnly/search restriction as the caller's
// active filters, so a filtered view's live updates never surface a
// conversation that wouldn't match the current filter anyway.
export async function fetchConversationsDelta(supabase, { clientId, since, status, channel, leadsOnly, searchTerm }) {
  if (!isValidCursorTimestamp(since)) {
    return { ok: false, status: 400, message: "Invalid since watermark" };
  }

  let query = supabase.from("conversations").select(CONVERSATION_COLUMNS).eq("client_id", clientId);
  if (status) query = query.eq("conversation_status", status);
  if (channel) query = query.eq("platform", channel);

  if (leadsOnly) {
    const leadConversationIds = await resolveLeadConversationIds(supabase, clientId);
    query = query.in("id", [...leadConversationIds]);
  }
  if (searchTerm !== undefined) {
    const searchIds = await resolveSearchConversationIds(supabase, { clientId, searchTerm });
    if (searchIds !== null) query = query.in("id", [...searchIds]);
  }

  query = query
    .or(buildDeltaFilter(since))
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(ENRICHMENT_MESSAGES_SAFETY_LIMIT);

  const { data, error } = await query;
  if (error) return { ok: false, status: 500, message: "DB_ERROR", error };
  return { ok: true, status: 200, conversations: data || [] };
}

export { ENRICHMENT_MESSAGES_SAFETY_LIMIT };
