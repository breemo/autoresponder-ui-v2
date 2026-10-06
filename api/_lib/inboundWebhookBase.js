// Main Inbound Flow — Webhook URL (system_settings.main_inbound_webhook_url).
//
// The environment-specific base of the AutoResponder_Final_V3 "Webhook"
// node (n8n serves route-parameter webhooks at /webhook/<webhookId>/<path>):
//   DEV : https://<n8n-host>/webhook/<dev-webhook-id>/dev/inbound
//   PROD: https://<n8n-host>/webhook/<prod-webhook-id>/inbound
// Channel setup links are built from it: <base>/<platform>/<channelKey>
// (Telegram / Facebook / Instagram). Each environment reads its OWN
// Supabase project's row server-side — never VITE_WEBHOOK_BASE_URL, never
// a browser read of system_settings. Non-secret, but routing-critical:
// written by platform admins only (api/system-settings.js).
//
// Validation (fail closed -> null): https only, no query / fragment /
// credentials, path contains /webhook/ and ends with /inbound; trailing
// slashes are stripped. The host is NOT restricted (hosting stays portable).

import { normalizeInboundWebhookBase } from "../../src/lib/n8nSettings.js";

export { normalizeInboundWebhookBase };

export const MAIN_INBOUND_WEBHOOK_KEY = "main_inbound_webhook_url";

// Reads + validates this environment's value. Returns the normalized base
// or null (missing / invalid / read error) — callers render "not configured".
export async function getMainInboundWebhookBase(supabase) {
  try {
    const { data, error } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", MAIN_INBOUND_WEBHOOK_KEY)
      .maybeSingle();
    if (error) return null;
    return normalizeInboundWebhookBase(data?.value);
  } catch {
    return null;
  }
}
