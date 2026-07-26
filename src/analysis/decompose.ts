/**
 * Phase 3 / H3 — paired vs directional decomposition, per (wallet × market).
 *
 * Method (documented approximation — average-cost pairing): with only BUY
 * fills (sells are 131 of 19.9M and are folded into the directional leg),
 *   avgPx_i  = buyCost_i / buyQty_i
 *   pairCost = avgPx0 + avgPx1            (cost to assemble one Up+Down set)
 *   pairedQty = min(buyQty0, buyQty1)
 *   pairedPnl = pairedQty × (1 − pairCost)   — a completed set is worth exactly
 *                                              $1 at settlement OR via MERGE
 *   directionalPnl = (cashPnl + residValue) − pairedPnl   (exact remainder)
 *
 * The identity `pairedPnl + directionalPnl == cashPnl + residValue` holds by
 * construction per market, so the decomposition never invents or loses PnL —
 * it only attributes it. FIFO-style pairing would attribute slightly
 * differently within a market; with 5-minute lifetimes and near-simultaneous
 * two-sided quoting, average-cost is the honest simple choice (spec §8: the
 * method is disclosed, not hidden).
 *
 * H3 (the article's survivorship bias): the article's "avg combined cost < $1"
 * looked only at completed pairs. We report (a) the pairedQty-weighted
 * DISTRIBUTION of pairCost, and (b) the single-leg-only markets the article's
 * metric excludes, with their PnL — the gap is the bias, measured.
 */
import type { Db } from "../store/schema.ts";

export interface MarketDecomposition {
  wallet: string;
  conditionId: string;
  pairedQty: number;
  pairCost: number | null; // null when no pairs (single-leg market)
  pairedPnl: number;
  directionalPnl: number;
  totalPnl: number; // cashPnl + residValue
  singleLeg: boolean; // bought only one side
  series: string | null; // e.g. "btc-5m", from the market slug
}

export interface WalletDecomposition {
  wallet: string;
  markets: number;
  bothSidesMkts: number;
  singleLegMkts: number;
  pairedPnl: number;
  directionalPnl: number;
  totalPnl: number;
  singleLegPnl: number; // PnL of markets the article's pair metric never sees
  identityError: number; // Σ(paired+directional) − Σ total (must be ~0)
  /** pairedQty-weighted pair-cost distribution over both-sides markets. */
  pairCost: {
    weightedMean: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    sharePairsUnder1: number; // fraction of paired sets assembled below $1.00
    pairsTotal: number; // Σ pairedQty (sets)
  } | null;
  bySeries: Array<{ series: string; markets: number; totalPnl: number; pairedPnl: number; directionalPnl: number }>;
}

/** "btc-updown-5m-1774900800" → "btc-5m"; null when the slug has another shape. */
export function seriesOfSlug(slug: string | null): string | null {
  if (!slug) return null;
  const m = slug.match(/^([a-z0-9]+)-updown-([a-z0-9]+)-\d+$/);
  if (m) return `${m[1]}-${m[2]}`;
  // Long-form slugs like "bitcoin-up-or-down-july-24-2pm-et" — asset only.
  const lead = slug.match(/^(bitcoin|ethereum|solana|xrp|bnb)-up-or-down/);
  if (lead) return `${lead[1]}-daily`;
  return null;
}

