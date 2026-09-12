import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";
import { fetchConversationsPage, fetchConversationsDelta, ENRICHMENT_MESSAGES_SAFETY_LIMIT } from "./conversationListPage.js";

// Client Conversations (Inbox) list — server-side read model, Conversation
// Model V2. Stage A's contacts/contact_channel_identities/conversations
// have RLS enabled with zero browser policies (intentional — this app has
// no Supabase Auth session, so the browser's anon-keyed client can never
// read them directly; see the Stage A report). This endpoint is the
// smallest safe read path: it runs entirely server-side on the
// service-role client (which bypasses RLS) and returns exactly the merged
// shape ClientMessages.jsx used to assemble itself from five separate
// browser-side queries against conversation_state (now replaced) plus
// messages/leads.
//
// Assignment fields (system_assigned_user_id/assigned_user_id and their
// _at timestamps): as of the Conversation Lifecycle V2 migration
// (supabase/migrations/20260825_conversation_lifecycle_v2.sql),
// apply_conversation_lifecycle_action writes these authoritatively onto
// `conversations` itself, with conversation_state kept as a temporary
// compatibility dual-write only — so `conversations` is now preferred
// FIRST for these four fields. conversation_state remains a fallback
// (matched by its own conversation_id column — the same lookup
// api/conversation.js's Conversation Card and this file's former
// api/conversation-lifecycle.js Claim already use) purely for
// transitional safety: until that migration has actually been executed
// against live Supabase, `conversations`' columns stay null and this
// endpoint keeps working exactly as it did under the prior temporary
// patch. Once the migration is confirmed live and conversations is
// reliably populated, this fallback becomes dead weight that can be
// removed — left in deliberately for now rather than assuming migration
// timing. This does not change what Smart Assignment/Claim write, or the
// meaning of either field — only which table this one endpoint prefers
// reading them from.
//
// Vercel Hobby Function-count consolidation: this file was formerly the
// top-level api/conversations.js. Behavior, response shape, and every
// authorization/security check below are unchanged — only its file
// location and export name moved, so it can be dispatched from
// api/conversation.js (GET ?resource=list) instead of being its own
// deployed Vercel Function (see the deployment-failure inspection
// report). ClientMessages.jsx was updated to call the new URL; nothing
// else changed.
//
// Shape: GET /api/conversation?resource=list&actor_user_id=<id>
//   -> { success: true, conversations: [...] }
//
// Conversation List Pagination — additive, opt-in via &limit=. Omitted
// entirely, every branch below runs EXACTLY as before this feature (the
// original unbounded, all-conversations query, byte-identical response).
// With &limit=N present:
//   (no before_id, no since)          -> initial page: newest N conversations
//   &before_last_message_at=&before_id=  -> the next older page (see
//                                           api/_lib/conversationListPage.js
//                                           for the composite
//                                           (last_message_at, id) cursor
//                                           and its null-last_message_at
//                                           bucket handling)
//   &since=<ISO timestamp>            -> delta/poll: only conversations
//                                        whose last_message_at OR
//                                        updated_at changed since that
//                                        instant (ignores before_*) — see
//                                        the module comment in
//                                        conversationListPage.js for why
//                                        this is a wall-clock watermark,
//                                        not a per-row cursor.
// All three paginated shapes additionally accept the same &status=&channel=
// &leads_only=&search= filters the legacy query's client-side equivalent
// used to apply in the browser — now applied server-side, across the full
// dataset, before the cursor/delta restriction (see conversationListPage.js
// for exactly how each is implemented, including the one explicitly-flagged
// narrowing: conversation-id search only matches a FULL uuid exactly,
// not a substring, since that isn't expressible without a schema change).
// Every paginated/delta response also adds `has_more` and `server_time`
// (a server-clock instant the caller should track as its next poll
// watermark, so browser/server clock skew can never cause a missed
// update).
//
// Authorization: identical convention to every other endpoint in this
// app — only actor_user_id is trusted from the request; client_id,
// role, is_active, and INBOX permission are all re-derived server-side
// via resolveActingMembership()/actorHasPermission(), never taken from
// the browser. There is no client_id query param at all — every query
// below is scoped to actor.membership.client_id.
//
// conversations is the source of truth: one entry per conversations.id,
// never grouped/deduplicated by sender_id — two rows sharing a sender_id
// but with different channel_identity_id remain two independent entries,
// each carrying its own real status/assignment. contact_channel_identities
// is resolved per row (via channel_identity_id) purely for its identity
// fields (sender_id/platform/channel_key), never as a grouping key.
// client_whatsapp is resolved per row (client_id + channel_key) so the
// Portal can show which WhatsApp number/instance received it.
// messages/leads remain enrichment-only, grouped by conversation_id
// exactly as before (their own RLS/access model is unchanged by this
// endpoint — they were already directly browser-readable). Under
// pagination, this enrichment is scoped to just the page/delta's own
// conversation ids instead of the whole client — see enrichConversationRows
// below; the aggregation algorithm itself (last message/count/unread per
// conversation_id) is untouched, only its input row set is now bounded.

