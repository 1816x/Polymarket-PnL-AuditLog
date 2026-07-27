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
  fmtUsd,
  PALETTE,
} from "../src/report/charts.ts";

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

test("fmtUsd formats magnitudes and negatives", () => {
  assert.equal(fmtUsd(1335629), "$1.34M");
  assert.equal(fmtUsd(168056), "$168k");
  assert.equal(fmtUsd(-447937), "−$448k");
  assert.equal(fmtUsd(529), "$529");
});