export function decomposeMarkets(db: Db, wallet: string): MarketDecomposition[] {
  const rows = db
    .prepare(
      `SELECT p.wallet, p.conditionId, p.buyQty0, p.buyQty1, p.buyCost0, p.buyCost1,
              p.cashPnl, COALESCE(p.residValue, 0) residValue, m.slug
       FROM market_pnl p LEFT JOIN markets m ON m.conditionId = p.conditionId
       WHERE p.wallet = ? AND p.status = 'resolved'`,
    )
    .all(wallet) as Array<{
    wallet: string;
    conditionId: string;
    buyQty0: number;
    buyQty1: number;
    buyCost0: number;
    buyCost1: number;
    cashPnl: number;
    residValue: number;
    slug: string | null;
  }>;

  return rows.map((r) => {
    const totalPnl = r.cashPnl + r.residValue;
    const pairedQty = Math.min(r.buyQty0, r.buyQty1);
    const singleLeg = r.buyQty0 <= 1e-9 || r.buyQty1 <= 1e-9;
    let pairCost: number | null = null;
    let pairedPnl = 0;
    if (!singleLeg && pairedQty > 1e-9) {
      pairCost = r.buyCost0 / r.buyQty0 + r.buyCost1 / r.buyQty1;
      pairedPnl = pairedQty * (1 - pairCost);
    }
    return {
      wallet: r.wallet,
      conditionId: r.conditionId,
      pairedQty: singleLeg ? 0 : pairedQty,
      pairCost,
      pairedPnl,
      directionalPnl: totalPnl - pairedPnl,
      totalPnl,
      singleLeg,
      series: seriesOfSlug(r.slug),
    };
  });
}

function weightedQuantile(sorted: Array<{ v: number; w: number }>, q: number, totalW: number): number {
  let acc = 0;
  for (const { v, w } of sorted) {
    acc += w;
    if (acc >= q * totalW) return v;
  }
  return sorted.length ? sorted[sorted.length - 1].v : NaN;
}

export function decomposeWallet(db: Db, wallet: string): WalletDecomposition {
  const ms = decomposeMarkets(db, wallet);
  const both = ms.filter((m) => !m.singleLeg);
  const single = ms.filter((m) => m.singleLeg);

  const pairedPnl = ms.reduce((a, m) => a + m.pairedPnl, 0);
  const directionalPnl = ms.reduce((a, m) => a + m.directionalPnl, 0);
  const totalPnl = ms.reduce((a, m) => a + m.totalPnl, 0);

  let pairCost: WalletDecomposition["pairCost"] = null;
  const weighted = both
    .filter((m) => m.pairCost !== null && m.pairedQty > 0)
    .map((m) => ({ v: m.pairCost as number, w: m.pairedQty }))
    .sort((a, b) => a.v - b.v);
  const totalW = weighted.reduce((a, x) => a + x.w, 0);
  if (totalW > 0) {
    pairCost = {
      weightedMean: weighted.reduce((a, x) => a + x.v * x.w, 0) / totalW,
      p5: weightedQuantile(weighted, 0.05, totalW),
      p25: weightedQuantile(weighted, 0.25, totalW),
      p50: weightedQuantile(weighted, 0.5, totalW),
      p75: weightedQuantile(weighted, 0.75, totalW),
      p95: weightedQuantile(weighted, 0.95, totalW),
      sharePairsUnder1: weighted.filter((x) => x.v < 1).reduce((a, x) => a + x.w, 0) / totalW,
      pairsTotal: totalW,
    };
  }

  const bySeriesMap = new Map<string, { markets: number; totalPnl: number; pairedPnl: number; directionalPnl: number }>();
  for (const m of ms) {
    const key = m.series ?? "other";
    const s = bySeriesMap.get(key) ?? { markets: 0, totalPnl: 0, pairedPnl: 0, directionalPnl: 0 };
    s.markets++;
    s.totalPnl += m.totalPnl;
    s.pairedPnl += m.pairedPnl;
    s.directionalPnl += m.directionalPnl;
    bySeriesMap.set(key, s);
  }
  const bySeries = [...bySeriesMap]
    .map(([series, s]) => ({ series, ...s }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  return {
    wallet,
    markets: ms.length,
    bothSidesMkts: both.length,
    singleLegMkts: single.length,
    pairedPnl,
    directionalPnl,
    totalPnl,
    singleLegPnl: single.reduce((a, m) => a + m.totalPnl, 0),
    identityError: pairedPnl + directionalPnl - totalPnl,
    pairCost,
    bySeries,
  };
}
