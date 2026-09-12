import test from "node:test";
import assert from "node:assert/strict";
import { linkifySegments } from "../linkify.js";

// Inbox clickable links — pure tokenizer. Every segment's `value`/`text`
// concatenated back together must reconstruct the original string exactly
// (surrounding text is never altered), and only `href` may differ from the
// displayed text (bare "www." links only).
function reconstruct(segments) {
  return segments.map((s) => (s.type === "link" ? s.text : s.value)).join("");
}

test("plain text with no URL is returned unchanged as a single text segment", () => {
  const input = "شكراً لتواصلك معنا، رح نرجعلك بأقرب وقت";
  const segments = linkifySegments(input);
  assert.deepEqual(segments, [{ type: "text", value: input }]);
});

test("Arabic text + https URL", () => {
  const input = "شوف التفاصيل هون:\nhttps://example.com/menu";
  const segments = linkifySegments(input);
  assert.equal(reconstruct(segments), input);
  const link = segments.find((s) => s.type === "link");
  assert.equal(link.text, "https://example.com/menu");
  assert.equal(link.href, "https://example.com/menu");
  assert.equal(segments[0].value, "شوف التفاصيل هون:\n");
});

test("English text + URL", () => {
  const input = "Check this out: https://example.com/menu";
  const segments = linkifySegments(input);
  assert.equal(reconstruct(segments), input);
  assert.deepEqual(segments, [
    { type: "text", value: "Check this out: " },
    { type: "link", text: "https://example.com/menu", href: "https://example.com/menu" },
  ]);
});

test("multiple URLs in one message", () => {
  const input = "See https://a.example.com and also http://b.example.com/page for details";
  const segments = linkifySegments(input);
  assert.equal(reconstruct(segments), input);
  const links = segments.filter((s) => s.type === "link");
  assert.equal(links.length, 2);
  assert.equal(links[0].text, "https://a.example.com");
  assert.equal(links[1].text, "http://b.example.com/page");
});

test("www.example.com is linked, displayed text unchanged, href gets https://", () => {
  const input = "Visit www.example.com for the menu";
  const segments = linkifySegments(input);
  assert.equal(reconstruct(segments), input); // displayed text is untouched
  const link = segments.find((s) => s.type === "link");
  assert.equal(link.text, "www.example.com");
  assert.equal(link.href, "https://www.example.com");
});

test("URL followed by punctuation excludes the trailing punctuation from the link", () => {
  const cases = [
    ["Check https://example.com.", "https://example.com", "."],
    ["Check https://example.com!", "https://example.com", "!"],
    ["Is it https://example.com?", "https://example.com", "?"],
    ["See (https://example.com)", "https://example.com", ")"],
    ["List: https://example.com]", "https://example.com", "]"],
    ["يلا https://example.com،", "https://example.com", "،"],
  ];
  for (const [input, expectedUrl, expectedTrailing] of cases) {
    const segments = linkifySegments(input);
    assert.equal(reconstruct(segments), input, `reconstructs: ${input}`);
    const link = segments.find((s) => s.type === "link");
    assert.equal(link.text, expectedUrl, `link text for: ${input}`);
    assert.equal(link.href, expectedUrl, `href for: ${input}`);
    assert.ok(segments[segments.length - 1].value.startsWith(expectedTrailing), `trailing punctuation kept as text for: ${input}`);
  }
});

test("a URL with a legitimately balanced parenthesis in its path is not truncated", () => {
  const input = "See https://en.wikipedia.org/wiki/Foo_(bar).";
  const segments = linkifySegments(input);
  assert.equal(reconstruct(segments), input);
  const link = segments.find((s) => s.type === "link");
  assert.equal(link.text, "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.equal(segments[segments.length - 1].value, ".");
});

test("emoji + URL — emoji are preserved exactly around the link", () => {
  const input = "🔥 عرض اليوم: https://example.com/offer 🎉";
  const segments = linkifySegments(input);
  assert.equal(reconstruct(segments), input);
  assert.equal(segments[0].value, "🔥 عرض اليوم: ");
  const link = segments.find((s) => s.type === "link");
  assert.equal(link.text, "https://example.com/offer");
  assert.equal(segments[segments.length - 1].value, " 🎉");
});

test("existing line breaks are preserved in the surrounding text segments", () => {
  const input = "السطر الأول\nhttps://example.com\nالسطر الأخير";
  const segments = linkifySegments(input);
  assert.equal(reconstruct(segments), input);
  assert.equal(segments[0].value, "السطر الأول\n");
  assert.equal(segments[segments.length - 1].value, "\nالسطر الأخير");
});

test("empty / non-string input degrades safely", () => {
  assert.deepEqual(linkifySegments(""), [{ type: "text", value: "" }]);
  assert.deepEqual(linkifySegments(undefined), [{ type: "text", value: "" }]);
  assert.deepEqual(linkifySegments(null), [{ type: "text", value: "" }]);
});
