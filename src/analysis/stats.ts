/**
 * Phase 3 / H1 rigor — distributional statistics over per-market realized PnL.
 *
 * Everything is deterministic: the bootstrap uses a seeded mulberry32 PRNG, so
 * re-running `analyze` reproduces identical CIs (spec §5 reproducibility).
 *
 * Capital-at-risk: these wallets recycle cash continuously (buy → merge/redeem
 * within minutes), so total buy volume wildly overstates the bankroll. The
 * honest proxy is the PEAK of the cumulative net cash outflow timeline
 * (buys − sells − merges − redeems over time): the most cash that was ever
 * simultaneously deployed. Computed at 1-second granularity from the base
 * tables (index-ordered streaming; no temp sort).
 */
import type { Db } from "../store/schema.ts";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — small, fast, deterministic.
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  lo: number;
  hi: number;
  resamples: number;
}

/** Percentile bootstrap CI for the MEAN of xs (seeded, deterministic). */
export function bootstrapMeanCI(xs: number[], resamples = 10_000, seed = 20260726, alpha = 0.05): BootstrapCI {
  const n = xs.length;
  const rnd = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[(rnd() * n) | 0];
    means[r] = s / n;
  }
  means.sort();
  return {
    lo: means[Math.floor((alpha / 2) * resamples)],
    hi: means[Math.min(resamples - 1, Math.floor((1 - alpha / 2) * resamples))],
    resamples,
  };
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Per-wallet statistics
// ---------------------------------------------------------------------------

export interface WalletStats {
  wallet: string;
  markets: number;
  meanPnl: number;
  meanCI95: BootstrapCI; // per-market mean
  totalPnl: number;
  totalCI95: { lo: number; hi: number }; // meanCI × n
  median: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  pctPositive: number; // fraction of markets with pnl > 0 (ties at 0 excluded)
  pctZero: number;
  maxDrawdown: number; // on the daily-cumulative realized curve (USDC)
  maxDrawdownDay: string | null;
  peakCapital: number; // max simultaneous net cash deployed (USDC)
  peakCapitalDay: string | null;
  returnOnPeakCapital: number | null; // totalPnl / peakCapital
  monthly: Array<{ month: string; markets: number; pnl: number }>;
}

export function perMarketPnls(db: Db, wallet: string): number[] {
  return (
    db
      .prepare(
        `SELECT cashPnl + COALESCE(residValue, 0) v FROM market_pnl
         WHERE wallet = ? AND status = 'resolved'`,
      )
      .all(wallet) as Array<{ v: number }>
  ).map((r) => r.v);
}

function equityCurve(db: Db, wallet: string): { maxDrawdown: number; maxDrawdownDay: string | null } {
  const days = db
    .prepare(
      `SELECT date(resolvedTs, 'unixepoch') day, SUM(cashPnl + COALESCE(residValue, 0)) pnl
       FROM market_pnl WHERE wallet = ? AND status = 'resolved'
       GROUP BY 1 ORDER BY 1`,
    )
    .all(wallet) as Array<{ day: string; pnl: number }>;
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdDay: string | null = null;
  for (const d of days) {
    cum += d.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdDay = d.day;
    }
  }
  return { maxDrawdown: maxDd, maxDrawdownDay: maxDdDay };
}

/**
 * Peak simultaneous cash deployment. Streams per-second net outflow from
 * fills (keyset over the (wallet, ts) index — no sort) and merges the much
 * smaller activity flows in memory.
 */
function peakCapital(db: Db, wallet: string): { peak: number; day: string | null } {
  // Activity inflows (merge+redeem cash) per second — ≤ ~500k rows per wallet.
  const inflow = new Map<number, number>();
  for (const r of db
    .prepare(
      `SELECT ts, SUM(usdcSize) v FROM activity
       WHERE wallet = ? AND type IN ('MERGE', 'REDEEM') GROUP BY ts`,
    )
    .all(wallet) as Array<{ ts: number; v: number }>) {
    inflow.set(r.ts, r.v);
  }
  const inflowTs = [...inflow.keys()].sort((a, b) => a - b);

  const chunk = db.prepare(
    `SELECT ts, SUM(size * price * (CASE side WHEN 'BUY' THEN 1 ELSE -1 END)) v
     FROM fills INDEXED BY idx_fills_wallet_ts
     WHERE wallet = ? AND ts > ?
     GROUP BY ts ORDER BY ts LIMIT 50000`,
  );

  let cum = 0;
  let peak = 0;
  let peakTs = 0;
  let ii = 0; // pointer into inflowTs
  let lastTs = -1;
  for (;;) {
    const rows = chunk.all(wallet, lastTs) as Array<{ ts: number; v: number }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      // apply settlement inflows that happened strictly before this second
      while (ii < inflowTs.length && inflowTs[ii] < r.ts) {
        cum -= inflow.get(inflowTs[ii]) as number;
        ii++;
      }
      cum += r.v;
      if (cum > peak) {
        peak = cum;
        peakTs = r.ts;
      }
    }
    lastTs = rows[rows.length - 1].ts;
  }
  // trailing inflows only reduce deployment — peak already found
  return { peak, day: peakTs ? new Date(peakTs * 1000).toISOString().slice(0, 10) : null };
}

export function walletStats(db: Db, wallet: string, opts: { resamples?: number; seed?: number } = {}): WalletStats {
  const xs = perMarketPnls(db, wallet);
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const total = xs.reduce((a, b) => a + b, 0);
  const meanCI = bootstrapMeanCI(xs, opts.resamples ?? 10_000, opts.seed ?? 20260726);
  const { maxDrawdown, maxDrawdownDay } = equityCurve(db, wallet);
  const cap = peakCapital(db, wallet);
  const monthly = db
    .prepare(
      `SELECT strftime('%Y-%m', resolvedTs, 'unixepoch') month, COUNT(*) markets,
              SUM(cashPnl + COALESCE(residValue, 0)) pnl
       FROM market_pnl WHERE wallet = ? AND status = 'resolved' GROUP BY 1 ORDER BY 1`,
    )
    .all(wallet) as Array<{ month: string; markets: number; pnl: number }>;

  return {
    wallet,
    markets: n,
    meanPnl: total / n,
    meanCI95: meanCI,
    totalPnl: total,
    totalCI95: { lo: meanCI.lo * n, hi: meanCI.hi * n },
    median: quantile(sorted, 0.5),
    p5: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    pctPositive: xs.filter((x) => x > 1e-9).length / n,
    pctZero: xs.filter((x) => Math.abs(x) <= 1e-9).length / n,
    maxDrawdown,
    maxDrawdownDay,
    peakCapital: cap.peak,
    peakCapitalDay: cap.day,
    returnOnPeakCapital: cap.peak > 0 ? total / cap.peak : null,
    monthly,
  };
}
