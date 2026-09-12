import React, { useMemo } from "react";
import { linkifySegments } from "../lib/linkify.js";

// Renders one message's already-loaded text, turning any http(s)/www URL
// into a clickable <a> — everything else passes through unchanged as plain
// text. No dangerouslySetInnerHTML: segments become React
// elements/fragments, so surrounding text (Arabic/RTL, emoji, line breaks)
// renders exactly as before. The caller keeps its own
// whitespace-pre-wrap container for line breaks; this component only
// decides which spans become links.
export default function LinkifiedText({ text }) {
  const segments = useMemo(() => linkifySegments(text), [text]);

  if (!text) return null;

  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "link" ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all underline underline-offset-2"
          >
            {seg.text}
          </a>
        ) : (
          <React.Fragment key={i}>{seg.value}</React.Fragment>
        )
      )}
    </>
  );
}
