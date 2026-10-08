// Pure helpers for the AI Agent page (no fetching).
import { isWebsiteChatSlug } from "../../../lib/websiteChatEmbed.js";

// Channel order of the approved design; anything else keeps its order after.
const ORDER = ["whatsapp", "facebook", "instagram", "telegram", "website"];

function orderKey(slug) {
  const s = String(slug || "").toLowerCase();
  if (isWebsiteChatSlug(s) || s.includes("website")) return "website";
  return ORDER.find((k) => s.includes(k)) || null;
}

export function sortChannelFeatures(features) {
  return [...(features || [])]
    .map((f, i) => ({ f, i, rank: ORDER.indexOf(orderKey(f.slug)) }))
    .sort((a, b) => (a.rank === -1 ? 99 : a.rank) - (b.rank === -1 ? 99 : b.rank) || a.i - b.i)
    .map((x) => x.f);
}

// Status from what the existing Integrations data actually provides:
//   "active"     — the channel's integration row exists and is_active === true
//   "paused"     — the row exists but is_active is false
//   "not_set_up" — the channel is in the plan but no integration row exists
// Deliberately NOT "connected": an integration row (or is_active) does not
// prove a live provider connection, and there is no health API.
export function channelIntegrationStatus(feature, integrations) {
  const row = (integrations || []).find((r) => r.feature_id === feature.id);
  if (!row) return "not_set_up";
  return row.is_active === true ? "active" : "paused";
}