// Exported for focused testing only (api/_lib/__tests__/
// conversationListEnrichment.test.js) — bypasses the actor-resolution/HTTP
// layer above and exercises exactly the scoped-enrichment logic that
// replaced the original whole-client scan.
export function getMessageText(msg = {}) {
  return (
    msg.message ??
    msg.text ??
    msg.body ??
    msg.content ??
    msg.reply_text ??
    msg.reply ??
    msg.response ??
    msg.answer ??
    ""
  );
}

function userRef(usersById, id) {
  if (!id) return null;
  return usersById.get(id) || { id, name: null };
}

// Builds every lookup Map the merge step needs from already-fetched rows.
// Identical algorithm to the original single-function version — only
// extracted so both the legacy (client-wide) and paginated (page/delta-
// scoped) paths share one implementation and can never silently diverge.
function buildLookupMaps({ channelIdentityRows, whatsappRows, leadRows, conversationStateRows, contactRows, messageRows }) {
  const assignmentByConversationId = new Map();
  for (const row of conversationStateRows || []) {
    if (row.conversation_id) assignmentByConversationId.set(row.conversation_id, row);
  }

  const channelIdentityMap = new Map();
  for (const identity of channelIdentityRows || []) channelIdentityMap.set(identity.id, identity);

  const whatsappByChannelKey = new Map();
  for (const wa of whatsappRows || []) {
    if (wa.channel_key) whatsappByChannelKey.set(wa.channel_key, wa);
  }

  const leadMap = new Map();
  for (const lead of leadRows || []) {
    if (lead.conversation_id && !leadMap.has(lead.conversation_id)) leadMap.set(lead.conversation_id, lead);
  }

  const contactNameById = new Map();
  for (const c of contactRows || []) {
    const name = typeof c.display_name === "string" ? c.display_name.trim() : "";
    if (c.id && name) contactNameById.set(c.id, name);
  }

  const messageAggByConversation = new Map();
  for (const msg of messageRows || []) {
    if (!msg.conversation_id) continue;
    const existing = messageAggByConversation.get(msg.conversation_id);
    if (!existing) {
      messageAggByConversation.set(msg.conversation_id, {
        count: 1,
        unread: msg.is_read === false ? 1 : 0,
        lastMessage: getMessageText(msg) || "",
        lastAt: msg.created_at,
        lastDirection: msg.direction || "",
        fallbackSender: msg.sender || "",
      });
    } else {
      existing.count += 1;
      if (msg.is_read === false) existing.unread += 1;
    }
  }

  return { assignmentByConversationId, channelIdentityMap, whatsappByChannelKey, leadMap, contactNameById, messageAggByConversation };
}

