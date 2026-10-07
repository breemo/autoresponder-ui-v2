import React from "react";
import { cx } from "./primitives.jsx";

// One Client workspace canvas. Every standard page shares the same width,
// gutters and start edge; readable limits are applied INSIDE sections where
// needed (e.g. a form grid), never by narrowing the whole page.
export const PAGE_WIDTH_CLASSES = {
  full: "w-full", // operational workspaces (Inbox)
  standard: "mx-auto w-full max-w-[1680px]", // every other Client page
};

export default function PageContainer({ width = "standard", className, children }) {
  return <div className={cx(PAGE_WIDTH_CLASSES[width] || PAGE_WIDTH_CLASSES.standard, className)}>{children}</div>;
}
