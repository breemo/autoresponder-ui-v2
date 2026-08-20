// Pure-Node (zlib only, no new npm deps) PNG generator that rasterizes the
// app's EXISTING brand mark exactly as it already renders in the sidebar
// (SharedDashboardLayout.jsx): an indigo-600 (#4f46e5) rounded square
// containing the white-stroked Heroicons "ChatBubbleLeftRightIcon" outline
// glyph — same path data as node_modules/@heroicons/react/24/outline/
// ChatBubbleLeftRightIcon.js (viewBox 0 0 24 24, stroke-only, strokeWidth
// 1.5, round caps/joins). Implements a minimal SVG path parser (M/m, C/c,
// V/v, L/l, A/a — the exact command set this one path uses, including the
// standard SVG arc-to-bezier conversion) + bezier flattening + a
// supersampled distance-to-polyline stroke renderer, so no image library
// or browser is required.

import zlib from "node:zlib";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PATH_D =
  "M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155";

// ---------------------------------------------------------------------------
// Minimal SVG path tokenizer/parser -> list of subpaths, each a list of
// {x,y} points (already flattened: beziers sampled, arcs converted to
// bezier segments then sampled). Coordinate space stays the path's own
// (24x24 viewBox) units throughout; scaling to pixels happens at render time.
// ---------------------------------------------------------------------------
function tokenize(d) {
  const tokens = [];
  const re = /([MmCcVvLlAaZz])|(-?\d*\.?\d+(?:e-?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) {
    if (m[1]) tokens.push({ type: "cmd", v: m[1] });
    else tokens.push({ type: "num", v: parseFloat(m[2]) });
  }
  return tokens;
}

function parsePath(d) {
  const tokens = tokenize(d);
  let i = 0;
  const nextNum = () => tokens[i++].v;
  let cx = 0,
    cy = 0; // current point
  let sx = 0,
    sy = 0; // subpath start
  const subpaths = [];
  let current = [];

  function moveTo(x, y) {
    if (current.length) subpaths.push(current);
    current = [{ x, y }];
    cx = x;
    cy = y;
    sx = x;
    sy = y;
  }
  function lineTo(x, y) {
    current.push({ x, y });
    cx = x;
    cy = y;
  }
  function cubicTo(x1, y1, x2, y2, x, y) {
    const steps = 24;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const mt = 1 - t;
      const px = mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x;
      const py = mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y;
      current.push({ x: px, y: py });
    }
    cx = x;
    cy = y;
  }
  // Standard SVG arc (endpoint parameterization) -> series of cubic beziers.
  // Reference: SVG 1.1 spec Appendix F.6.
  function arcTo(rx, ry, xAxisRotDeg, largeArc, sweep, x, y) {
    if (rx === 0 || ry === 0) {
      lineTo(x, y);
      return;
    }
    const x0 = cx,
      y0 = cy;
    const phi = (xAxisRotDeg * Math.PI) / 180;
    const cosPhi = Math.cos(phi),
      sinPhi = Math.sin(phi);

    const dx2 = (x0 - x) / 2,
      dy2 = (y0 - y) / 2;
    const x1p = cosPhi * dx2 + sinPhi * dy2;
    const y1p = -sinPhi * dx2 + cosPhi * dy2;

    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      const s = Math.sqrt(lambda);
      rx *= s;
      ry *= s;
    }

    const sign = largeArc !== sweep ? 1 : -1;
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const coef = sign * Math.sqrt(Math.max(0, num / den));
    const cxp = (coef * (rx * y1p)) / ry;
    const cyp = (coef * -(ry * x1p)) / rx;

    const centerX = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
    const centerY = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

    function angle(ux, uy, vx, vy) {
      const dot = ux * vx + uy * vy;
      const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    }

    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

    // Split into <=90deg segments, each approximated as one cubic bezier.
    const segments = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
    const delta = dTheta / segments;
    let theta = theta1;
    for (let s = 0; s < segments; s++) {
      const theta2 = theta + delta;
      const alpha = (4 / 3) * Math.tan((theta2 - theta) / 4);

      const cosT1 = Math.cos(theta),
        sinT1 = Math.sin(theta);
      const cosT2 = Math.cos(theta2),
        sinT2 = Math.sin(theta2);

      const p1x = centerX + rx * cosPhi * cosT1 - ry * sinPhi * sinT1;
      const p1y = centerY + rx * sinPhi * cosT1 + ry * cosPhi * sinT1;
      const p2x = centerX + rx * cosPhi * cosT2 - ry * sinPhi * sinT2;
      const p2y = centerY + rx * sinPhi * cosT2 + ry * cosPhi * sinT2;

      const d1x = -rx * cosPhi * sinT1 - ry * sinPhi * cosT1;
      const d1y = -rx * sinPhi * sinT1 + ry * cosPhi * cosT1;
      const d2x = -rx * cosPhi * sinT2 - ry * sinPhi * cosT2;
      const d2y = -rx * sinPhi * sinT2 + ry * cosPhi * cosT2;

      const c1x = p1x + alpha * d1x,
        c1y = p1y + alpha * d1y;
      const c2x = p2x - alpha * d2x,
        c2y = p2y - alpha * d2y;

      cx = p1x;
      cy = p1y; // cubicTo reads cx/cy as its start point
      cubicTo(c1x, c1y, c2x, c2y, p2x, p2y);
      theta = theta2;
    }
  }

  while (i < tokens.length) {
    const t = tokens[i++];
    if (t.type !== "cmd") throw new Error("expected command at " + i);
    const cmd = t.v;
    switch (cmd) {
      case "M": {
        moveTo(nextNum(), nextNum());
        while (tokens[i] && tokens[i].type === "num") lineTo(nextNum(), nextNum());
        break;
      }
      case "m": {
        moveTo(cx + nextNum(), cy + nextNum());
        while (tokens[i] && tokens[i].type === "num") lineTo(cx + nextNum(), cy + nextNum());
        break;
      }
      case "L":
        while (tokens[i] && tokens[i].type === "num") lineTo(nextNum(), nextNum());
        break;
      case "l":
        while (tokens[i] && tokens[i].type === "num") lineTo(cx + nextNum(), cy + nextNum());
        break;
      case "V":
        while (tokens[i] && tokens[i].type === "num") lineTo(cx, nextNum());
        break;
      case "v":
        while (tokens[i] && tokens[i].type === "num") lineTo(cx, cy + nextNum());
        break;
      case "C":
        while (tokens[i] && tokens[i].type === "num") cubicTo(nextNum(), nextNum(), nextNum(), nextNum(), nextNum(), nextNum());
        break;
      case "c":
        while (tokens[i] && tokens[i].type === "num") {
          const x1 = cx + nextNum(),
            y1 = cy + nextNum();
          const x2 = cx + nextNum(),
            y2 = cy + nextNum();
          const x = cx + nextNum(),
            y = cy + nextNum();
          cubicTo(x1, y1, x2, y2, x, y);
        }
        break;
      case "A":
        while (tokens[i] && tokens[i].type === "num") {
          const rx = nextNum(),
            ry = nextNum(),
            rot = nextNum(),
            laf = nextNum(),
            sf = nextNum(),
            x = nextNum(),
            y = nextNum();
          arcTo(rx, ry, rot, laf !== 0, sf !== 0, x, y);
        }
        break;
      case "a":
        while (tokens[i] && tokens[i].type === "num") {
          const rx = nextNum(),
            ry = nextNum(),
            rot = nextNum(),
            laf = nextNum(),
            sf = nextNum(),
            x = cx + nextNum(),
            y = cy + nextNum();
          arcTo(rx, ry, rot, laf !== 0, sf !== 0, x, y);
        }
        break;
      case "Z":
      case "z":
        lineTo(sx, sy);
        break;
      default:
        throw new Error("unsupported command " + cmd);
    }
  }
  if (current.length) subpaths.push(current);
  return subpaths;
}

