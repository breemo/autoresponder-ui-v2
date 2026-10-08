// Presentation helpers for the Client Inbox (no data fetching, no lifecycle
// logic — those stay in ClientMessages.jsx).

// Readable channel names for real platform values. Unknown values fall back
// to the raw value (existing behavior) via channelLabel().
const CHANNEL_LABELS = {
  whatsapp: "WhatsApp",
  whatsapp_evolution: "WhatsApp",
  facebook: "Messenger",
  messenger: "Messenger",
  instagram: "Instagram",
  telegram: "Telegram",
  website_chat: "Website Chat",
  website: "Website Chat",
  webchat: "Website Chat",
};

export function channelValue(conv) {
  return String(conv?.channel || conv?.platform || "").toLowerCase();
}

export function channelLabel(value, t) {
  const key = String(value || "").toLowerCase();
  return CHANNEL_LABELS[key] || value || t("messagesPage.unknownChannel");
}

// Real conversation lifecycle values: active | open | waiting_human | closed | lead_captured.
export function statusMeta(status, t) {
  switch (status) {
    case "waiting_human":
      return { label: t("common.waitingHuman"), tone: "amber" };
    case "closed":
      return { label: t("messagesPage.statusClosed"), tone: "slate" };
    case "lead_captured":
      return { label: t("navigation.leads"), tone: "violet" };
    case "open":
      return { label: t("messagesPage.statusOpen"), tone: "emerald" };
    default:
      return { label: t("messagesPage.statusActive"), tone: "emerald" };
  }
}

// Who sent a message, from fields the data model actually carries:
// direction, reply_source (ai | auto | human | quick_reply | system),
// sent_by_user_id, and the local optimistic-echo flag.
export function senderKind(msg) {
  if (["inbound", "in"].includes(msg?.direction)) return "customer";
  if (msg?._pending) return "employee";
  const src = msg?.reply_source;
  if (src === "ai") return "ai";
  if (src === "human" || msg?.sent_by_user_id) return "employee";
  if (src === "auto") return "auto";
  if (src === "quick_reply") return "quick";
  if (src === "system") return "system";
  return "outbound"; // outbound with no recorded source
}

export function formatTime(value, lang) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString(lang === "en" ? "en-US" : "ar-EG", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function formatDateTime(value, lang) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(lang === "en" ? "en-US" : "ar-EG", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return value;
  }
}

export function dayKey(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(value, t, lang) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const full = d.toLocaleDateString(lang === "en" ? "en-US" : "ar-EG", { year: "numeric", month: "short", day: "numeric" });
  if (dayKey(d) === dayKey(today)) return `${t("inbox.today")}, ${full}`;
  if (dayKey(d) === dayKey(yesterday)) return `${t("inbox.yesterday")}, ${full}`;
  return full;
}

export function relativeTime(value, t) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return t("common.timeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.timeHoursAgo", { count: hours });
  return t("common.timeDaysAgo", { count: Math.floor(hours / 24) });
}