// One `conversations` row -> the exact response entry shape, unchanged
// field-for-field from the original single-function version.
function buildMergedRow(row, maps, usersById) {
  const { assignmentByConversationId, channelIdentityMap, whatsappByChannelKey, leadMap, contactNameById, messageAggByConversation } = maps;

  const channelIdentity = channelIdentityMap.get(row.channel_identity_id) || null;
  const lead = leadMap.get(row.id);
  const agg = messageAggByConversation.get(row.id);
  const platform = row.platform || channelIdentity?.platform || "";
  const senderId = channelIdentity?.sender_id || agg?.fallbackSender || "";

  const identityName = typeof channelIdentity?.display_name === "string" ? channelIdentity.display_name.trim() : "";
  const customerName = contactNameById.get(row.contact_id) || identityName || lead?.name || null;

  const whatsappInstance =
    platform.toLowerCase() === "whatsapp" && channelIdentity?.channel_key
      ? whatsappByChannelKey.get(channelIdentity.channel_key) || null
      : null;

  const stateAssignment = assignmentByConversationId.get(row.id) || null;
  const systemAssignedUserId = row.system_assigned_user_id ?? stateAssignment?.system_assigned_user_id ?? null;
  const systemAssignedAt = row.system_assigned_at ?? stateAssignment?.system_assigned_at ?? null;
  const assignedUserId = row.assigned_user_id ?? stateAssignment?.assigned_user_id ?? null;
  const assignedAt = row.assigned_at ?? stateAssignment?.assigned_at ?? null;

  return {
    conversation_id: row.id,
    client_id: row.client_id,
    contact_id: row.contact_id,
    channel_identity_id: row.channel_identity_id,
    sender_id: senderId,
    channel_key: channelIdentity?.channel_key || null,
    platform,
    channel: platform,
    conversation_status: row.conversation_status || "active",
    current_step: row.current_step || null,
    assigned_user_id: assignedUserId,
    assigned_at: assignedAt,
    assigned_user: userRef(usersById, assignedUserId),
    system_assigned_user_id: systemAssignedUserId,
    system_assigned_at: systemAssignedAt,
    system_assigned_user: userRef(usersById, systemAssignedUserId),
    solved_by: row.solved_by || null,
    solved_at: row.solved_at || null,
    reopened_by: row.reopened_by || null,
    reopened_at: row.reopened_at || null,
    closed_at: row.closed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    last_message: agg?.lastMessage || "",
    last_message_at: agg?.lastAt || row.last_message_at || row.created_at,
    last_direction: agg?.lastDirection || "",
    sender: lead?.name || senderId || agg?.fallbackSender || "",
    customer_name: customerName,
    lead_name: lead?.name || null,
    lead_phone: lead?.phone || null,
    has_lead: !!lead,
    messages_count: agg?.count || 0,
    unread_count: agg?.unread || 0,
    whatsapp_instance: whatsappInstance
      ? { display_name: whatsappInstance.display_name || null, phone: whatsappInstance.phone || null }
      : null,
  };
}