const SUBPATHS = parsePath(PATH_D);

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax,
    aby = by - ay;
  const apx = px - ax,
    apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cxp = ax + t * abx,
    cyp = ay + t * aby;
  const dx = px - cxp,
    dy = py - cyp;
  return Math.sqrt(dx * dx + dy * dy);
}

function distToSubpaths(px, py) {
  let min = Infinity;
  for (const sp of SUBPATHS) {
    for (let k = 0; k < sp.length - 1; k++) {
      const d = distToSegment(px, py, sp[k].x, sp[k].y, sp[k + 1].x, sp[k + 1].y);
      if (d < min) min = d;
    }
  }
  return min;
}

// Rounded-rect signed test (true if inside), rect is [0,size]x[0,size].
function insideRoundedRect(px, py, size, radius) {
  const x = Math.min(px, size - px);
  const y = Math.min(py, size - py);
  if (x >= radius && y >= radius) return true; // interior away from corners
  if (x >= radius || y >= radius) return x >= 0 && y >= 0; // edge strip
  const dx = radius - x,
    dy = radius - y;
  return dx * dx + dy * dy <= radius * radius;
}

const BG = [0x4f, 0x46, 0xe5]; // #4f46e5 — indigo-600, the app's --app-primary
const WHITE = [0xff, 0xff, 0xff];

