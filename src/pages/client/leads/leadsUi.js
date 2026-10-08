// Pure helpers for the Client Leads page (no fetching). KPI helpers are moved
// unchanged from ClientLeads.jsx; filters/export operate only on the leads
// already loaded for this client.

export function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

export function isToday(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

export function isLastSevenDays(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue).getTime();
  return Date.now() - d <= 7 * 24 * 60 * 60 * 1000;
}

function isLastDays(dateValue, days) {
  if (!dateValue) return false;
  const d = new Date(dateValue).getTime();
  return Number.isFinite(d) && Date.now() - d <= days * 24 * 60 * 60 * 1000;
}

// KPI values — same formulas as before, always over ALL loaded leads.
export function leadStats(leads) {
  const uniquePhones = new Set(leads.map((lead) => normalizePhone(lead.phone)).filter(Boolean));
  return {
    total: leads.length,
    unique: uniquePhones.size,
    today: leads.filter((lead) => isToday(lead.created_at)).length,
    week: leads.filter((lead) => isLastSevenDays(lead.created_at)).length,
  };
}

// Canonical channel key for a lead's enriched platform value; "unknown" when
// the conversation has no known channel.
// Same mapping as channelKeyFrom() in components/app/Channel.jsx (kept JSX-free
// here so it is unit-testable under node --test).
export function leadChannelKey(platform) {
  const key = String(platform || "").trim().toLowerCase();
  if (key.includes("whatsapp")) return "whatsapp";
  if (key.includes("instagram")) return "instagram";
  if (key.includes("messenger")) return "messenger";
  if (key.includes("facebook")) return "facebook";
  if (key.includes("telegram")) return "telegram";
  if (key.includes("website") || key.includes("webchat") || key.includes("web_chat")) return "website";
  return "unknown";
}

const CHANNEL_NAMES = {
  whatsapp: "WhatsApp",
  facebook: "Messenger",
  messenger: "Messenger",
  instagram: "Instagram",
  telegram: "Telegram",
  website: "Website Chat",
};

export function leadChannelLabel(key, t) {
  return CHANNEL_NAMES[key] || t("leads.unknownChannel");
}

export const TIME_FILTERS = ["all", "today", "7d", "30d"];

export function matchesTime(lead, time) {
  if (time === "today") return isToday(lead.created_at);
  if (time === "7d") return isLastSevenDays(lead.created_at);
  if (time === "30d") return isLastDays(lead.created_at, 30);
  return true;
}

// Search keeps every previously searchable field (name, phone, sender_id,
// conversation_id) and adds the readable channel name.
export function filterLeads(leads, { search = "", channel = "all", time = "all", channelOf, t }) {
  const q = search.trim().toLowerCase();
  return leads.filter((lead) => {
    const key = leadChannelKey(channelOf(lead));
    if (channel !== "all" && key !== channel) return false;
    if (!matchesTime(lead, time)) return false;
    if (!q) return true;
    return `${lead.name || ""} ${lead.phone || ""} ${lead.sender_id || ""} ${lead.conversation_id || ""} ${leadChannelLabel(key, t)}`
      .toLowerCase()
      .includes(q);
  });
}

// Channel filter options = channels actually present in the loaded data.
export function channelOptions(leads, channelOf) {
  const order = ["whatsapp", "facebook", "messenger", "instagram", "telegram", "website", "unknown"];
  const present = new Set(leads.map((l) => leadChannelKey(channelOf(l))));
  return order.filter((k) => present.has(k));
}

// Visual truncation only — the full value is always kept for copy/title.
export function shortId(id, head = 8, tail = 4) {
  const s = String(id || "");
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

// CSV cell: quoted, and neutralised against spreadsheet formula injection.
// A leading + or - is only treated as a formula when the value is not a plain
// phone/number, so phone numbers are exported exactly.
export function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  const isNumberLike = /^[+-]?[\d\s().-]+$/.test(s);
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !isNumberLike)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function leadsToCsv(rows, { channelOf, t, headers }) {
  const lines = [headers.map(csvCell).join(",")];
  for (const lead of rows) {
    lines.push(
      [lead.name || "", leadChannelLabel(leadChannelKey(channelOf(lead)), t), lead.phone || "", lead.sender_id || "", lead.conversation_id || "", lead.created_at || ""]
        .map(csvCell)
        .join(",")
    );
  }
  return "﻿" + lines.join("\r\n");
}

// Deterministic channel resolution for a lead, by EXACT conversation id only
// (never by sender_id — one sender may exist on several channels/accounts).
// Precedence:
//   1. V2 `conversations` row (via the authorized Inbox list endpoint) —
//      platform + WhatsApp account identity. source: "conversation"
//   2. legacy `conversation_state` row with the same conversation_id
//      (the previous source). source: "legacy"
//   3. unresolved -> honest "unknown". source: null
export function resolveLeadChannel(lead, v2ById, legacyById) {
  const cid = lead?.conversation_id;
  const v2 = cid && v2ById ? v2ById.get(cid) : null;
  if (v2 && leadChannelKey(v2.platform) !== "unknown") {
    const wa = leadChannelKey(v2.platform) === "whatsapp" ? v2.whatsapp_instance : null;
    return {
      platform: v2.platform,
      key: leadChannelKey(v2.platform),
      source: "conversation",
      channelKey: v2.channel_key || null,
      account: wa ? wa.display_name || wa.phone || null : null,
      inInbox: true,
    };
  }
  const legacy = cid && legacyById ? legacyById[cid] : null;
  if (legacy && leadChannelKey(legacy) !== "unknown") {
    return { platform: legacy, key: leadChannelKey(legacy), source: "legacy", channelKey: null, account: null, inInbox: !!v2 };
  }
  return { platform: null, key: "unknown", source: null, channelKey: null, account: null, inInbox: !!v2 };
}

// True when the resolved leads span more than one WhatsApp account — the
// account name is only shown then (same rule as the Inbox).
export function hasMultipleWhatsappAccounts(resolutions) {
  const keys = new Set();
  for (const r of resolutions) if (r.key === "whatsapp" && r.channelKey) keys.add(r.channelKey);
  return keys.size > 1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isConversationUuid(value) {
  return UUID_RE.test(String(value || ""));
}

export function inboxConversationHref(conversationId) {
  return `/client/messages?conversation=${encodeURIComponent(conversationId)}`;
}
