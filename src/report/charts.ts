/**
 * Hand-rolled, dependency-free SVG charts for the final report (spec §4: no
 * chart library). Every function is pure — `(data) => svgString` — so the
 * output is testable and deterministic.
 *
 * Rendering context: GitHub renders a linked `.svg` as an `<img>` (inline SVG in
 * markdown is sanitized away), so each chart is a STANDALONE file referenced
 * with `![](charts/x.svg)`. Because the host page may be light OR dark, every
 * chart paints its own light surface panel and dark ink — self-contained and
 * legible on either theme.
 *
 * Palette: the dataviz reference categorical hues (slots 1–4), validated
 * colorblind-safe (CVD ΔE ≥ 9, normal-vision ΔE ≥ 22) via the skill's script.
 * The low-contrast fills (aqua/yellow) always carry a direct value label, which
 * is the required "relief" — so identity never rests on color alone.
 */

export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]; // blue, orange, aqua, yellow
export const INK = "#0b0b0b";
export const INK2 = "#52514e";
export const MUTED = "#8a8985";
export const SURFACE = "#fcfcfb";
export const GRID = "#e6e5e2";
export const POS = "#1baf7a"; // gains
export const NEG = "#e34948"; // losses

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

// --- primitives ------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Round to 2dp and strip trailing zeros so coordinates stay compact + NaN-free. */
const n = (v: number): string => {
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 100) / 100);
};

export function fmtUsd(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : ""; // minus sign
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(0)}`;
}

const pct = (v: number): string => `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;

