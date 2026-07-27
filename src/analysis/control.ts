/**
 * Phase 5 analysis — the control-group PnL distribution and, the key result,
 * where the four audited subjects rank within it. Pure/offline over the fetched
 * metrics; the subjects' PnL is their own Polymarket all-time /profit (from
 * output/phase2/leaderboard-oracle.json), the identical metric — so the
 * percentile is a fair, like-for-like measure of the article's selection bias.
 */
import type { WalletMetric } from "../ingest/fetch-control.ts";

export interface Subject {
  label: string;
  wallet: string;
  profit: number;
}

export interface ControlStats {
  n: number; // wallets with a profit number
  nUnknown: number; // wallets whose /profit was null
  pctProfitable: number;
  median: number;
  mean: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  min: number;
  max: number;
  totalPnl: number; // Σ profit (net across the pool — is the *population* profitable?)
  medianVolume: number | null;
  subjects: Array<Subject & { percentile: number; rank: number }>; // rank 1 = most profitable overall (control ∪ subjects)
}

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
};

export function analyzeControl(metrics: WalletMetric[], subjects: Subject[]): ControlStats {
  const known = metrics.filter((m) => m.profit !== null) as Array<WalletMetric & { profit: number }>;
  const profits = known.map((m) => m.profit).sort((a, b) => a - b);
  const vols = known.map((m) => m.volume).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const n = profits.length;
  const total = profits.reduce((a, b) => a + b, 0);

  // percentile of each subject vs the CONTROL distribution (fraction of controls below it)
  const subj = subjects.map((s) => {
    const below = profits.filter((p) => p < s.profit).length;
    const percentile = n > 0 ? below / n : NaN;
    // overall rank within control ∪ this subject (1 = best)
    const rank = 1 + profits.filter((p) => p > s.profit).length;
    return { ...s, percentile, rank };
  });

  return {
    n,
    nUnknown: metrics.length - n,
    pctProfitable: n > 0 ? profits.filter((p) => p > 0).length / n : NaN,
    median: quantile(profits, 0.5),
    mean: n > 0 ? total / n : NaN,
    p5: quantile(profits, 0.05),
    p25: quantile(profits, 0.25),
    p75: quantile(profits, 0.75),
    p95: quantile(profits, 0.95),
    min: profits[0] ?? NaN,
    max: profits[profits.length - 1] ?? NaN,
    totalPnl: total,
    medianVolume: vols.length ? quantile(vols, 0.5) : null,
    subjects: subj,
  };
}

/** Fixed-width histogram bins over the profit values, clipped to [lo, hi] so a
 *  handful of extreme outliers don't flatten the bulk (clipping is disclosed). */
export function histogramBins(
  metrics: WalletMetric[],
  lo: number,
  hi: number,
  nBins = 28,
): Array<{ x0: number; x1: number; count: number }> {
  const profits = metrics.map((m) => m.profit).filter((p): p is number => p !== null);
  const width = (hi - lo) / nBins;
  const bins = Array.from({ length: nBins }, (_, i) => ({ x0: lo + i * width, x1: lo + (i + 1) * width, count: 0 }));
  for (const p of profits) {
    const clamped = Math.max(lo, Math.min(hi - 1e-9, p));
    const idx = Math.min(nBins - 1, Math.max(0, Math.floor((clamped - lo) / width)));
    bins[idx].count++;
  }
  return bins;
}

const sgnLog = (v: number, lt: number): number => Math.sign(v) * Math.log10(1 + Math.abs(v) / lt);
const sgnExp = (y: number, lt: number): number => Math.sign(y) * lt * (10 ** Math.abs(y) - 1);

/**
 * Histogram bins uniform in SIGNED-LOG space (so they render as equal-width
 * bars on a symlog axis) — the honest way to show a distribution whose mass is
 * near zero but whose tail runs to 100×. Bin edges are returned in dollars.
 */
export function histogramBinsSigned(
  metrics: WalletMetric[],
  nBins = 34,
  linthresh = 100,
): Array<{ x0: number; x1: number; count: number }> {
  const profits = metrics.map((m) => m.profit).filter((p): p is number => p !== null);
  if (profits.length === 0) return [];
  const yLo = sgnLog(Math.min(...profits), linthresh);
  const yHi = sgnLog(Math.max(...profits), linthresh);
  const step = (yHi - yLo) / nBins || 1;
  const bins = Array.from({ length: nBins }, (_, i) => ({
    x0: sgnExp(yLo + i * step, linthresh),
    x1: sgnExp(yLo + (i + 1) * step, linthresh),
    count: 0,
  }));
  for (const p of profits) {
    const idx = Math.min(nBins - 1, Math.max(0, Math.floor((sgnLog(p, linthresh) - yLo) / step)));
    bins[idx].count++;
  }
  return bins;
}
