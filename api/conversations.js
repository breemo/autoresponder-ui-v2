import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

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
// _at timestamps) are a deliberate, documented exception to "conversations
// is the source of truth" above: apply_conversation_lifecycle_action
// (Smart Assignment's 'system_assign' and Claim's 'accept') currently only
// writes conversation_state — conversations.system_assigned_user_id/
// assigned_user_id are never written by anything today, so reading them
// from `conversations` here would always render as unassigned regardless
// of real DB state. This is a known gap already scoped for a future
// Assignment/Lifecycle V2 migration (writing conversations directly); until
// that lands, these four fields specifically are read from
// conversation_state instead (matched by its own conversation_id column —
// the same lookup api/conversation.js's Conversation Card and
// api/conversation-lifecycle.js's Claim already use), while every other
// field on this response keeps coming from `conversations` unchanged. This
// does not change what Smart Assignment/Claim write, or the meaning of
// either field — only which table this one endpoint reads them from.
//
// Shape: GET /api/conversations?actor_user_id=<id>
//   -> { success: true, conversations: [...] }
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
// endpoint — they were already directly browser-readable).

function getMessageText(msg = {}) {
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

export default async function handler(req, res) {
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

  try {
    const [
      { data: conversationRows, error: conversationError },
      { data: channelIdentityRows, error: channelIdentityError },
      { data: whatsappRows, error: whatsappError },
      { data: messageRows, error: messageError },
      { data: leadRows, error: leadError },
      { data: conversationStateRows, error: conversationStateError },
    ] = await Promise.all([
      supabase
        .from("conversations")
        .select(
          "id, client_id, contact_id, channel_identity_id, platform, conversation_status, current_step, " +
            "assigned_user_id, assigned_at, " +
            "system_assigned_user_id, system_assigned_at, " +
            "solved_by, solved_at, reopened_by, reopened_at, last_message_at, created_at, updated_at"
        )
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_channel_identities")
        .select("id, sender_id, platform, channel_key")
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
      // See the module comment above: conversation_state, not conversations,
      // is where Smart Assignment/Claim actually write today.
      supabase
        .from("conversation_state")
        .select("conversation_id, system_assigned_user_id, system_assigned_at, assigned_user_id, assigned_at")
        .eq("client_id", clientId),
    ]);

    if (conversationError) throw conversationError;
    if (channelIdentityError) throw channelIdentityError;
    if (whatsappError) throw whatsappError;
    if (messageError) throw messageError;
    if (leadError) throw leadError;
    if (conversationStateError) throw conversationStateError;

    // Keyed by conversation_state.conversation_id (its own current-context
    // snapshot column, not its primary key) — the same lookup shape
    // api/conversation.js / api/conversation-lifecycle.js already use.
    const assignmentByConversationId = new Map();
    for (const row of conversationStateRows || []) {
      if (row.conversation_id) assignmentByConversationId.set(row.conversation_id, row);
    }

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
    function userRef(id) {
      if (!id) return null;
      return usersById.get(id) || { id, name: null };
    }

    const channelIdentityMap = new Map();
    for (const identity of channelIdentityRows || []) channelIdentityMap.set(identity.id, identity);

    // channel_key is only meaningful for WhatsApp today — keyed by
    // channel_key, not sender, so two numbers never collide here.
    const whatsappByChannelKey = new Map();
    for (const wa of whatsappRows || []) {
      if (wa.channel_key) whatsappByChannelKey.set(wa.channel_key, wa);
    }

    const leadMap = new Map();
    for (const lead of leadRows || []) {
      if (lead.conversation_id && !leadMap.has(lead.conversation_id)) leadMap.set(lead.conversation_id, lead);
    }

    // Enrichment only: last message preview/time/direction + counts, per
    // conversation_id. messageRows is already newest-first, so the first
    // occurrence seen per conversation_id is the latest message.
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

    // Primary loop: one entry per conversations row, keyed by its own id —
    // CRITICAL: never grouped or deduplicated by sender_id. Two rows
    // sharing a sender_id but with different channel_identity_id remain
    // two separate entries here, each with its own real status/assignment
    // straight from its own row.
    const merged = (conversationRows || []).map((row) => {
      const channelIdentity = channelIdentityMap.get(row.channel_identity_id) || null;
      const lead = leadMap.get(row.id);
      const agg = messageAggByConversation.get(row.id);
      const platform = row.platform || channelIdentity?.platform || "";
      const senderId = channelIdentity?.sender_id || agg?.fallbackSender || "";
      const whatsappInstance =
        platform.toLowerCase() === "whatsapp" && channelIdentity?.channel_key
          ? whatsappByChannelKey.get(channelIdentity.channel_key) || null
          : null;

      // See the module comment: conversation_state's snapshot (when a
      // matching row exists) is authoritative for these four fields today,
      // since it's the only place Smart Assignment/Claim actually write to
      // — `row`'s own (always-null today) columns are only a fallback so
      // this keeps working unchanged once a future fix writes them here.
      const stateAssignment = assignmentByConversationId.get(row.id) || null;
      const systemAssignedUserId = stateAssignment?.system_assigned_user_id ?? row.system_assigned_user_id ?? null;
      const systemAssignedAt = stateAssignment?.system_assigned_at ?? row.system_assigned_at ?? null;
      const assignedUserId = stateAssignment?.assigned_user_id ?? row.assigned_user_id ?? null;
      const assignedAt = stateAssignment?.assigned_at ?? row.assigned_at ?? null;

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
        assigned_user: userRef(assignedUserId),
        system_assigned_user_id: systemAssignedUserId,
        system_assigned_at: systemAssignedAt,
        system_assigned_user: userRef(systemAssignedUserId),
        solved_by: row.solved_by || null,
        solved_at: row.solved_at || null,
        reopened_by: row.reopened_by || null,
        reopened_at: row.reopened_at || null,
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at,
        last_message: agg?.lastMessage || "",
        last_message_at: agg?.lastAt || row.last_message_at || row.created_at,
        last_direction: agg?.lastDirection || "",
        sender: lead?.name || senderId || agg?.fallbackSender || "",
        lead_name: lead?.name || null,
        lead_phone: lead?.phone || null,
        has_lead: !!lead,
        messages_count: agg?.count || 0,
        unread_count: agg?.unread || 0,
        whatsapp_instance: whatsappInstance
          ? { display_name: whatsappInstance.display_name || null, phone: whatsappInstance.phone || null }
          : null,
      };
    });

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
