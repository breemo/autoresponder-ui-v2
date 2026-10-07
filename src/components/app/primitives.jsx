import React from "react";
import { Link } from "react-router-dom";

// Small internal application UI kit for the authenticated Client Portal.
// Same visual language as the public website (indigo primary, violet accent,
// slate neutrals, soft shadows, rounded-xl controls / rounded-2xl cards) but
// denser, for operational screens. No external UI library.

export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
export function Card({ as: Tag = "section", className, padded = true, children, ...rest }) {
  return (
    <Tag
      className={cx(
        "rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-16px_rgba(49,46,129,0.18)]",
        padded && "p-4 sm:p-5",
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ title, subtitle, action, className }) {
  return (
    <div className={cx("mb-4 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-semibold text-slate-900 rtl:tracking-normal">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatTile — a KPI. `value` is rendered as given (pass null for "—").
// ---------------------------------------------------------------------------
const TILE_TONES = {
  indigo: "bg-indigo-50 text-indigo-600",
  violet: "bg-violet-50 text-violet-600",
  amber: "bg-amber-50 text-amber-600",
  emerald: "bg-emerald-50 text-emerald-600",
  sky: "bg-sky-50 text-sky-600",
  slate: "bg-slate-100 text-slate-600",
};

export function StatTile({ label, value, hint, icon: Icon, tone = "indigo", loading = false, href, className }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        {Icon && (
          <span className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", TILE_TONES[tone] || TILE_TONES.indigo)}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">{value ?? "—"}</p>
      )}
      {hint && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-400">{hint}</p>}
    </>
  );
  const base = cx(
    "block rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
    href && "transition hover:border-indigo-200 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
    className
  );
  if (href) {
    return (
      <Link to={href} className={base}>
        {body}
      </Link>
    );
  }
  return <div className={base}>{body}</div>;
}

// ---------------------------------------------------------------------------
// StatusPill
// ---------------------------------------------------------------------------
const PILL_TONES = {
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-100",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  rose: "bg-rose-50 text-rose-700 ring-rose-100",
  violet: "bg-violet-50 text-violet-700 ring-violet-100",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function StatusPill({ tone = "slate", dot = false, children, className }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset", PILL_TONES[tone] || PILL_TONES.slate, className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

// Conversation lifecycle (real values: active | waiting_human | closed).
export function conversationStatusTone(status) {
  if (status === "waiting_human") return "amber";
  if (status === "closed") return "slate";
  return "indigo";
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
export function Avatar({ name, className = "h-8 w-8 text-xs", tone = "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100" }) {
  const initial = String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
  return <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", tone, className)}>{initial}</span>;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
const BUTTON_VARIANTS = {
  primary: "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-700",
  secondary: "border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
};

export function Button({ variant = "secondary", size = "md", className, children, ...rest }) {
  const sizes = { sm: "h-8 px-3 text-xs", md: "h-9 px-3.5 text-sm" };
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60",
        BUTTON_VARIANTS[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tooltip — CSS-only, shown on hover/focus of the parent `group`. Positioned
// at the logical end side so it works in LTR and RTL.
// ---------------------------------------------------------------------------
export function Tooltip({ label, className }) {
  return (
    <span
      role="tooltip"
      className={cx(
        "pointer-events-none absolute start-full top-1/2 z-[60] ms-3 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
        className
      )}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProgressBar (usage)
// ---------------------------------------------------------------------------
export function ProgressBar({ percent, tone }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const color = tone || (p >= 100 ? "bg-rose-500" : p >= 80 ? "bg-amber-500" : "bg-indigo-600");
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
      <div className={cx("h-full rounded-full transition-[width] duration-300", color)} style={{ width: `${p}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState / Skeleton
// ---------------------------------------------------------------------------
export function EmptyState({ icon: Icon, title, children, className }) {
  return (
    <div className={cx("flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center", className)}>
      {Icon && <Icon className="mb-2 h-6 w-6 text-slate-300" />}
      <p className="text-sm font-medium text-slate-500">{title}</p>
      {children && <div className="mt-2 text-xs text-slate-400">{children}</div>}
    </div>
  );
}

export function Skeleton({ className }) {
  return <span className={cx("block animate-pulse rounded-md bg-slate-100", className)} />;
}
