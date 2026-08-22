import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";

// Conversation Card V1 — internal employee notes. GET lists, POST
// add/edit/delete (same GET+POST-with-action shape as api/client-users.js).
// Notes are internal only -- nothing in this file, or anywhere else in the
// app, ever forwards conversation_notes content to a customer-facing send
// path; enforcing that is simply a matter of no such path existing (same
// approach the schema's own comment documents for conversation_notes).
//
// Authorization: create requires the same INBOX permission every other
// Inbox action requires. Edit/delete are author-only (author_user_id ===
// the resolved actor's own user id) -- this app's authorization model
// (src/lib/permissions.js) has no existing concept of one member acting on
// content another member authored (client-users.js's owner-only checks are
// about managing OTHER MEMBERSHIPS/permissions, not about overriding
// authorship of content), so no such override is invented here.
//
// Tenant scope: every read/write is scoped to the actor's own
// client_id, re-derived server-side via resolveActingMembership -- never
// trusted from the request body/query. conversation_notes has RLS enabled
// with zero policies (service-role-only by default-deny -- see
// supabase/migrations/20260820_conversation_lifecycle_tracking.sql), so
// this endpoint (running on the service-role-preferring server client) is
// the only path that can reach this table at all; the browser's anon key
// cannot touch it directly.

async function requireActor(req, res, supabase) {
  const actorUserId = req.method === "GET" ? req.query?.actor_user_id : req.body?.actor_user_id;

  const actor = await resolveActingMembership(supabase, actorUserId);
  if (!actor) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }
  if (actor.user.must_change_password) {
    res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
    return null;
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INBOX)) {
    res.status(403).json({ success: false, message: "Forbidden" });
    return null;
  }

  return actor;
}

function serializeNote(row) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    body: row.body,
    author_user_id: row.author_user_id,
    author: row.users ? { id: row.users.id, name: row.users.name } : { id: row.author_user_id, name: null },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Resolves the stable conversation_state_id for (client, conversation_id) --
// the same lookup shape claim-conversation.js/conversation-status.js already
// use, scoped to the actor's own client_id.
async function resolveConversationStateId(supabase, clientId, conversationId) {
  const { data, error } = await supabase
    .from("conversation_state")
    .select("id")
    .eq("client_id", clientId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error) throw error;
  return data?.id || null;
}

export default async function handler(req, res) {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  // conversation_notes has RLS enabled with zero policies -- reachable
  // only by service_role (see supabase/migrations/20260820_conversation_
  // lifecycle_tracking.sql). getSupabaseServerClient() silently falls back
  // to the anon key if SUPABASE_SERVICE_ROLE_KEY isn't set (see that
  // file's own console.warn). For a write (add/edit/delete) that fallback
  // does fail loudly (an RLS-violation error from Postgres), but for GET a
  // SELECT under zero-policy RLS succeeds with an empty result set rather
  // than erroring -- silently rendering "no notes" instead of surfacing
  // the real misconfiguration. Fail fast here instead, loudly, for both.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("conversation-notes: SUPABASE_SERVICE_ROLE_KEY is not set -- refusing to serve conversation_notes (the anon-key fallback would silently return empty results on GET under RLS, not an error).");
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  if (req.method === "GET") {
    const actor = await requireActor(req, res, supabase);
    if (!actor) return;

    const conversationId = req.query?.conversation_id;
    if (!conversationId) {
      return res.status(400).json({ success: false, message: "conversation_id is required" });
    }

    const { data, error } = await supabase
      .from("conversation_notes")
      .select("id, conversation_id, body, author_user_id, created_at, updated_at, users:author_user_id(id, name)")
      .eq("client_id", actor.membership.client_id)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("conversation-notes: failed to list notes:", error);
      return res.status(500).json({ success: false, message: "فشل تحميل الملاحظات" });
    }

    return res.status(200).json({ success: true, notes: (data || []).map(serializeNote), actor_user_id: actor.user.id });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const action = req.body?.action;

  if (action === "add") {
    const actor = await requireActor(req, res, supabase);
    if (!actor) return;

    const conversationId = req.body?.conversation_id;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";

    if (!conversationId) {
      return res.status(400).json({ success: false, message: "conversation_id is required" });
    }
    if (!body) {
      return res.status(400).json({ success: false, message: "الملاحظة لا يمكن أن تكون فارغة" });
    }

    let conversationStateId;
    try {
      conversationStateId = await resolveConversationStateId(supabase, actor.membership.client_id, conversationId);
    } catch (error) {
      console.error("conversation-notes: failed to resolve conversation_state:", error);
      return res.status(500).json({ success: false, message: "فشل إضافة الملاحظة" });
    }
    if (!conversationStateId) {
      return res.status(404).json({ success: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
    }

    const { data, error } = await supabase
      .from("conversation_notes")
      .insert({
        client_id: actor.membership.client_id,
        conversation_state_id: conversationStateId,
        conversation_id: conversationId,
        author_user_id: actor.user.id,
        body,
      })
      .select("id, conversation_id, body, author_user_id, created_at, updated_at, users:author_user_id(id, name)")
      .single();

    if (error) {
      console.error("conversation-notes: failed to add note:", error);
      return res.status(500).json({ success: false, message: "فشل إضافة الملاحظة" });
    }

    return res.status(200).json({ success: true, note: serializeNote(data) });
  }

  if (action === "edit" || action === "delete") {
    const actor = await requireActor(req, res, supabase);
    if (!actor) return;

    const noteId = req.body?.note_id;
    if (!noteId) {
      return res.status(400).json({ success: false, message: "note_id is required" });
    }

    // Author-only, scoped to the actor's own client_id -- see the module
    // comment: no owner/broader override exists in this app's model.
    const { data: existing, error: existingError } = await supabase
      .from("conversation_notes")
      .select("id, client_id, author_user_id")
      .eq("id", noteId)
      .maybeSingle();

    if (existingError) {
      console.error("conversation-notes: failed to load note:", existingError);
      return res.status(500).json({ success: false, message: "فشل تنفيذ العملية" });
    }
    if (!existing || existing.client_id !== actor.membership.client_id) {
      return res.status(404).json({ success: false, message: "الملاحظة غير موجودة" });
    }
    if (existing.author_user_id !== actor.user.id) {
      return res.status(403).json({ success: false, message: "يمكنك فقط تعديل أو حذف ملاحظاتك الخاصة" });
    }

    if (action === "delete") {
      const { error } = await supabase.from("conversation_notes").delete().eq("id", noteId);
      if (error) {
        console.error("conversation-notes: failed to delete note:", error);
        return res.status(500).json({ success: false, message: "فشل حذف الملاحظة" });
      }
      return res.status(200).json({ success: true, deleted_id: noteId });
    }

    // action === "edit"
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) {
      return res.status(400).json({ success: false, message: "الملاحظة لا يمكن أن تكون فارغة" });
    }

    const { data, error } = await supabase
      .from("conversation_notes")
      .update({ body, updated_at: new Date().toISOString() })
      .eq("id", noteId)
      .select("id, conversation_id, body, author_user_id, created_at, updated_at, users:author_user_id(id, name)")
      .single();

    if (error) {
      console.error("conversation-notes: failed to edit note:", error);
      return res.status(500).json({ success: false, message: "فشل تعديل الملاحظة" });
    }

    return res.status(200).json({ success: true, note: serializeNote(data) });
  }

  return res.status(400).json({ success: false, message: "Unknown action" });
}
