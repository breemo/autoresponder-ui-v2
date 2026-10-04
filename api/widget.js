import { getSupabaseServerClient } from "./_lib/supabaseServer.js";
import { createWebsiteChatRepo } from "./_lib/websiteChatRepo.js";
import { bootstrap, startSession, pollMessages, submitMessage } from "./_lib/websiteChatService.js";
import { bearerTokenFromRequest, clientIpFromRequest, hashIp } from "./_lib/websiteChatKeys.js";
import { createN8nWebsiteChatDelivery } from "./_lib/websiteChatOrchestrator.js";

// Website Chat — the single PUBLIC backend function (no dashboard user, no
// actor_user_id). Everything is resolved server-side from the public widget
// key and the visitor bearer token; the browser never supplies client_id,
// conversation_id, channelKey or any employee identity.
//
//   POST /api/widget { action: "bootstrap", key, parent_origin }
//   POST /api/widget { action: "session",   key, parent_origin }   [Authorization: Bearer <visitor token>]
//   POST /api/widget { action: "messages",  after?: { created_at, id } }  Authorization: Bearer <visitor token>
//   POST /api/widget { action: "send",      text, client_message_id }     Authorization: Bearer <visitor token>
//
// `send` validates and rate-limits, then hands the message to the
// authenticated Website Chat ingress of this environment's
// AutoResponder_Final_V3 (api/_lib/websiteChatOrchestrator.js):
// 202 accepted | 502 upstream_unavailable | 503 not_configured.
// The widget frame (later phase) is served from this same origin, so a
// browser request carrying a foreign Origin header is rejected.

export function ownOriginMismatch(req) {
  const origin = req.headers?.origin;
  if (!origin) return false; // non-browser callers are covered by rate limits
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim().toLowerCase();
  try {
    return new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true;
  }
}

function defaultDeps() {
  const repo = createWebsiteChatRepo(getSupabaseServerClient());
  return {
    repo,
    deliverToOrchestrator: createN8nWebsiteChatDelivery({
      getHumanReplyWebhookUrl: () => repo.getHumanReplyWebhookUrl(),
    }),
  };
}

export async function handleWidgetRequest(req, res, deps) {
  res.setHeader?.("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, code: "method_not_allowed", message: "Method not allowed" });
  }
  if (ownOriginMismatch(req)) {
    return res.status(403).json({ ok: false, code: "forbidden_origin", message: "Forbidden" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const bearerToken = bearerTokenFromRequest(req);

  let out;
  try {
    const d = deps || defaultDeps();
    switch (body.action) {
      case "bootstrap":
        out = await bootstrap(d, { publicKey: body.key, parentOrigin: body.parent_origin });
        break;
      case "session":
        out = await startSession(d, {
          publicKey: body.key,
          parentOrigin: body.parent_origin,
          bearerToken,
          ipHash: d.ipHash !== undefined ? d.ipHash : hashIp(clientIpFromRequest(req)),
        });
        break;
      case "messages":
        out = await pollMessages(d, { bearerToken, after: body.after });
        break;
      case "send":
        out = await submitMessage(d, { bearerToken, text: body.text, clientMessageId: body.client_message_id });
        break;
      default:
        out = { status: 400, body: { ok: false, code: "unknown_action", message: "Unknown action" } };
    }
  } catch (error) {
    console.error("widget: request failed:", { action: body.action, code: error?.code, message: error?.message });
    return res.status(500).json({ ok: false, code: "server_error", message: "Something went wrong" });
  }
  return res.status(out.status).json(out.body);
}

export default async function handler(req, res) {
  // Service-role access is required (website_chat_visitors is server-only).
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, code: "not_configured", message: "Website Chat is not available" });
  }
  return handleWidgetRequest(req, res);
}
