import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EllipsisHorizontalIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { cx } from "./primitives.jsx";

// Client Portal overlays: Drawer, Modal, ActionMenu, Notice, SectionHeader.
// Drawer/Modal render into document.body (portal) so an ancestor transform
// (e.g. the page fade-in) never becomes their fixed-position container.
// Presentation only — callers keep their own state, handlers and payloads.

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Escape closes, focus moves into the panel on open and returns on close,
// Tab is kept inside the panel.
function useDialogBehavior(open, onClose, panelRef, { closeDisabled = false } = {}) {
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector("[data-autofocus]") || panel?.querySelector("[data-dialog-body]")?.querySelector(FOCUSABLE) || panel?.querySelector(FOCUSABLE);
    first?.focus({ preventScroll: true });
    function onKey(e) {
      if (e.key === "Escape" && !closeDisabled) {
        e.stopPropagation();
        onClose?.();
      } else if (e.key === "Tab" && panel) {
        const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closeDisabled]);
}

// Side drawer at the inline END (right in LTR, left in RTL). Full width on
// phones, `width` (max) above.
export function Drawer({ open, onClose, title, subtitle, eyebrow, children, footer, closeLabel, width = "max-w-xl", closeDisabled = false, as: Panel = "div", panelProps = {} }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useDialogBehavior(open, onClose, panelRef, { closeDisabled });
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px]" onClick={() => !closeDisabled && onClose?.()} aria-hidden="true" />
      <Panel
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx("relative flex h-full w-full flex-col bg-white shadow-2xl", width)}
        {...panelProps}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200/80 px-5 py-4">
          <div className="min-w-0">
            {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600 rtl:tracking-normal">{eyebrow}</p>}
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label={closeLabel}
            title={closeLabel}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-40"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-200/80 bg-slate-50/60 px-5 py-3">{footer}</div>}
      </Panel>
    </div>,
    document.body
  );
}

// Centered dialog.
export function Modal({ open, onClose, title, subtitle, eyebrow, children, footer, closeLabel, size = "max-w-lg", closeDisabled = false }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useDialogBehavior(open, onClose, panelRef, { closeDisabled });
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px]" onClick={() => !closeDisabled && onClose?.()} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx("relative flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl", size)}>
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600 rtl:tracking-normal">{eyebrow}</p>}
            <h2 id={titleId} className="truncate text-base font-semibold text-slate-900">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label={closeLabel}
            title={closeLabel}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-40"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div data-dialog-body className="min-h-0 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

// "More actions" menu. items: [{ key, label, onSelect, disabled, title, danger }]
// Keyboard: Enter/Space/ArrowDown opens, arrows move, Escape closes.
// A disabled item stays visible with its reason (title) shown below it.
export function ActionMenu({ label, items, disabled = false, align = "end" }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => wrapRef.current && !wrapRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    const first = wrapRef.current?.querySelector('[role="menuitem"]:not([disabled])');
    first?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onMenuKey(e) {
    const list = [...(wrapRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];
    const i = list.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-40"
      >
        <EllipsisHorizontalIcon className="h-5 w-5" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          onKeyDown={onMenuKey}
          className={cx("absolute top-full z-30 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10", align === "end" ? "end-0" : "start-0")}
        >
          {items.map((item) => (
            <div key={item.key}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                className={cx(
                  "flex w-full items-center rounded-lg px-3 py-2 text-start text-[13px] font-medium transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-45",
                  item.danger ? "text-rose-600 hover:bg-rose-50 focus:bg-rose-50" : "text-slate-700 hover:bg-slate-50 focus:bg-slate-50"
                )}
              >
                {item.label}
              </button>
              {item.disabled && item.title && <p className="px-3 pb-1.5 text-[11px] leading-snug text-slate-400">{item.title}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const NOTICE_TONES = {
  error: "border-rose-100 bg-rose-50 text-rose-700",
  success: "border-emerald-100 bg-emerald-50 text-emerald-700",
  info: "border-indigo-100 bg-indigo-50 text-indigo-700",
  warning: "border-amber-100 bg-amber-50 text-amber-800",
};

export function Notice({ tone = "info", children, className }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-xl border px-4 py-2.5 text-sm font-medium", NOTICE_TONES[tone], className)}>
      {children}
    </div>
  );
}

// Card section header with an icon tile (AI Agent / Leads pattern).
export function SectionHeader({ icon: Icon, tone = "indigo", title, subtitle, action, id }) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600 ring-indigo-100",
    emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
    amber: "bg-amber-50 text-amber-600 ring-amber-100",
    rose: "bg-rose-50 text-rose-600 ring-rose-100",
    sky: "bg-sky-50 text-sky-600 ring-sky-100",
    violet: "bg-violet-50 text-violet-600 ring-violet-100",
  };
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {Icon && (
          <span className={cx("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset", tones[tone])}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
        <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold text-slate-900">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
