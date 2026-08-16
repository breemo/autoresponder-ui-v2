import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";
import {
  MEDIA_MESSAGE_TYPES,
  MEDIA_BUCKET,
  SIGNED_UPLOAD_URL_TTL_SECONDS,
  validateMediaMeta,
  sanitizeFileName,
  buildMediaObjectPath,
} from "../src/lib/mediaMessages.js";

// WhatsApp Media & Attachment Support v1 — Phase B: Storage foundation.
//
// Mints a short-lived signed UPLOAD URL/token for one attachment, scoped to
// a Storage object path this endpoint itself derives — client_id and
// conversation_id are never taken from the browser as free text; both are
// re-verified below against a real conversation_state row owned by the
// resolved actor's own client (identical pattern to api/human-reply.js /
// api/conversation-status.js). The browser then uploads the file bytes
// directly to Supabase Storage using the returned token
// (supabase.storage.from(bucket).uploadToSignedUrl(path, token, file)) —
// this endpoint never receives or proxies file bytes itself.
//
// Requires SUPABASE_SERVICE_ROLE_KEY. This app has no Supabase Auth (no
// auth.uid()), so a private bucket's default-deny RLS on storage.objects
// can only be satisfied by the service role, which bypasses RLS entirely —
// see api/_lib/supabaseServer.js. If only the anon key is configured,
// Storage signing isn't possible yet; this endpoint reports that explicitly
// (503 STORAGE_NOT_CONFIGURED) instead of attempting a call that would only
// fail with a confusing permission error.
//
// This route does not create the bucket or any policy (Task 1 — not done
// in this phase) — a createSignedUploadUrl() call against a bucket that
// doesn't exist yet fails the same way any other Storage error would, and
// is caught below and reported as 503 STORAGE_UNAVAILABLE, never a raw 500.
//
// Media still never reaches n8n from here or anywhere else in this phase —
// this endpoint only prepares a place in Storage for a file to land; it has
// no relationship to api/human-reply.js's existing 501 MEDIA_NOT_SUPPORTED
// rejection, which is untouched.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const conversation_id = req.body?.conversation_id;
  const actor_user_id = req.body?.actor_user_id;
  const message_type = req.body?.message_type;
  const file_name = typeof req.body?.file_name === "string" ? req.body.file_name : "";
  const mime_type = typeof req.body?.mime_type === "string" ? req.body.mime_type : "";
  const size_bytes = req.body?.size_bytes;

  if (!conversation_id) {
    return res.status(400).json({ success: false, message: "conversation_id is required" });
  }
  if (!MEDIA_MESSAGE_TYPES.includes(message_type)) {
    return res.status(400).json({ success: false, message: "Unknown message_type" });
  }
  if (!file_name || !mime_type) {
    return res.status(400).json({ success: false, message: "file_name and mime_type are required" });
  }

  // Server-side re-validation — the browser's own check (validateMediaFile
  // in src/lib/mediaMessages.js) is UX only, never trusted as enforcement.
  const validation = validateMediaMeta(message_type, { mimeType: mime_type, sizeBytes: size_bytes });
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      message: validation.reason === "too_large" ? "File is too large" : "Unsupported file type",
      code: validation.reason === "too_large" ? "FILE_TOO_LARGE" : "UNSUPPORTED_FILE_TYPE",
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

  // Conversation must exist and belong to this actor's own client. Mirrors
  // api/human-reply.js exactly: client_id is never trusted from the
  // request, only ever actor.membership.client_id. conversation_id is
  // selected back out explicitly (not just filtered on) so the object path
  // below can be built from this validated row instead of the raw request
  // value — see the trust-boundary note there.
  const { data: state, error: stateError } = await supabase
    .from("conversation_state")
    .select("conversation_id, conversation_status, assigned_user_id")
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id)
    .maybeSingle();

  if (stateError) {
    return res.status(500).json({ success: false, message: "فشل التحقق من حالة المحادثة" });
  }
  if (!state) {
    return res.status(404).json({ success: false, message: "المحادثة غير موجودة ضمن هذا الحساب" });
  }

  // Human Takeover ownership — identical rule to api/human-reply.js. An
  // attachment destined for a waiting_human conversation is still "acting
  // on" it, so only its assigned employee (or nobody yet, which blocks
  // everyone) may request an upload URL for it.
  if (state.conversation_status === "waiting_human" && state.assigned_user_id !== actor.user.id) {
    return res.status(403).json({
      success: false,
      message: state.assigned_user_id
        ? "هذه المحادثة مستلمة بواسطة موظف آخر"
        : "يجب استلام المحادثة أولاً",
    });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({
      success: false,
      message: "Storage is not configured yet",
      code: "STORAGE_NOT_CONFIGURED",
    });
  }

  // Trust boundary made explicit: past this point, the object path is built
  // from state.conversation_id — the value just read back from the
  // validated conversation_state row — never from the raw request
  // conversation_id above, even though the two are equal in the success
  // case (the .eq() filter above guarantees that). This keeps every
  // downstream use of conversation_id anchored to something the query
  // itself proved belongs to this actor's client.
  const objectPath = buildMediaObjectPath({
    clientId: actor.membership.client_id,
    conversationId: state.conversation_id,
    fileName: sanitizeFileName(file_name),
  });

  try {
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUploadUrl(objectPath);

    if (error || !data) {
      // Expected today: the bucket doesn't exist yet (Task 1 — not created
      // in this phase). Degrade gracefully rather than a raw 500.
      return res.status(503).json({
        success: false,
        message: "Storage is not available yet",
        code: "STORAGE_UNAVAILABLE",
      });
    }

    return res.status(200).json({
      success: true,
      bucket: MEDIA_BUCKET,
      path: data.path || objectPath,
      token: data.token,
      expires_in: SIGNED_UPLOAD_URL_TTL_SECONDS,
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: "Storage is not available yet",
      code: "STORAGE_UNAVAILABLE",
    });
  }
}