interface Frame {
  w: number;
  h: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

function open(f: Frame, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} ${f.h}" width="${f.w}" height="${f.h}" font-family='${FONT}' role="img" aria-label="${esc(title)}">
<rect x="0" y="0" width="${f.w}" height="${f.h}" rx="8" fill="${SURFACE}"/>`;
}

/** Title on line 1, subtitle on its own line below it (left-aligned) — robust
 *  against long titles, which an inline right-anchored subtitle would collide with. */
function titleEl(f: Frame, title: string, subtitle?: string): string {
  let s = `<text x="${f.padL}" y="24" font-size="15" font-weight="700" fill="${INK}">${esc(title)}</text>`;
  if (subtitle) s += `<text x="${f.padL}" y="41" font-size="11.5" fill="${MUTED}">${esc(subtitle)}</text>`;
  return s;
}

const text = (
  x: number,
  y: number,
  s: string,
  o: { size?: number; fill?: string; anchor?: "start" | "middle" | "end"; weight?: number } = {},
): string =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${o.size ?? 12}" fill="${o.fill ?? INK2}"${
    o.anchor ? ` text-anchor="${o.anchor}"` : ""
  }${o.weight ? ` font-weight="${o.weight}"` : ""}>${esc(s)}</text>`;

// --- 1. equity curve (line) ------------------------------------------------

export interface LineSeries {
  label: string;
  color: string;
  points: Array<{ x: number; y: number }>; // x = day index, y = cumulative $
}

/** Overlaid cumulative-PnL lines on one shared axis (magnitude comparison is part of the story). */
export function equityCurveSvg(series: LineSeries[], opts: { title: string; subtitle?: string }): string {
  const f: Frame = { w: 920, h: 452, padL: 68, padR: 124, padT: 58, padB: 44 };
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(...ys);
  const plotW = f.w - f.padL - f.padR;
  const plotH = f.h - f.padT - f.padB;
  const sx = (x: number) => f.padL + ((x - xMin) / Math.max(1, xMax - xMin)) * plotW;
  const sy = (y: number) => f.padT + plotH - ((y - yMin) / Math.max(1, yMax - yMin)) * plotH;

  let g = open(f, opts.title) + titleEl(f, opts.title, opts.subtitle);

  // y gridlines + labels (5 ticks)
  for (let i = 0; i <= 5; i++) {
    const yv = yMin + ((yMax - yMin) * i) / 5;
    const y = sy(yv);
    g += `<line x1="${f.padL}" y1="${n(y)}" x2="${f.padL + plotW}" y2="${n(y)}" stroke="${GRID}" stroke-width="1"/>`;
    g += text(f.padL - 8, y + 4, fmtUsd(yv), { anchor: "end", size: 11, fill: MUTED });
  }
  // zero baseline emphasised
  const y0 = sy(0);
  g += `<line x1="${f.padL}" y1="${n(y0)}" x2="${f.padL + plotW}" y2="${n(y0)}" stroke="${MUTED}" stroke-width="1.25"/>`;

  // x tick labels (start + end)
  g += text(f.padL, f.h - 14, `day ${xMin}`, { size: 11, fill: MUTED });
  g += text(f.padL + plotW, f.h - 14, `day ${xMax}`, { anchor: "end", size: 11, fill: MUTED });

  // lines + end markers
  const ends: Array<{ y: number; x: number; label: string; color: string }> = [];
  for (const s of series) {
    if (s.points.length === 0) continue;
    const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${n(sx(p.x))} ${n(sy(p.y))}`).join(" ");
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = s.points[s.points.length - 1];
    g += `<circle cx="${n(sx(last.x))}" cy="${n(sy(last.y))}" r="3.5" fill="${s.color}"/>`;
    ends.push({ y: sy(last.y), x: sx(last.x), label: `${s.label} ${fmtUsd(last.y)}`, color: s.color });
  }
  // right-edge direct labels, de-collided (min 14px vertical gap)
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y < ends[i - 1].y + 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) g += text(e.x + 7, e.y + 4, e.label, { size: 11.5, fill: e.color, weight: 700 });
  return g + "</svg>\n";
}

// --- 2. diverging / grouped horizontal bars --------------------------------

export interface BarRow {
  label: string;
  value: number;
  color: string;
  valueLabel?: string;
}

/** Horizontal bars that may be negative (diverging around a zero rule). Direct-labeled. */
export function divergingBarsSvg(rows: BarRow[], opts: { title: string; subtitle?: string; unit?: "usd" }): string {
  const rowH = 40;
  const f: Frame = { w: 920, h: 66 + rows.length * rowH + 30, padL: 176, padR: 130, padT: 58, padB: 20 };
  const plotW = f.w - f.padL - f.padR;
  const vMax = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const zeroX = f.padL + (rows.some((r) => r.value < 0) ? plotW / 2 : 0);
  const fullW = rows.some((r) => r.value < 0) ? plotW / 2 : plotW;
  const bw = (v: number) => (Math.abs(v) / vMax) * fullW;

  let g = open(f, opts.title) + titleEl(f, opts.title, opts.subtitle);
  g += `<line x1="${n(zeroX)}" y1="${f.padT - 8}" x2="${n(zeroX)}" y2="${f.h - f.padB}" stroke="${MUTED}" stroke-width="1.25"/>`;

  rows.forEach((r, i) => {
    const y = f.padT + i * rowH;
    const w = bw(r.value);
    const x = r.value < 0 ? zeroX - w : zeroX;
    g += text(f.padL - 12, y + rowH / 2 + 1, r.label, { anchor: "end", size: 12.5, fill: INK, weight: 600 });
    g += `<rect x="${n(x)}" y="${n(y + 6)}" width="${n(Math.max(1, w))}" height="${rowH - 16}" rx="4" fill="${r.color}"/>`;
    const vl = r.valueLabel ?? fmtUsd(r.value);
    const labelX = r.value < 0 ? x - 8 : x + w + 8;
    g += text(labelX, y + rowH / 2 + 1, vl, {
      anchor: r.value < 0 ? "end" : "start",
      size: 12,
      fill: INK,
      weight: 700,
    });
  });
  return g + "</svg>\n";
}

/** Grouped bars: N groups, each with M labeled sub-bars (e.g. ours vs Polymarket). */
export interface BarGroup {
  label: string;
  bars: Array<{ value: number; color: string; label: string }>;
}
export function groupedBarsSvg(groups: BarGroup[], opts: { title: string; subtitle?: string; legend: string[] }): string {
  const groupW = 170;
  const f: Frame = { w: Math.max(760, 80 + groups.length * groupW), h: 452, padL: 70, padR: 30, padT: 92, padB: 78 };
  const plotW = f.w - f.padL - f.padR;
  const plotH = f.h - f.padT - f.padB;
  const vMax = Math.max(1, ...groups.flatMap((gp) => gp.bars.map((b) => b.value)));
  const sy = (v: number) => f.padT + plotH - (v / vMax) * plotH;

  let g = open(f, opts.title) + titleEl(f, opts.title, opts.subtitle);
  // legend row (below the 2-line title block)
  let lx = f.padL;
  opts.legend.forEach((lab, i) => {
    g += `<rect x="${lx}" y="60" width="11" height="11" rx="2.5" fill="${PALETTE[i]}"/>`;
    g += text(lx + 16, 70, lab, { size: 11.5, fill: INK2 });
    lx += 26 + lab.length * 7.2;
  });
  // baseline
  g += `<line x1="${f.padL}" y1="${n(sy(0))}" x2="${f.padL + plotW}" y2="${n(sy(0))}" stroke="${MUTED}" stroke-width="1.25"/>`;
  for (let i = 1; i <= 4; i++) {
    const yv = (vMax * i) / 4;
    g += `<line x1="${f.padL}" y1="${n(sy(yv))}" x2="${f.padL + plotW}" y2="${n(sy(yv))}" stroke="${GRID}" stroke-width="1"/>`;
    g += text(f.padL - 8, sy(yv) + 4, fmtUsd(yv), { anchor: "end", size: 10.5, fill: MUTED });
  }
  groups.forEach((gp, gi) => {
    const gx = f.padL + (gi + 0.5) * (plotW / groups.length);
    const n2 = gp.bars.length;
    const bw = Math.min(46, (plotW / groups.length) / (n2 + 1));
    gp.bars.forEach((b, bi) => {
      const x = gx - (n2 * bw) / 2 + bi * bw + 1;
      const y = sy(b.value);
      g += `<rect x="${n(x)}" y="${n(y)}" width="${n(bw - 2)}" height="${n(sy(0) - y)}" rx="4" fill="${b.color}"/>`;
      g += text(x + (bw - 2) / 2, y - 6, b.label, { anchor: "middle", size: 10.5, fill: INK, weight: 700 });
    });
    g += text(gx, f.h - f.padB + 20, gp.label, { anchor: "middle", size: 12, fill: INK, weight: 600 });
  });
  return g + "</svg>\n";
}

// --- 3. stacked shares (maker/taker) ---------------------------------------

export interface StackRow {
  label: string;
  segments: Array<{ frac: number; color: string; label: string }>;
}
/** One 0–100% bar per wallet, split into labeled segments (maker vs taker). */
export function stackedShareSvg(rows: StackRow[], opts: { title: string; subtitle?: string }): string {
  const rowH = 46;
  const f: Frame = { w: 900, h: 64 + rows.length * rowH + 24, padL: 120, padR: 30, padT: 58, padB: 16 };
  const plotW = f.w - f.padL - f.padR;
  let g = open(f, opts.title) + titleEl(f, opts.title, opts.subtitle);
  rows.forEach((r, i) => {
    const y = f.padT + i * rowH;
    g += text(f.padL - 12, y + rowH / 2 + 1, r.label, { anchor: "end", size: 12.5, fill: INK, weight: 600 });
    let x = f.padL;
    r.segments.forEach((s) => {
      const w = s.frac * plotW;
      g += `<rect x="${n(x + 1)}" y="${n(y + 6)}" width="${n(Math.max(0, w - 2))}" height="${rowH - 16}" rx="3" fill="${s.color}"/>`;
      if (w > 44)
        g += text(x + w / 2, y + rowH / 2 + 1, s.label, { anchor: "middle", size: 11.5, fill: "#ffffff", weight: 700 });
      x += w;
    });
  });
  // scale ticks
  for (let p = 0; p <= 1; p += 0.25) {
    const x = f.padL + p * plotW;
    g += text(x, f.h - 4, pct(p), { anchor: p === 0 ? "start" : p === 1 ? "end" : "middle", size: 10, fill: MUTED });
  }
  return g + "</svg>\n";
}

// --- 4. pair-cost distribution (box) ---------------------------------------

export interface BoxStat {
  label: string;
  color: string;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  note?: string;
}
/** Horizontal box-and-whisker per wallet with a $1.00 reference (the H3 blind spot). */
export function pairCostBoxSvg(boxes: BoxStat[], opts: { title: string; subtitle?: string; refLine: number }): string {
  const rowH = 52;
  const f: Frame = { w: 900, h: 74 + boxes.length * rowH + 30, padL: 120, padR: 150, padT: 66, padB: 30 };
  const plotW = f.w - f.padL - f.padR;
  const lo = Math.min(opts.refLine, ...boxes.map((b) => b.p5)) * 0.98;
  const hi = Math.max(opts.refLine, ...boxes.map((b) => b.p95)) * 1.02;
  const sx = (v: number) => f.padL + ((v - lo) / Math.max(1e-9, hi - lo)) * plotW;

  let g = open(f, opts.title) + titleEl(f, opts.title, opts.subtitle);
  // $1 reference line
  const rx = sx(opts.refLine);
  g += `<line x1="${n(rx)}" y1="${f.padT - 6}" x2="${n(rx)}" y2="${f.h - f.padB}" stroke="${NEG}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  g += text(rx, f.padT - 10, `$${opts.refLine.toFixed(2)} break-even`, { anchor: "middle", size: 11, fill: NEG, weight: 700 });

  boxes.forEach((b, i) => {
    const y = f.padT + i * rowH + rowH / 2;
    g += text(f.padL - 12, y + 1, b.label, { anchor: "end", size: 12.5, fill: INK, weight: 600 });
    // whiskers p5–p95
    g += `<line x1="${n(sx(b.p5))}" y1="${n(y)}" x2="${n(sx(b.p95))}" y2="${n(y)}" stroke="${b.color}" stroke-width="1.5"/>`;
    for (const p of [b.p5, b.p95]) g += `<line x1="${n(sx(p))}" y1="${n(y - 6)}" x2="${n(sx(p))}" y2="${n(y + 6)}" stroke="${b.color}" stroke-width="1.5"/>`;
    // box p25–p75
    g += `<rect x="${n(sx(b.p25))}" y="${n(y - 11)}" width="${n(sx(b.p75) - sx(b.p25))}" height="22" rx="3" fill="${b.color}" fill-opacity="0.32" stroke="${b.color}" stroke-width="1.5"/>`;
    // median
    g += `<line x1="${n(sx(b.p50))}" y1="${n(y - 11)}" x2="${n(sx(b.p50))}" y2="${n(y + 11)}" stroke="${b.color}" stroke-width="2.5"/>`;
    if (b.note) g += text(sx(b.p95) + 10, y + 1, b.note, { size: 11, fill: INK2, weight: 600 });
  });
  // x ticks
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    g += text(sx(v), f.h - 10, `$${v.toFixed(2)}`, { anchor: "middle", size: 10, fill: MUTED });
  }
  return g + "</svg>\n";
}

// --- 5. histogram with marker lines (control-group PnL distribution) --------

export interface HistBin {
  x0: number;
  x1: number;
  count: number;
}
export interface Marker {
  value: number;
  label: string;
  color: string;
}
/**
 * Vertical histogram over signed values, with a zero rule and labeled marker
 * lines (the 4 subjects placed in the control distribution). Bars left of zero
 * are losses (red-ish), right are gains (green-ish).
 */
/** Signed-log transform for heavy-tailed signed data: linear within ±linthresh,
 *  logarithmic beyond. The right tool when a distribution's mass sits near zero
 *  but its tail runs to 100×+ (control profits: median ~$100, tail ~$771k). */
export const signedLog = (v: number, lt = 100): number =>
  Math.sign(v) * Math.log10(1 + Math.abs(v) / lt);

export function histogramSvg(
  bins: HistBin[],
  markers: Marker[],
  opts: { title: string; subtitle?: string; xLabel?: string; scale?: (v: number) => number; ticks?: number[] },
): string {
  const f: Frame = { w: 940, h: 470, padL: 56, padR: 24, padT: 92, padB: 64 };
  const plotW = f.w - f.padL - f.padR;
  const plotH = f.h - f.padT - f.padB;
  const tf = opts.scale ?? ((v: number) => v); // value -> axis units
  const tLo = Math.min(...bins.map((b) => tf(b.x0)), ...markers.map((m) => tf(m.value)));
  const tHi = Math.max(...bins.map((b) => tf(b.x1)), ...markers.map((m) => tf(m.value)));
  const cMax = Math.max(1, ...bins.map((b) => b.count));
  const sx = (v: number) => f.padL + ((tf(v) - tLo) / Math.max(1e-9, tHi - tLo)) * plotW;
  const sy = (c: number) => f.padT + plotH - (c / cMax) * plotH;

  let g = open(f, opts.title) + titleEl(f, opts.title, opts.subtitle);

  // y gridlines
  for (let i = 0; i <= 4; i++) {
    const cv = (cMax * i) / 4;
    g += `<line x1="${f.padL}" y1="${n(sy(cv))}" x2="${f.padL + plotW}" y2="${n(sy(cv))}" stroke="${GRID}" stroke-width="1"/>`;
    g += text(f.padL - 7, sy(cv) + 4, String(Math.round(cv)), { anchor: "end", size: 10, fill: MUTED });
  }
  // bars
  for (const b of bins) {
    const x = sx(b.x0);
    const w = Math.max(1, sx(b.x1) - sx(b.x0) - 1.5);
    const y = sy(b.count);
    const mid = (b.x0 + b.x1) / 2;
    g += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(sy(0) - y)}" rx="1.5" fill="${mid < 0 ? NEG : POS}" fill-opacity="0.55"/>`;
  }
  // zero rule
  if (tLo < 0 && tHi > 0) {
    const z = sx(0);
    g += `<line x1="${n(z)}" y1="${f.padT}" x2="${n(z)}" y2="${n(sy(0))}" stroke="${MUTED}" stroke-width="1.25"/>`;
    g += text(z, f.padT - 6, "break-even", { anchor: "middle", size: 10, fill: MUTED });
  }
  // x axis baseline + ticks (explicit if provided — needed for a nonlinear scale)
  g += `<line x1="${f.padL}" y1="${n(sy(0))}" x2="${f.padL + plotW}" y2="${n(sy(0))}" stroke="${INK2}" stroke-width="1"/>`;
  const ticks = opts.ticks ?? Array.from({ length: 5 }, (_, k) => tLo + ((tHi - tLo) * k) / 4);
  for (const v of ticks) {
    const x = sx(v);
    if (x < f.padL - 1 || x > f.padL + plotW + 1) continue;
    g += `<line x1="${n(x)}" y1="${n(sy(0))}" x2="${n(x)}" y2="${n(sy(0) + 4)}" stroke="${MUTED}" stroke-width="1"/>`;
    g += text(x, f.h - f.padB + 18, fmtUsd(v), { anchor: "middle", size: 10, fill: MUTED });
  }
  if (opts.xLabel) g += text(f.padL + plotW / 2, f.h - 8, opts.xLabel, { anchor: "middle", size: 11, fill: INK2 });

  // marker lines on the plot; identities in a stacked key (top-right) so
  // clustered markers (all 4 subjects sit close on a log axis) never collide.
  const ms = markers.map((m) => ({ ...m, x: sx(m.value) }));
  for (const m of ms) {
    g += `<line x1="${n(m.x)}" y1="${f.padT - 2}" x2="${n(m.x)}" y2="${n(sy(0))}" stroke="${m.color}" stroke-width="2"/>`;
    g += `<circle cx="${n(m.x)}" cy="${n(f.padT - 2)}" r="3" fill="${m.color}"/>`;
  }
  const keyRight = f.padL + plotW;
  [...markers].sort((a, b) => b.value - a.value).forEach((m, i) => {
    const ky = f.padT + 12 + i * 15;
    g += `<rect x="${n(keyRight - 132)}" y="${n(ky - 8)}" width="9" height="9" rx="2" fill="${m.color}"/>`;
    g += text(keyRight - 119, ky, m.label, { size: 10.5, fill: m.color, weight: 700 });
  });
  return g + "</svg>\n";
}
