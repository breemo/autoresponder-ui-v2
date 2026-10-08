// Plan & Billing helpers — the same calculations the subscription sections
// used on the former Client Feature Settings page (AdminClientSettings.jsx,
// which keeps its own copy for the Admin Portal). Pure, no fetching.

export function formatDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(new Date(value));
  } catch {
    return "-";
  }
}

export function getRemainingDays(endDate, now = new Date()) {
  if (!endDate) return 0;
  const end = new Date(endDate);
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export function getUsagePercent(used, limit) {
  if (!limit) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

// level: "max" | "near" | "good" (labels/colors resolved by the caller)
export function getUsageLevel(percent) {
  if (percent >= 100) return "max";
  if (percent >= 80) return "near";
  return "good";
}

export function getStatusLabel(status, t) {
  const map = {
    active: t("common.active"),
    trial: t("common.trial"),
    expired: t("common.expired"),
    suspended: t("common.suspended"),
    cancelled: t("common.cancelled"),
    upgraded: t("common.upgraded"),
  };
  return map[status] || status;
}

export function getSubscriptionTypeLabel(type, t) {
  const map = { trial: t("common.trial"), paid: t("common.paid") };
  return map[type] || type;
}

export function getStatusClass(status) {
  switch (status) {
    case "active":
      return "bg-emerald-50 text-emerald-700 ring-emerald-100";
    case "trial":
      return "bg-blue-50 text-blue-700 ring-blue-100";
    case "expired":
      return "bg-rose-50 text-rose-700 ring-rose-100";
    case "suspended":
      return "bg-amber-50 text-amber-700 ring-amber-100";
    case "upgraded":
      return "bg-violet-50 text-violet-700 ring-violet-100";
    default:
      return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

// Remaining = plan limit - used (same arithmetic as before, may be negative
// when usage exceeded the limit; the UI shows the value as-is).
export function remaining(limit, used) {
  return (limit || 0) - (used || 0);
}

// The current subscription is the first "active" row (rows are ordered by
// created_at desc), exactly as before.
export function findActiveSubscription(rows) {
  return (rows || []).find((s) => s.status === "active") || null;
}
