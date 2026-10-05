import { redactInstagramConfig } from "./instagramSetup.js";

// D4 — browser-safe view of a client_feature_integrations row.
//
// Every browser read of client_feature_integrations goes through a backend
// route (service role) and is projected here first:
//   - Instagram: the (encrypted) Page Access Token is stripped from
//     `config`; `config_flags.has_page_access_token` says whether one is
//     stored (see api/_lib/instagramSetup.js).
//   - Website Chat: `channelKey` is server-only by design (n8n routing
//     key) and is stripped. Sites are managed via ?resource=website_chat.
//   - Every other channel: `config` is returned unchanged to the tenant's
//     own authorized actor — the legacy editor shows/edits those fields and
//     builds the setup links from them (channelKey webhook URL, Telegram
//     setWebhook link). Making those secrets write-only is a separate
//     follow-up, not part of D4.

export const WEBSITE_CHAT_SLUG = "website_chat";

export function isInstagramSlug(slug) {
  // `.includes` on purpose: over-redacting is safe, a missed variant leaks.
  return `${slug || ""}`.toLowerCase().includes("instagram");
}

export function isWebsiteChatSlug(slug) {
  return `${slug || ""}`.toLowerCase() === WEBSITE_CHAT_SLUG;
}

export function safeIntegrationConfig(slug, config) {
  const source = config && typeof config === "object" ? config : {};
  if (isInstagramSlug(slug)) {
    const { config: safe, flags } = redactInstagramConfig(source);
    return { config: safe, config_flags: flags };
  }
  if (isWebsiteChatSlug(slug)) {
    // eslint-disable-next-line no-unused-vars
    const { channelKey, ...safe } = source;
    return { config: safe, config_flags: {} };
  }
  return { config: source, config_flags: {} };
}

export function safeIntegrationView(row, slug) {
  const { config, config_flags } = safeIntegrationConfig(slug, row?.config);
  return {
    id: row.id,
    client_id: row.client_id,
    feature_id: row.feature_id,
    is_active: row.is_active,
    created_at: row.created_at,
    slug: slug || null,
    config,
    config_flags,
  };
}

// feature_id -> lowercased slug for the given ids.
export async function featureSlugMap(supabase, featureIds) {
  const ids = [...new Set((featureIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from("features").select("id, slug").in("id", ids);
  if (error) throw error;
  return new Map((data || []).map((row) => [row.id, `${row.slug || ""}`.toLowerCase()]));
}
