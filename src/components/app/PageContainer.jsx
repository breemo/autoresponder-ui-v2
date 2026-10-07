import React from "react";
import { cx } from "./primitives.jsx";

// Page width variants — each page gets the width appropriate to its job
// (see engineering/reports/claude/2026-10-07-client-portal-ui-audit-and-migration-plan.md §12).
export const PAGE_WIDTH_CLASSES = {
  full: "w-full", // operational workspaces (Inbox)
  wide: "mx-auto w-full max-w-[1600px]", // dashboards, tables, card grids
  readablePlus: "mx-auto w-full max-w-[1240px]", // forms + lists (AI Agent)
  readable: "mx-auto w-full max-w-[1080px]", // settings / account forms
};

export default function PageContainer({ width = "wide", className, children }) {
  return <div className={cx(PAGE_WIDTH_CLASSES[width] || PAGE_WIDTH_CLASSES.wide, className)}>{children}</div>;
}
