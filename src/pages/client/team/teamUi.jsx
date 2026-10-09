import React from "react";
import {
  BoltIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  HomeIcon,
  LockClosedIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
  UserGroupIcon,
  UsersIcon,
  WrenchScrewdriverIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { cx } from "../../../components/app/primitives.jsx";
import { PERMISSIONS } from "../../../lib/permissions.js";
import { relativeFrom } from "./teamSummary.js";

export const PERMISSION_ORDER = Object.values(PERMISSIONS);

export const PERMISSION_ICONS = {
  dashboard: HomeIcon,
  inbox: ChatBubbleLeftRightIcon,
  leads: UsersIcon,
  auto_replies: BoltIcon,
  integrations: Squares2X2Icon,
  ai_settings: CpuChipIcon,
  team_management: UserGroupIcon,
  settings: Cog6ToothIcon,
};

export const ROLE_STYLE = {
  owner: { icon: ShieldCheckIcon, pill: "bg-violet-50 text-violet-700 ring-violet-200", avatar: "bg-violet-100 text-violet-700", bar: "bg-violet-500", dot: "bg-violet-500" },
  agent: { icon: UserIcon, pill: "bg-indigo-50 text-indigo-700 ring-indigo-200", avatar: "bg-indigo-100 text-indigo-700", bar: "bg-indigo-500", dot: "bg-indigo-500" },
  it: { icon: WrenchScrewdriverIcon, pill: "bg-sky-50 text-sky-700 ring-sky-200", avatar: "bg-sky-100 text-sky-700", bar: "bg-sky-500", dot: "bg-sky-500" },
};

export function MemberAvatar({ member, size = "h-10 w-10 text-sm" }) {
  const style = ROLE_STYLE[member.role] || ROLE_STYLE.agent;
  const initial = String(member.name || member.email || "?").trim().slice(0, 1).toUpperCase() || "?";
  return (
    <span className={cx("relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold", style.avatar, size)}>
      {initial}
      <span className={cx("absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full ring-2 ring-white", member.is_active ? "bg-emerald-500" : "bg-slate-300")} aria-hidden="true" />
    </span>
  );
}

export function RoleBadge({ role, t }) {
  const style = ROLE_STYLE[role] || ROLE_STYLE.agent;
  const Icon = style.icon;
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset", style.pill)}>
      <Icon className="h-3.5 w-3.5" />
      {t(`roles.${role}`)}
    </span>
  );
}

// Stacked role-distribution bar + legend (counts from the loaded list).
export function RoleMixBar({ roles, total, t }) {
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={Object.entries(roles).map(([r, n]) => `${t(`roles.${r}`)}: ${n}`).join(", ")}>
        {total > 0 &&
          Object.entries(roles).map(([r, n]) =>
            n > 0 ? <span key={r} className={cx("h-full", ROLE_STYLE[r]?.bar)} style={{ width: `${(n / total) * 100}%` }} /> : null
          )}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {Object.entries(roles).map(([r, n]) => (
          <li key={r} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span className={cx("h-2 w-2 rounded-full", ROLE_STYLE[r]?.dot)} />
            {t(`roles.${r}`)}
            <span className="font-semibold tabular-nums text-slate-900">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Permission selection as toggle cards. Same contract as the former
// PermissionChecklist: `selected` Set, onToggle(key), optional lockedOn key.
export function PermissionToggleGrid({ selected, onToggle, lockedOn, t }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {PERMISSION_ORDER.map((key) => {
        const checked = selected.has(key);
        const locked = lockedOn === key;
        const Icon = PERMISSION_ICONS[key] || Cog6ToothIcon;
        return (
          <label
            key={key}
            className={cx(
              "group relative flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition focus-within:ring-2 focus-within:ring-indigo-500",
              checked ? "border-indigo-300 bg-indigo-50/60" : "border-slate-200 bg-white hover:border-slate-300",
              locked && "cursor-not-allowed"
            )}
          >
            <input type="checkbox" className="sr-only" checked={checked} disabled={locked} onChange={() => onToggle(key)} />
            <span className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", checked ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500")}>
              <Icon className="h-4 w-4" />
            </span>
            <span className={cx("min-w-0 flex-1 text-[13px] font-medium", checked ? "text-slate-900" : "text-slate-600")}>{t(`permissions.${key}`)}</span>
            <span
              className={cx("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", checked ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-transparent")}
              aria-hidden="true"
            >
              {locked ? <LockClosedIcon className="h-3 w-3" /> : <CheckIcon className="h-3.5 w-3.5" />}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function RelativeTime({ value, lang, formatDate, neverLabel }) {
  const rel = relativeFrom(value);
  if (!rel) return <span className="text-slate-400">{neverLabel}</span>;
  let label;
  try {
    label = new Intl.RelativeTimeFormat(lang === "en" ? "en" : "ar", { numeric: "auto" }).format(-rel.n, rel.unit);
  } catch {
    label = formatDate(value, lang);
  }
  return (
    <span title={formatDate(value, lang)} className="whitespace-nowrap">
      {label}
    </span>
  );
}