// ---------------------------------------------------------------------------
// Renderer. glyphBox = {x,y,size} placing the 24x24 icon's origin+scale
// within the output canvas (canvasSize x canvasSize), in output pixels.
// strokeWidthPx = rendered stroke width in the SAME output-pixel space as
// glyphBox (i.e. already multiplied by glyphBox.size/24).
// ---------------------------------------------------------------------------
function render({ canvasSize, cornerRadius, fullBleed, glyphBox, strokeWidthPx }) {
  const SS = 4; // 4x4 supersampling
  const buf = Buffer.alloc(canvasSize * canvasSize * 4);
  const halfStroke = strokeWidthPx / 2;

  for (let py = 0; py < canvasSize; py++) {
    for (let px = 0; px < canvasSize; px++) {
      let bgCoverage = 0;
      let glyphCoverage = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;

          const inBg = fullBleed || insideRoundedRect(x, y, canvasSize, cornerRadius);
          if (inBg) bgCoverage++;

          // Map sample into the 24x24 path coordinate space.
          const gx = (x - glyphBox.x) / (glyphBox.size / 24);
          const gy = (y - glyphBox.y) / (glyphBox.size / 24);
          if (gx >= -2 && gx <= 26 && gy >= -2 && gy <= 26) {
            const d = distToSubpaths(gx, gy) * (glyphBox.size / 24);
            if (d <= halfStroke) glyphCoverage++;
          }
        }
      }
      const total = SS * SS;
      const bgA = bgCoverage / total;
      const glyphA = glyphCoverage / total;

      // Composite glyph (white) over background (BG, alpha=bgA) over
      // transparent. Glyph only paints where background is also present
      // (matches the real icon: stroke drawn inside the colored square).
      const effGlyphA = glyphA * bgA;
      const r = WHITE[0] * effGlyphA + BG[0] * (bgA - effGlyphA);
      const g = WHITE[1] * effGlyphA + BG[1] * (bgA - effGlyphA);
      const b = WHITE[2] * effGlyphA + BG[2] * (bgA - effGlyphA);
      const a = bgA;

      const idx = (py * canvasSize + px) * 4;
      buf[idx] = Math.round(r);
      buf[idx + 1] = Math.round(g);
      buf[idx + 2] = Math.round(b);
      buf[idx + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA8, filter type 0 per scanline)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function generate(name, opts) {
  const rgba = render(opts);
  const png = encodePNG(rgba, opts.canvasSize);
  fs.writeFileSync(name, png);
  console.log("wrote", name, opts.canvasSize + "x" + opts.canvasSize);
}

// Defaults to this repo's public/ directory (run as `node
// scripts/generate-pwa-icons.mjs` from the repo root) so it regenerates the
// shipped icons in place; pass a different directory as argv[2] to preview
// elsewhere instead — see the "PWA icons" section of the Stage B report for
// how this was first verified (rendered to a scratch dir and visually
// inspected via Claude's image-reading before ever touching public/).
// fileURLToPath (not a hand-rolled .pathname string) is required here: a
// plain URL pathname stays percent-encoded (e.g. a space in this repo's own
// folder name becomes %20), which fs then treats as a literal, wrong path
// instead of decoding it.
const OUT = process.argv[2] || fileURLToPath(new URL("../public", import.meta.url));
const ICONS_OUT = `${OUT}/icons`;
fs.mkdirSync(ICONS_OUT, { recursive: true });

// "any" purpose: rounded square (matches the sidebar's rounded-2xl mark),
// transparent outside the rounded corners. Glyph proportioned like the
// sidebar mark (icon ~54.5% of the box: h-6 inside h-11 => 24/44).
for (const size of [192, 512]) {
  const glyphSize = size * (24 / 44);
  generate(`${ICONS_OUT}/icon-${size}.png`, {
    canvasSize: size,
    cornerRadius: size * (16 / 44), // rounded-2xl (1rem) scaled from the 44px (h-11) reference box
    fullBleed: false,
    glyphBox: { x: (size - glyphSize) / 2, y: (size - glyphSize) / 2, size: glyphSize },
    strokeWidthPx: (1.5 / 24) * glyphSize,
  });
}

// maskable: full-bleed background (no rounding — the platform applies its
// own mask), glyph confined to the centered 80% "safe zone" per the
// maskable icon spec.
for (const size of [192, 512]) {
  const glyphSize = size * 0.6; // well inside the 80% safe zone
  generate(`${ICONS_OUT}/maskable-icon-${size}.png`, {
    canvasSize: size,
    cornerRadius: 0,
    fullBleed: true,
    glyphBox: { x: (size - glyphSize) / 2, y: (size - glyphSize) / 2, size: glyphSize },
    strokeWidthPx: (1.5 / 24) * glyphSize,
  });
}

// apple-touch-icon: iOS applies its own rounding, so ship a full-bleed
// opaque square like the maskable variant (Apple's own guidance — a
// transparent apple-touch-icon can render with a black background on some
// iOS versions).
{
  const size = 180;
  const glyphSize = size * 0.6;
  generate(`${OUT}/apple-touch-icon.png`, {
    canvasSize: size,
    cornerRadius: 0,
    fullBleed: true,
    glyphBox: { x: (size - glyphSize) / 2, y: (size - glyphSize) / 2, size: glyphSize },
    strokeWidthPx: (1.5 / 24) * glyphSize,
  });
}

// Small favicon fallback (rendered directly at 32x32, not downscaled from
// a larger PNG, so it stays crisp).
{
  const size = 32;
  const glyphSize = size * (24 / 44);
  generate(`${OUT}/favicon-32.png`, {
    canvasSize: size,
    cornerRadius: size * (16 / 44),
    fullBleed: false,
    glyphBox: { x: (size - glyphSize) / 2, y: (size - glyphSize) / 2, size: glyphSize },
    strokeWidthPx: Math.max(1.3, (1.5 / 24) * glyphSize),
  });
}
