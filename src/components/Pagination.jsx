import React, { useMemo } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";

// Builds a compact page list like [1,2,3,4,5,'…',12] instead of rendering
// a button per page. Shows every page when there are few (<=7), otherwise
// first, last, and a window around the current page with ellipses.
function buildPageList(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const delta = 2;
  const pages = new Set([1, total, current]);
  for (let i = current - delta; i <= current + delta; i++) {
    if (i > 1 && i < total) pages.add(i);
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const withEllipses = [];
  let prev = null;
  for (const p of sorted) {
    if (prev !== null && p - prev > 1) withEllipses.push(`ellipsis-${p}`);
    withEllipses.push(p);
    prev = p;
  }
  return withEllipses;
}

// Reusable numbered pagination — page numbers are directly clickable, with
// Previous/Next controls and a compact "1 2 3 … 12" pattern for many pages.
// Forces LTR internally so page numbers always read left-to-right
// regardless of the host page's RTL direction.
export default function Pagination({ page, totalPages, onPageChange }) {
  const pages = useMemo(() => buildPageList(page, totalPages), [page, totalPages]);

  if (totalPages <= 1) return null;

  return (
    <nav className="flex flex-wrap items-center justify-center gap-1.5" dir="ltr" aria-label="Pagination">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Previous page"
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </button>

      {pages.map((p) =>
        typeof p === "string" ? (
          <span key={p} className="px-1.5 text-sm font-semibold text-slate-400">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => onPageChange(p)}
            aria-current={p === page ? "page" : undefined}
            className={`inline-flex h-9 min-w-[2.25rem] items-center justify-center rounded-xl px-2 text-sm font-bold transition ${
              p === page
                ? "bg-indigo-600 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {p}
          </button>
        )
      )}

      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Next page"
      >
        <ChevronRightIcon className="h-4 w-4" />
      </button>
    </nav>
  );
}