// Enrichment scoped to exactly the given conversation rows' ids — the
// Conversation List Pagination fix for the original bottleneck (every
// query below used to be "every row for this client", regardless of how
// many conversations were actually being shown). client_whatsapp is left
// client-wide: it is a tiny per-account config table, not a scaling
// concern (same conclusion as the read-only investigation).
export async function enrichConversationRows(supabase, clientId, conversationRows) {
  if (conversationRows.length === 0) return [];

  const ids = conversationRows.map((r) => r.id);
  const channelIdentityIds = [...new Set(conversationRows.map((r) => r.channel_identity_id).filter(Boolean))];
  const contactIds = [...new Set(conversationRows.map((r) => r.contact_id).filter(Boolean))];

  const [
    { data: channelIdentityRows, error: channelIdentityError },
    { data: whatsappRows, error: whatsappError },
    { data: messageRows, error: messageError },
    { data: leadRows, error: leadError },
    { data: conversationStateRows, error: conversationStateError },
    { data: contactRows, error: contactError },
  ] = await Promise.all([
    channelIdentityIds.length
      ? supabase.from("contact_channel_identities").select("id, sender_id, platform, channel_key, display_name").eq("client_id", clientId).in("id", channelIdentityIds)
      : Promise.resolve({ data: [] }),
    supabase.from("client_whatsapp").select("channel_key, display_name, phone").eq("client_id", clientId),
    supabase
      .from("messages")
      .select("id, client_id, conversation_id, message, created_at, direction, channel, sender, is_read")
      .eq("client_id", clientId)
      .in("conversation_id", ids)
      .order("created_at", { ascending: false })
      .limit(ENRICHMENT_MESSAGES_SAFETY_LIMIT),
    supabase.from("leads").select("conversation_id, name, phone, created_at").eq("client_id", clientId).in("conversation_id", ids).order("created_at", { ascending: false }),
    supabase
      .from("conversation_state")
      .select("conversation_id, system_assigned_user_id, system_assigned_at, assigned_user_id, assigned_at")
      .eq("client_id", clientId)
      .in("conversation_id", ids),
    contactIds.length
      ? supabase.from("contacts").select("id, display_name").eq("client_id", clientId).in("id", contactIds)
      : Promise.resolve({ data: [] }),
  ]);

  if (channelIdentityError) throw channelIdentityError;
  if (whatsappError) throw whatsappError;
  if (messageError) throw messageError;
  if (leadError) throw leadError;
  if (conversationStateError) throw conversationStateError;
  if (contactError) throw contactError;

  const maps = buildLookupMaps({ channelIdentityRows, whatsappRows, leadRows, conversationStateRows, contactRows, messageRows });

  const assignmentUserIds = [];
  for (const row of conversationStateRows || []) {
    if (row.system_assigned_user_id) assignmentUserIds.push(row.system_assigned_user_id);
    if (row.assigned_user_id) assignmentUserIds.push(row.assigned_user_id);
  }
  for (const row of conversationRows) {
    if (row.assigned_user_id) assignmentUserIds.push(row.assigned_user_id);
    if (row.system_assigned_user_id) assignmentUserIds.push(row.system_assigned_user_id);
  }
  const uniqueAssignmentUserIds = [...new Set(assignmentUserIds)];
  const usersById = new Map();
  if (uniqueAssignmentUserIds.length > 0) {
    const { data: userRows, error: usersError } = await supabase.from("users").select("id, name").in("id", uniqueAssignmentUserIds);
    if (usersError) throw usersError;
    for (const u of userRows || []) usersById.set(u.id, { id: u.id, name: u.name });
  }

  return conversationRows.map((row) => buildMergedRow(row, maps, usersById));
}

function truthy(value) {
  return value === "1" || value === "true" || value === true;
}

