/**
 * Phase 4 tests — the chart functions produce well-formed SVG (valid root,
 * finite coordinates, no NaN) on representative inputs. The generator itself is
 * exercised end-to-end by `node src/cli.ts report` against real artifacts; here
 * we guard the pure, dependency-free chart primitives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  equityCurveSvg,
  stackedShareSvg,
  divergingBarsSvg,
  pairCostBoxSvg,
  groupedBarsSvg,
  histogramSvg,
  fmtUsd,
  PALETTE,
} from "../src/report/charts.ts";
import { analyzeControl, histogramBins } from "../src/analysis/control.ts";

/** A chart string must be a single well-formed <svg>…</svg> with no NaN/Infinity. */
function assertValidSvg(svg: string) {
  assert.match(svg, /^<svg[\s>]/, "starts with <svg>");
  assert.match(svg, /<\/svg>\s*$/, "ends with </svg>");
  assert.ok(!/NaN|Infinity|undefined/.test(svg), "no NaN/Infinity/undefined in output");
  // every geometry attr is finite. Require a space before the name so we don't
  // match the `x` inside `viewBox=` or the `width` inside `stroke-width=`.
  for (const m of svg.matchAll(/\s(?:x|y|cx|cy|width|height|x1|y1|x2|y2)="([^"]+)"/g)) {
    const v = Number(m[1]);
    assert.ok(Number.isFinite(v), `attr value finite: ${m[1]}`);
  }
  // roughly balanced tags
  assert.equal((svg.match(/<rect/g) ?? []).length >= 1, true);
}

test("equityCurveSvg renders multiple series", () => {
  const svg = equityCurveSvg(
    [
      { label: "A", color: PALETTE[0], points: [{ x: 0, y: 0 }, { x: 10, y: 500 }, { x: 20, y: 1200 }] },
      { label: "B", color: PALETTE[1], points: [{ x: 5, y: 0 }, { x: 20, y: 800 }] },
    ],
    { title: "Equity", subtitle: "test" },
  );
  assertValidSvg(svg);
  assert.match(svg, /Equity/);
});

test("equityCurveSvg tolerates a single-point and empty series", () => {
  const svg = equityCurveSvg(
    [
      { label: "A", color: PALETTE[0], points: [{ x: 0, y: 100 }] },
      { label: "empty", color: PALETTE[1], points: [] },
    ],
    { title: "Edge" },
  );
  assertValidSvg(svg);
});

test("divergingBarsSvg handles positive and negative values", () => {
  const svg = divergingBarsSvg(
    [
      { label: "paired", value: 1335629, color: "#1baf7a" },
      { label: "directional", value: -447937, color: "#e34948" },
    ],
    { title: "Decomposition" },
  );
  assertValidSvg(svg);
  assert.match(svg, /1\.34M|1\.3M/); // fmtUsd on the big value appears
});

test("stackedShareSvg segments sum to full width", () => {
  const svg = stackedShareSvg(
    [{ label: "w1", segments: [{ frac: 0.88, color: PALETTE[0], label: "maker 88%" }, { frac: 0.12, color: "#888", label: "taker 12%" }] }],
    { title: "Roles" },
  );
  assertValidSvg(svg);
});

test("pairCostBoxSvg draws boxes with a reference line", () => {
  const svg = pairCostBoxSvg(
    [{ label: "w1", color: PALETTE[0], p5: 0.88, p25: 0.94, p50: 0.98, p75: 1.01, p95: 1.1, note: "65% < $1" }],
    { title: "Pair cost", refLine: 1 },
  );
  assertValidSvg(svg);
  assert.match(svg, /break-even/);
});

test("groupedBarsSvg renders grouped bars with a legend", () => {
  const svg = groupedBarsSvg(
    [{ label: "w1", bars: [{ value: 888000, color: PALETTE[0], label: "$888k" }, { value: 771000, color: PALETTE[1], label: "$771k" }] }],
    { title: "Recon", legend: ["ours", "theirs"] },
  );
  assertValidSvg(svg);
});

test("histogramSvg renders bins, a zero rule and subject markers", () => {
  const bins = [
    { x0: -20000, x1: -10000, count: 8 },
    { x0: -10000, x1: 0, count: 20 },
    { x0: 0, x1: 10000, count: 15 },
    { x0: 10000, x1: 20000, count: 4 },
  ];
  const svg = histogramSvg(
    bins,
    [
      { value: 18000, label: "b27 (99%)", color: PALETTE[0] },
      { value: 5000, label: "ns (80%)", color: PALETTE[1] },
    ],
    { title: "Control", subtitle: "test", xLabel: "profit" },
  );
  assertValidSvg(svg);
  assert.match(svg, /break-even/);
});

test("analyzeControl computes percentiles and % profitable", () => {
  const metrics = [
    { wallet: "0xa", appearances: 5, profit: -500, volume: 1000 },
    { wallet: "0xb", appearances: 5, profit: -100, volume: 2000 },
    { wallet: "0xc", appearances: 5, profit: 50, volume: 3000 },
    { wallet: "0xd", appearances: 5, profit: 200, volume: 4000 },
    { wallet: "0xe", appearances: 5, profit: null, volume: null }, // unknown /profit
  ];
  const stats = analyzeControl(metrics, [{ label: "subj", wallet: "0xsubj", profit: 100000 }]);
  assert.equal(stats.n, 4);
  assert.equal(stats.nUnknown, 1);
  assert.equal(stats.pctProfitable, 0.5); // 2 of 4 > 0
  assert.equal(stats.subjects[0].percentile, 1); // subject dwarfs all controls
  assert.equal(stats.subjects[0].rank, 1);
  const bins = histogramBins(metrics, -1000, 1000, 4);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 4); // 4 known profits binned
});

test("fmtUsd formats magnitudes and negatives", () => {
  assert.equal(fmtUsd(1335629), "$1.34M");
  assert.equal(fmtUsd(168056), "$168k");
  assert.equal(fmtUsd(-447937), "−$448k");
  assert.equal(fmtUsd(529), "$529");
});
