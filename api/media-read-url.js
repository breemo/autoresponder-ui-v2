import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";
import { MEDIA_BUCKET, SIGNED_READ_URL_TTL_SECONDS } from "../src/lib/mediaMessages.js";

// WhatsApp Media & Attachment Support v1 — Phase B: Storage foundation.
//
// Mints a short-lived signed READ URL for an existing private media_path.
// media_path is never signed as an arbitrary string: it must exactly match
// the media_path column of a real messages row that also matches both
// conversation_id and this actor's own client_id. A caller cannot use this
// endpoint to sign a path it merely guesses or one that belongs to another
// conversation/client, even within their own tenant — see the messages
// lookup below. Read access intentionally has no Human Takeover ownership
// check (unlike the write-side upload endpoint): viewing a conversation's
// existing messages has never required being its assigned owner anywhere
// else in this app (see ClientMessages.jsx's fetchConversationMessages),
// so this endpoint doesn't introduce a new restriction here either.
//
// Bucket stays private — no getPublicUrl() call exists anywhere in this
// codebase, and this endpoint is the only sanctioned way to obtain a
// usable URL for a stored attachment.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const conversation_id = typeof req.body?.conversation_id === "string" ? req.body.conversation_id : "";
  const actor_user_id = req.body?.actor_user_id;
  const media_path = typeof req.body?.media_path === "string" ? req.body.media_path : "";

  if (!conversation_id || !media_path) {
    return res.status(400).json({ success: false, message: "conversation_id and media_path are required" });
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

  // The check that makes this safe against arbitrary-path signing AND
  // against cross-conversation reuse: media_path must belong to a real
  // message that matches all three of client_id (server-derived, never
  // trusted from the request), the validated conversation_id string above,
  // and the exact media_path requested — all three in the same query, so a
  // media_path that's real but belongs to a different conversation of this
  // same client can never be signed through the currently selected
  // conversation.
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("id")
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id)
    .eq("media_path", media_path)
    .maybeSingle();

  if (messageError) {
    return res.status(500).json({ success: false, message: "فشل التحقق من الوسائط" });
  }
  if (!message) {
    return res.status(404).json({ success: false, message: "الوسائط غير موجودة ضمن هذا الحساب" });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({
      success: false,
      message: "Storage is not configured yet",
      code: "STORAGE_NOT_CONFIGURED",
    });
  }

  try {
    const { data, error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(media_path, SIGNED_READ_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      // Expected today: the bucket/object doesn't exist yet. Degrade
      // gracefully rather than a raw 500.
      return res.status(503).json({
        success: false,
        message: "Storage is not available yet",
        code: "STORAGE_UNAVAILABLE",
      });
    }

    return res.status(200).json({
      success: true,
      url: data.signedUrl,
      expires_in: SIGNED_READ_URL_TTL_SECONDS,
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: "Storage is not available yet",
      code: "STORAGE_UNAVAILABLE",
    });
  }
}
