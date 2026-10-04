// Website Chat — backend -> n8n hand-off (Phase 3).
//
// Delivers a validated visitor message to the authenticated "Website Chat
// Webhook" of THIS environment's AutoResponder_Final_V3 copy. n8n remains the
// orchestrator (Conversation V2 -> AI-Agent-Core-V3 -> Apply Action V3 ->
// persistence); this module only forwards.
//
// Routing without new configuration:
//   projectRef = first DNS label of SUPABASE_URL (fallback VITE_SUPABASE_URL),
//                only for a *.supabase.co host — otherwise fail closed.
//   n8nOrigin  = origin of the existing VITE_WEBHOOK_BASE_URL; fallback: origin
//                of the existing system_settings.human_reply_webhook_url.
//   URL        = {n8nOrigin}/webhook/website-chat-{projectRef}
// DEV backend -> DEV Supabase ref -> the DEV copy's static path; PROD likewise.
//
// Auth: header x-ai-tools-secret = existing AI_TOOLS_SECRET (n8n Header Auth
// credential "AI Tools Secret"). The secret is never returned or logged.

export const DELIVERY_TIMEOUT_MS = 8000;

export function projectRefFromSupabaseUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:") return null;
    const m = u.hostname.toLowerCase().match(/^([a-z0-9]{20})\.supabase\.co$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function originFromUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function buildWebsiteChatWebhookUrl(n8nOrigin, projectRef) {
  return `${n8nOrigin}/webhook/website-chat-${projectRef}`;
}

// Resolves { url } or { error: "not_configured" } from existing configuration.
export async function resolveWebsiteChatWebhook({ env = process.env, getHumanReplyWebhookUrl } = {}) {
  const projectRef = projectRefFromSupabaseUrl(env.SUPABASE_URL || env.VITE_SUPABASE_URL);
  if (!projectRef) return { error: "not_configured" };
  let origin = originFromUrl(env.VITE_WEBHOOK_BASE_URL);
  if (!origin && typeof getHumanReplyWebhookUrl === "function") {
    try {
      origin = originFromUrl(await getHumanReplyWebhookUrl());
    } catch {
      origin = null;
    }
  }
  if (!origin) return { error: "not_configured" };
  return { url: buildWebsiteChatWebhookUrl(origin, projectRef) };
}

// Returns deliverToOrchestrator({ channelKey, visitorId, text, clientMessageId })
// -> { delivered: true } | { delivered: false, reason }
export function createN8nWebsiteChatDelivery({
  env = process.env,
  fetchImpl = globalThis.fetch,
  getHumanReplyWebhookUrl,
  timeoutMs = DELIVERY_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  return async function deliverToOrchestrator({ channelKey, visitorId, text, clientMessageId }) {
    const secret = env.AI_TOOLS_SECRET;
    if (!secret || typeof fetchImpl !== "function") return { delivered: false, reason: "not_configured" };
    const target = await resolveWebsiteChatWebhook({ env, getHumanReplyWebhookUrl });
    if (target.error) return { delivered: false, reason: "not_configured" };

    const body = {
      channel_key: channelKey,
      visitor_id: visitorId,
      text,
      client_message_id: clientMessageId,
      sent_at: now().toISOString(),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ai-tools-secret": secret },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response && response.ok) return { delivered: true };
      return { delivered: false, reason: `http_${response?.status ?? "unknown"}` };
    } catch (error) {
      return { delivered: false, reason: error?.name === "AbortError" ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  };
}
