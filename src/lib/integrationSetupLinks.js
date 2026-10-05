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
