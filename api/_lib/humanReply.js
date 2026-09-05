import { getSupabaseServerClient } from "./supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./clientAuthz.js";
import { PERMISSIONS } from "../../src/lib/permissions.js";
import { loadConversationGate, humanTakeoverBlock } from "./conversationOwnership.js";
import {
  MESSAGE_TYPES,
  MEDIA_MESSAGE_TYPES,
  MEDIA_BUCKET,
  SIGNED_READ_URL_TTL_SECONDS,
  validateMediaMeta,
  mediaPathBelongsToConversation,
} from "../../src/lib/mediaMessages.js";

const SETTING_KEY = "human_reply_webhook_url";

// Vercel Hobby Function-count consolidation: this file was formerly the
// top-level api/human-reply.js, dispatched from api/conversation.js's POST
// action switch (action: "human_reply") instead of being its own deployed
// Vercel Function — see the deployment-failure inspection report.
// Behavior, validation, and every authorization/security check below are
// completely unchanged; ClientMessages.jsx was updated to call the new URL
// and include the "human_reply" action field, nothing else changed.
//
// Thin proxy to the n8n Human Reply workflow, following the same
// fetch-and-relay shape as api/create-whatsapp-instance.js. n8n resolves
// client/channel/integration from conversation_id and owns both channel
// delivery and the outbound Supabase insert — this endpoint does neither.
//
// Authorization: the caller must resolve to an active client_users
// membership with `inbox` permission. Same documented limitation as
// elsewhere: only `actor_user_id` is trusted, and it isn't cryptographically
// verified (no session tokens exist in this app).
//
// Architecture boundary: subscription/plan entitlement (is the client's
// subscription active, expired, does the plan allow sending, does it
// support AI, etc.) is intentionally NOT re-checked here. The n8n workflow
// this proxies to already performs that check authoritatively, early in
// its own flow, against the same Supabase data. Duplicating that business
// logic here would create two independent implementations that can drift
// and disagree — this endpoint only ever enforces identity/permission
// authorization and multi-tenant isolation, not runtime service
// entitlement. See supabase/migrations/20260814_client_subscription_status_view.sql
// for the (UI-only) subscription status read-model this app still owns.
export async function handleHumanReply(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const conversation_id = req.body?.conversation_id;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const actor_user_id = req.body?.actor_user_id;

  // WhatsApp Media & Attachment Support v1. message_type defaults to "text"
  // so every existing caller (which never sends this field) is completely
  // unaffected. Media fields are flat, mirroring the messages table's own
  // media_* columns and api/media-upload-url.js's response shape — the same
  // names used throughout the client (uploadAttachmentToStorage in
  // ClientMessages.jsx).
  const message_type = typeof req.body?.message_type === "string" ? req.body.message_type : MESSAGE_TYPES.TEXT;
  const media_path = typeof req.body?.media_path === "string" ? req.body.media_path : "";
  const media_mime_type = typeof req.body?.media_mime_type === "string" ? req.body.media_mime_type : "";
  const media_file_name = typeof req.body?.media_file_name === "string" ? req.body.media_file_name : "";
  const media_size_bytes = req.body?.media_size_bytes;
  const isMediaMessage = message_type !== MESSAGE_TYPES.TEXT;

  if (!conversation_id) {
    return res.status(400).json({ success: false, message: "conversation_id is required" });
  }
  if (isMediaMessage && !MEDIA_MESSAGE_TYPES.includes(message_type)) {
    return res.status(400).json({ success: false, message: "Unknown message_type" });
  }
  if (isMediaMessage && (!media_path || !media_file_name)) {
    return res.status(400).json({
      success: false,
      message: "media_path and media_file_name are required for a media message",
    });
  }
  // Same rule set api/media-upload-url.js already enforced when the object
  // was uploaded — re-checked here rather than trusted, exactly like the
  // "client-side checks are UX, not enforcement" principle applied
  // everywhere else in this app.
  if (isMediaMessage) {
    const validation = validateMediaMeta(message_type, { mimeType: media_mime_type, sizeBytes: media_size_bytes });
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.reason === "too_large" ? "File is too large" : "Unsupported file type",
        code: validation.reason === "too_large" ? "FILE_TOO_LARGE" : "UNSUPPORTED_FILE_TYPE",
      });
    }
  }
  // A media message's text is an optional caption (may legitimately be
  // empty) — only a plain text message requires non-empty message content,
  // exactly like today.
  if (!isMediaMessage && !message) {
    return res.status(400).json({
      success: false,
      message: "conversation_id and message are required",
    });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const actor = await resolveActingMembership(supabase, actor_user_id);
  if (!actor) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (actor.user.must_change_password) {
    return res.status(403).json({ success: false, message: "يجب تغيير كلمة المرور المؤقتة أولاً" });
  }
  if (!actorHasPermission(actor.membership, PERMISSIONS.INBOX)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  // Human Takeover ownership: a conversation already in the human queue
  // (waiting_human) can only be replied to by its assigned employee — and
  // if nobody has claimed it yet (assigned_user_id null), nobody may reply
  // until someone does. A conversation not in that state has no owner
  // concept and stays unrestricted (unchanged behaviour — a human can
  // already reply on a normal active/AI-driven conversation).
  //
  // Read from public.conversations (authoritative since Conversation
  // Lifecycle V2), the exact same source the Inbox composer's enable/
  // disable state and the claim/close endpoints use — reading a stale
  // conversation_state mirror here is what made the two disagree and
  // surface a false "يجب استلام المحادثة أولاً". See
  // api/_lib/conversationOwnership.js.
  let gate;
  try {
    gate = await loadConversationGate(supabase, actor.membership.client_id, conversation_id);
  } catch (e) {
    return res.status(500).json({ success: false, message: "فشل التحقق من حالة المحادثة" });
  }

  const block = humanTakeoverBlock(gate, actor.user.id);
  if (block) {
    return res.status(403).json({ success: false, message: block.message });
  }

  // No subscription/entitlement check here — see the architecture note
  // above. n8n decides whether this client is allowed to send.

  // WhatsApp Media & Attachment Support v1 — media authorization, deliberately
  // AFTER every actor/permission/Human-Takeover check above has already run
  // (so this endpoint never becomes a way to probe/sign a path for a
  // conversation the caller isn't even allowed to act on). No `messages` row
  // exists yet for this media (n8n creates it), so — unlike
  // api/media-read-url.js — ownership is verified via the object path's own
  // {client_id}/{conversation_id}/ namespace, which only api/media-upload-url.js
  // ever mints into (see mediaPathBelongsToConversation).
  let mediaReadUrl = null;
  if (isMediaMessage) {
    if (!mediaPathBelongsToConversation({ mediaPath: media_path, clientId: actor.membership.client_id, conversationId: conversation_id })) {
      return res.status(403).json({ success: false, message: "الوسائط غير مصرح بها لهذه المحادثة" });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({
        success: false,
        message: "Storage is not configured yet",
        code: "STORAGE_NOT_CONFIGURED",
      });
    }

    try {
      const { data: signed, error: signError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(media_path, SIGNED_READ_URL_TTL_SECONDS);

      if (signError || !signed?.signedUrl) {
        return res.status(503).json({
          success: false,
          message: "Storage is not available yet",
          code: "STORAGE_UNAVAILABLE",
        });
      }
      mediaReadUrl = signed.signedUrl;
    } catch (error) {
      return res.status(503).json({
        success: false,
        message: "Storage is not available yet",
        code: "STORAGE_UNAVAILABLE",
      });
    }
  }

  const { data: setting, error: settingError } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle();

  const webhookUrl = setting?.value;

  if (settingError || !webhookUrl) {
    return res.status(500).json({
      success: false,
      message: "Human reply webhook is not configured",
    });
  }

  try {
    // sent_by_user_id and message_type are additive and safe to send even
    // where an n8n workflow doesn't read them yet — same precedent as the
    // pre-existing sent_by_user_id field (see the "Human takeover
    // readiness" note in the implementation report). Text payload shape is
    // otherwise byte-for-byte unchanged from before media support existed,
    // so the current production webhook keeps working untouched. Media
    // fields are only ever present for a media message.
    const payload = {
      conversation_id,
      message_type,
      message,
      sent_by_user_id: actor.user.id,
    };
    if (isMediaMessage) {
      payload.media_url = mediaReadUrl;
      payload.media_path = media_path;
      payload.media_mime_type = media_mime_type;
      payload.media_file_name = media_file_name;
      payload.media_size_bytes = media_size_bytes;
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to reach human reply workflow",
    });
  }
}