export async function handleConversationsList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await resolveActingMembership(supabase, req.query?.actor_user_id);
  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INBOX)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  const clientId = actor.membership.client_id;

  // --- Conversation List Pagination: paginated / delta modes ------------
  // Both are additive and opt-in; the legacy unbounded query below (used
  // when neither &limit= nor &since= is present) is completely untouched.
  const filters = {
    status: req.query?.status && req.query.status !== "all" ? req.query.status : undefined,
    channel: req.query?.channel && req.query.channel !== "all" ? req.query.channel : undefined,
    leadsOnly: truthy(req.query?.leads_only),
    searchTerm: req.query?.search !== undefined ? req.query.search : undefined,
  };

  if (req.query?.since !== undefined) {
    try {
      const result = await fetchConversationsDelta(supabase, { clientId, since: req.query.since, ...filters });
      if (!result.ok) {
        if (result.error) console.error("conversations: delta query failed:", result.error);
        return res.status(result.status).json({ success: false, message: result.status === 400 ? result.message : "فشل في تحميل المحادثات" });
      }
      const conversations = await enrichConversationRows(supabase, clientId, result.conversations);
      return res.status(200).json({ success: true, conversations, has_more: false, server_time: new Date().toISOString() });
    } catch (error) {
      console.error("conversations: failed to load conversation delta:", error);
      return res.status(500).json({ success: false, message: "فشل في تحميل المحادثات" });
    }
  }

  if (req.query?.limit !== undefined) {
    try {
      const result = await fetchConversationsPage(supabase, {
        clientId,
        limit: req.query.limit,
        beforeLastMessageAt: req.query.before_last_message_at,
        beforeId: req.query.before_id,
        ...filters,
      });
      if (!result.ok) {
        if (result.error) console.error("conversations: paginated query failed:", result.error);
        return res.status(result.status).json({ success: false, message: result.status === 400 ? result.message : "فشل في تحميل المحادثات" });
      }
      const conversations = await enrichConversationRows(supabase, clientId, result.conversations);
      const response = { success: true, conversations, has_more: result.has_more, server_time: new Date().toISOString() };
      // total_count is only computed by fetchConversationsPage for the
      // initial page of a filter set (no before_id) — "load more" requests
      // omit it, since the total doesn't change page to page.
      if (result.total_count !== undefined) response.total_count = result.total_count;
      return res.status(200).json(response);
    } catch (error) {
      console.error("conversations: failed to load paginated conversation list:", error);
      return res.status(500).json({ success: false, message: "فشل في تحميل المحادثات" });
    }
  }

  // --- Legacy: unchanged, unbounded, whole-client query ------------------
  try {
    const [
      { data: conversationRows, error: conversationError },
      { data: channelIdentityRows, error: channelIdentityError },
      { data: whatsappRows, error: whatsappError },
      { data: messageRows, error: messageError },
      { data: leadRows, error: leadError },
      { data: conversationStateRows, error: conversationStateError },
      { data: contactRows, error: contactError },
    ] = await Promise.all([
      supabase
        .from("conversations")
        .select(
          "id, client_id, contact_id, channel_identity_id, platform, conversation_status, current_step, " +
            "assigned_user_id, assigned_at, " +
            "system_assigned_user_id, system_assigned_at, " +
            "solved_by, solved_at, reopened_by, reopened_at, closed_at, last_message_at, created_at, updated_at"
        )
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_channel_identities")
        .select("id, sender_id, platform, channel_key, display_name")
        .eq("client_id", clientId),
      supabase
        .from("client_whatsapp")
        .select("channel_key, display_name, phone")
        .eq("client_id", clientId),
      supabase
        .from("messages")
        .select("id, client_id, conversation_id, message, created_at, direction, channel, sender, is_read")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("leads")
        .select("conversation_id, name, phone, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("conversation_state")
        .select("conversation_id, system_assigned_user_id, system_assigned_at, assigned_user_id, assigned_at")
        .eq("client_id", clientId),
      supabase
        .from("contacts")
        .select("id, display_name")
        .eq("client_id", clientId),
    ]);

    if (conversationError) throw conversationError;
    if (channelIdentityError) throw channelIdentityError;
    if (whatsappError) throw whatsappError;
    if (messageError) throw messageError;
    if (leadError) throw leadError;
    if (conversationStateError) throw conversationStateError;
    if (contactError) throw contactError;

    const maps = buildLookupMaps({ channelIdentityRows, whatsappRows, leadRows, conversationStateRows, contactRows, messageRows });

    const assignmentUserIds = [];
    for (const row of conversationStateRows || []) {
      if (row.system_assigned_user_id) assignmentUserIds.push(row.system_assigned_user_id);
      if (row.assigned_user_id) assignmentUserIds.push(row.assigned_user_id);
    }
    const uniqueAssignmentUserIds = [...new Set(assignmentUserIds)];
    const usersById = new Map();
    if (uniqueAssignmentUserIds.length > 0) {
      const { data: userRows, error: usersError } = await supabase.from("users").select("id, name").in("id", uniqueAssignmentUserIds);
      if (usersError) throw usersError;
      for (const u of userRows || []) usersById.set(u.id, { id: u.id, name: u.name });
    }

    const merged = (conversationRows || []).map((row) => buildMergedRow(row, maps, usersById));

    merged.sort((a, b) => {
      const aTime = new Date(a.last_message_at || a.updated_at || 0).getTime();
      const bTime = new Date(b.last_message_at || b.updated_at || 0).getTime();
      return bTime - aTime;
    });

    return res.status(200).json({ success: true, conversations: merged });
  } catch (error) {
    console.error("conversations: failed to load conversation list:", error);
    return res.status(500).json({ success: false, message: "فشل في تحميل المحادثات" });
  }
}
