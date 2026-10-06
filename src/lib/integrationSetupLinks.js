// Which channels show the generic "Automatic Setup Links" panel on the
// Integrations page (webhook URL built from the integration's channelKey,
// Telegram setWebhook link).
//
// Not for:
//   - instagram: InstagramSetupSection renders its own webhook / verify
//     token surface.
//   - website_chat: its channelKey is server-only (never sent to the
//     browser, D4) and it has no customer-side webhook — the widget embed
//     is managed through ?resource=website_chat.
const CHANNELS_WITHOUT_GENERIC_SETUP_LINKS = ["instagram", "website_chat"];

export function showsGenericSetupLinks(slug) {
  const s = `${slug || ""}`.toLowerCase();
  if (s.includes("instagram")) return false;
  return !CHANNELS_WITHOUT_GENERIC_SETUP_LINKS.includes(s);
}

// ---- Setup link values (Webhook URL + Telegram activation) -------------
// Built from this environment's Main Inbound Flow webhook base, served by
// the backend (system_settings.main_inbound_webhook_url via
// /api/client-integrations "list" / ?resource=feature_settings). There is
// deliberately NO fallback to VITE_WEBHOOK_BASE_URL: a missing/invalid base
// returns null so the UI shows "not configured" instead of a link that
// could point at another environment's workflow.

export function normalizeConfigKeyName(str) {
  return (str || "").toString().toLowerCase().replace(/\s+/g, "");
}

export function getConfigValue(config = {}, possibleKeys = []) {
  const source = config || {};
  const entries = Object.entries(source);
  for (const key of possibleKeys) {
    if (source[key] !== undefined && source[key] !== null && `${source[key]}`.trim() !== "") {
      return `${source[key]}`.trim();
    }
    const normalizedKey = normalizeConfigKeyName(key);
    const found = entries.find(([existingKey]) => normalizeConfigKeyName(existingKey) === normalizedKey);
    if (found && found[1] !== undefined && found[1] !== null && `${found[1]}`.trim() !== "") {
      return `${found[1]}`.trim();
    }
  }
  return "";
}

export function setupPlatformFromSlug(slug) {
  const s = `${slug || ""}`.toLowerCase();
  if (s.includes("telegram")) return "telegram";
  if (s.includes("facebook") || s.includes("messenger")) return "facebook";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("whatsapp")) return "whatsapp";
  return s || "channel";
}

// -> { platform, webhookUrl, activationUrl|null } or null when the base or
// the channelKey is missing.
export function buildChannelSetupLinks({ slug, config, inboundBase }) {
  const base = typeof inboundBase === "string" ? inboundBase.trim().replace(/\/+$/, "") : "";
  const channelKey = getConfigValue(config, ["channelKey", "channel_key", "Channel Key", "channel key"]);
  if (!base || !channelKey) return null;
  const platform = setupPlatformFromSlug(slug);
  const webhookUrl = `${base}/${platform}/${channelKey}`;
  const botToken = getConfigValue(config, ["Bot Token", "bot_token", "botToken", "Telegram Bot Token"]);
  const activationUrl =
    platform === "telegram" && botToken
      ? `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
      : null;
  return { platform, webhookUrl, activationUrl };
}
