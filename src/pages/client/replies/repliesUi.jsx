import React, { useState } from "react";
import { cx } from "../../../components/app/primitives.jsx";
import { nextHideAfterSelection } from "./selection.js";

// Presentation helpers shared by Auto Replies and Quick Replies.

// "+ Add Reply" -> "Add Reply" (the icon carries the plus).
export function stripPlus(label) {
  return String(label || "").replace(/^\+\s*/, "");
}

// Long text: two lines by default with a Show more / Show less toggle, so
// the full content stays reachable in the list. dir="auto" keeps Arabic and
// English each aligned to their own start.
export function ExpandableText({ text, t, limit = 140 }) {
  const [open, setOpen] = useState(false);
  const value = String(text || "");
  const long = value.length > limit || value.split("\n").length > 2;
  return (
    <div className="min-w-0">
      <p dir="auto" className={cx("whitespace-pre-wrap break-words text-[13px] leading-6", !open && "line-clamp-2")}>
        {value || "—"}
      </p>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-0.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 focus:outline-none focus-visible:underline">
          {open ? t("replies.showLess") : t("replies.showMore")}
        </button>
      )}
    </div>
  );
}

// Same toggle action the old clickable status badge performed, as a switch.
export function ToggleSwitch({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className="group inline-flex items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-50"
    >
      <span className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition", checked ? "bg-emerald-500" : "bg-slate-300")}>
        <span className={cx("absolute h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "start-[18px]" : "start-0.5")} />
      </span>
      <span className={cx("text-xs font-semibold", checked ? "text-emerald-700" : "text-slate-500")}>{label}</span>
    </button>
  );
}

// Checkbox presentation of the former native <select multiple>; value model in ./selection.js.
export function CheckboxMultiSelect({ id, options, value, onChange, emptyText }) {
  const selected = new Set(value || []);
  if (!options.length) return <p className="rounded-xl border border-dashed border-slate-200 px-3 py-2.5 text-xs text-slate-400">{emptyText}</p>;
  return (
    <div id={id} role="group" className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-1.5">
      {options.map((opt, i) => {
        const checked = selected.has(opt.value);
        return (
          <label
            key={opt.key}
            className={cx("flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition", checked ? "bg-indigo-50 text-indigo-800" : "text-slate-700 hover:bg-slate-50")}
          >
            <input type="checkbox" checked={checked} onChange={() => onChange(nextHideAfterSelection(options, value, i))} className="h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
            <span dir="auto" className="min-w-0 flex-1 truncate font-medium">{opt.label}</span>
            <code dir="ltr" className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{opt.value}</code>
          </label>
        );
      })}
    </div>
  );
}
