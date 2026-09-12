// Inbox clickable links — pure, framework-free URL tokenizer.
//
// Splits a message's plain text into an ordered list of segments so the
// caller can render each one, turning only the URL segments into <a>
// elements. Deliberately has no React/DOM dependency so it can be unit
// tested directly under Node and reused by any renderer.
//
// Does NOT touch the stored message content — this only decides how one
// already-loaded string is rendered.

const URL_TOKEN_RE = /((?:https?:\/\/|www\.)[^\s]+)/gi;

// Trailing punctuation that is almost always "end of sentence", not part
// of the URL: . , ! ? : ; " ' and Arabic ، ؛ ؟. `)` and `]` are only
// stripped when they are NOT balancing an opening `(`/`[` earlier in the
// same token, so a URL that legitimately ends in a parenthesised path
// segment (e.g. .../Foo_(bar)) is left intact.
const TRAILING_CHARS = new Set([".", ",", "!", "?", ":", ";", '"', "'", "،", "؛", "؟"]);

function countChar(str, ch) {
  let count = 0;
  for (const c of str) if (c === ch) count += 1;
  return count;
}

function trimTrailingPunctuation(raw) {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (TRAILING_CHARS.has(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      const body = raw.slice(0, end - 1);
      if (countChar(body, open) > countChar(body, ch)) break; // balances an earlier opener — keep it
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

// linkifySegments(text) -> Array<{ type: "text", value } | { type: "link", text, href }>
// - `text` on a link segment is EXACTLY the substring to display (never
//   rewritten) — only `href` differs, and only for a bare "www." URL,
//   which gets an "https://" prefix so the browser can navigate it.
// - Plain text with no URL returns a single text segment equal to the
//   input, so existing rendering is unaffected.
export function linkifySegments(text) {
  if (typeof text !== "string" || text === "") return [{ type: "text", value: text || "" }];

  const segments = [];
  let lastIndex = 0;
  URL_TOKEN_RE.lastIndex = 0;
  let match;

  while ((match = URL_TOKEN_RE.exec(text))) {
    const rawUrl = match[0];
    const start = match.index;
    const urlText = trimTrailingPunctuation(rawUrl);
    if (!urlText) continue; // nothing left after trimming — not a real URL

    if (start > lastIndex) segments.push({ type: "text", value: text.slice(lastIndex, start) });

    const href = /^www\./i.test(urlText) ? `https://${urlText}` : urlText;
    segments.push({ type: "link", text: urlText, href });

    lastIndex = start + urlText.length;
  }

  if (lastIndex < text.length) segments.push({ type: "text", value: text.slice(lastIndex) });

  return segments.length ? segments : [{ type: "text", value: text }];
}
