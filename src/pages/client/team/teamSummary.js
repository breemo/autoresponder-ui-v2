// Pure, presentation-only helpers for Team Members. Everything is derived
// from the member list the page already loads — no new requests or data.

export function summarizeMembers(members) {
  const list = members || [];
  const roles = { owner: 0, agent: 0, it: 0 };
  let active = 0;
  for (const m of list) {
    if (m.is_active) active += 1;
    if (roles[m.role] !== undefined) roles[m.role] += 1;
  }
  return { total: list.length, active, inactive: list.length - active, roles };
}

// Local filtering of the loaded list (search name/email, role, status).
export function filterMembers(members, { query = "", role = "all", status = "all" } = {}) {
  const q = query.trim().toLowerCase();
  return (members || []).filter((m) => {
    if (role !== "all" && m.role !== role) return false;
    if (status === "active" && !m.is_active) return false;
    if (status === "inactive" && m.is_active) return false;
    if (!q) return true;
    return `${m.name || ""} ${m.email || ""}`.toLowerCase().includes(q);
  });
}

// "3 days ago" style label from a timestamp; null -> null (caller shows "—").
export function relativeFrom(value, now = Date.now()) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return { unit: "second", n: sec };
  const min = Math.round(sec / 60);
  if (min < 60) return { unit: "minute", n: min };
  const h = Math.round(min / 60);
  if (h < 24) return { unit: "hour", n: h };
  const d = Math.round(h / 24);
  if (d < 30) return { unit: "day", n: d };
  const mo = Math.round(d / 30);
  if (mo < 12) return { unit: "month", n: mo };
  return { unit: "year", n: Math.round(mo / 12) };
}
