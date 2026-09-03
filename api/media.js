import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { resolveActingMembership, actorHasPermission } from "./_lib/clientAuthz.js";
import { PERMISSIONS } from "../src/lib/permissions.js";
import {
  MEDIA_MESSAGE_TYPES,
  MEDIA_BUCKET,
  SIGNED_READ_URL_TTL_SECONDS,
  SIGNED_UPLOAD_URL_TTL_SECONDS,
  validateMediaMeta,
  sanitizeFileName,
  buildMediaObjectPath,
} from "../src/lib/mediaMessages.js";
import { signInboundUpload } from "./_lib/mediaIngest.js";

// WhatsApp Media & Attachment Support v1 — API consolidation: this single
// domain endpoint replaces the former api/media-read-url.js (sign_read) and
// api/media-upload-url.js (sign_upload). Behavior, validation order,
// response shapes, and every authorization/security check are preserved
// exactly from both -- each action below is still its own self-contained
// handler (its own field validation -> its own getSupabaseServerClient()
// call -> its own actor resolution -> its own business logic, in the same
// order as the original file), only the routing/file layer is new. This
// keeps the two actions' error-path ordering byte-identical to before the
// merge rather than hoisting shared setup ahead of validation.
//
// Shape:
//   POST /api/media { action: "sign_read", conversation_id, actor_user_id, media_path }
//     -> former api/media-read-url.js
//   POST /api/media { action: "sign_upload", conversation_id, actor_user_id,
//                      message_type, file_name, mime_type, size_bytes }
//     -> former api/media-upload-url.js
//
// Bucket stays private -- no getPublicUrl() call exists anywhere in this
// codebase, and this endpoint (both actions) is the only sanctioned way to
// obtain a usable Storage URL/token for an attachment.

// POST { action: "sign_read", ... } — former api/media-read-url.js,
// unchanged. Mints a short-lived signed READ URL for an existing private
// media_path. media_path is never signed as an arbitrary string: it must
// exactly match the media_path column of a real messages row that also
// matches both conversation_id and this actor's own client_id. Read access
// intentionally has no Human Takeover ownership check (unlike sign_upload
// below) -- viewing a conversation's existing messages has never required
// being its assigned owner anywhere else in this app.
async function handleSignRead(req, res) {
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
  // and the exact media_path requested.
  //
  // Take the first match rather than requiring exactly one: the same
  // media_path can legitimately land on more than one messages row (an
  // n8n insert retry on the inbound-media ingestion path, a redelivered
  // provider webhook, or a later message re-referencing the attachment).
  // Any matching row already proves this actor's client owns this exact
  // object in this conversation, which is all the authorization needs.
  // .maybeSingle() previously returned a PGRST116 error for >1 row, which
  // surfaced as a 500 here and made the attachment render "failed to load"
  // for every media message in the thread — for any channel.
  const { data: messages, error: messageError } = await supabase
    .from("messages")
    .select("id")
    .eq("client_id", actor.membership.client_id)
    .eq("conversation_id", conversation_id)
    .eq("media_path", media_path)
    .order("created_at", { ascending: true })
    .limit(1);

  if (messageError) {
    return res.status(500).json({ success: false, message: "فشل التحقق من الوسائط" });
  }
  if (!messages || messages.length === 0) {
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

// POST { action: "sign_upload", ... } — former api/media-upload-url.js,
// unchanged. Mints a short-lived signed UPLOAD URL/token for one
// attachment, scoped to a Storage object path this endpoint itself
// derives -- client_id and conversation_id are never taken from the
// browser as free text; both are re-verified below against a real
// conversation_state row owned by the resolved actor's own client. The
// browser then uploads the file bytes directly to Supabase Storage using
// the returned token -- this endpoint never receives or proxies file
// bytes itself.
//
// Requires SUPABASE_SERVICE_ROLE_KEY. This app has no Supabase Auth (no
// auth.uid()), so a private bucket's default-deny RLS on storage.objects
// can only be satisfied by the service role, which bypasses RLS entirely.
// If only the anon key is configured, Storage signing isn't possible yet;
// this reports that explicitly (503 STORAGE_NOT_CONFIGURED) instead of
// attempting a call that would only fail with a confusing permission
// error.
//
// Media still never reaches n8n from here or anywhere else -- this only
// prepares a place in Storage for a file to land; it has no relationship
// to api/human-reply.js's own 501 MEDIA_NOT_SUPPORTED rejection, which is
// untouched.
async function handleSignUpload(req, res) {
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
  // value.
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
  // case (the .eq() filter above guarantees that).
  const objectPath = buildMediaObjectPath({
    clientId: actor.membership.client_id,
    conversationId: state.conversation_id,
    fileName: sanitizeFileName(file_name),
  });

  try {
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUploadUrl(objectPath);

    if (error || !data) {
      // Expected today: the bucket doesn't exist yet. Degrade gracefully
      // rather than a raw 500.
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

// POST { action: "sign_inbound_upload", ... } — Customer -> Inbox INBOUND media.
//
// Caller: the n8n "Inbound-Media-Core" sub-workflow only (server-to-server).
// Trust model matches api/ai-tools.js exactly: ONE shared secret, no
// actor_user_id, no browser. Reuses MEDIA_INGEST_SECRET if set, otherwise
// AI_TOOLS_SECRET (the credential n8n already holds) so no new configuration
// is required to launch. Once the secret is verified, conversation_id is the
// only identity the body carries — client_id/tenant and the Storage object
// path are derived server-side from that conversation row (see
// api/_lib/mediaIngest.js signInboundUpload). This never receives file bytes;
// it returns a signed upload URL the workflow uploads to directly, so
// SUPABASE_SERVICE_ROLE_KEY stays server-side — identical to handleSignUpload.
async function handleSignInboundUpload(req, res) {
  const providedSecret = req.headers["x-media-ingest-secret"] || req.headers["x-ai-tools-secret"];
  const expectedSecret = process.env.MEDIA_INGEST_SECRET || process.env.AI_TOOLS_SECRET;
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server is not configured" });
  }

  const result = await signInboundUpload(supabase, {
    conversationId: typeof req.body?.conversation_id === "string" ? req.body.conversation_id : "",
    messageType: req.body?.message_type,
    fileName: typeof req.body?.file_name === "string" ? req.body.file_name : "",
    mimeType: typeof req.body?.mime_type === "string" ? req.body.mime_type : "",
    sizeBytes: req.body?.size_bytes,
  });

  const { ok, status, ...rest } = result;
  return res.status(status).json({ success: ok, ...rest });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const action = req.body?.action;

  if (action === "sign_read") {
    return handleSignRead(req, res);
  }
  if (action === "sign_upload") {
    return handleSignUpload(req, res);
  }
  if (action === "sign_inbound_upload") {
    return handleSignInboundUpload(req, res);
  }

  return res.status(400).json({ success: false, message: "Unknown action" });
}
