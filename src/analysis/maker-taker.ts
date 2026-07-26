/**
 * Phase 3 / H2 — maker/taker shares from the sampled taker subset.
 *
 * For every market in the deterministic sample (analysis/sampling.ts), the
 * full fill set lives in `fills` and the taker subset in `taker_fills`
 * (fetched via /trades?takerOnly=true&market=). Maker share = 1 − taker share.
 * Shares are reported by fill rows, by share quantity, and by notional; the CI
 * is a market-level bootstrap of the notional-weighted share (markets, not
 * fills, are the sampling unit).
 */
import type { Db } from "../store/schema.ts";
import { sampleResolvedMarkets } from "./sampling.ts";
import { bootstrapMeanCI, mulberry32 } from "./stats.ts";
import { V2_CUTOVER_TS } from "../config/constants.ts";

export interface MarketTakerShare {
  conditionId: string;
  month: string;
  preV2: boolean;
  fills: number;
  takerRows: number;
  qty: number;
  takerQty: number;
  notional: number;
  takerNotional: number;
}

export interface WalletMakerTaker {
  wallet: string;
  marketsSampled: number;
  takerShareRows: number;
  takerShareQty: number;
  takerShareNotional: number;
  /** market-level bootstrap CI of the aggregate notional taker share */
  takerNotionalCI95: { lo: number; hi: number };
  byEra: Array<{ era: "pre-V2" | "post-V2"; markets: number; takerShareNotional: number }>;
  byMonth: Array<{ month: string; markets: number; takerShareNotional: number }>;
  markets: MarketTakerShare[];
}

export function walletMakerTaker(db: Db, wallet: string, target = 400, seed = 20260726): WalletMakerTaker {
  const sample = sampleResolvedMarkets(db, wallet, target);
  const fullStmt = db.prepare(
    `SELECT COALESCE(SUM(buyQty + sellQty), 0) qty,
            COALESCE(SUM(buyCost + sellProceeds), 0) notional,
            COALESCE(SUM(fillCount), 0) fills
     FROM positions WHERE wallet = ? AND conditionId = ?`,
  );
  const takerStmt = db.prepare(
    `SELECT COALESCE(SUM(size), 0) qty, COALESCE(SUM(size * price), 0) notional, COUNT(*) n
     FROM taker_fills WHERE wallet = ? AND conditionId = ?`,
  );
  const tsStmt = db.prepare(`SELECT resolvedTs FROM market_pnl WHERE wallet = ? AND conditionId = ?`);

  const markets: MarketTakerShare[] = [];
  for (const s of sample) {
    const full = fullStmt.get(wallet, s.conditionId) as { qty: number; notional: number; fills: number };
    const taker = takerStmt.get(wallet, s.conditionId) as { qty: number; notional: number; n: number };
    const ts = (tsStmt.get(wallet, s.conditionId) as { resolvedTs: number }).resolvedTs;
    markets.push({
      conditionId: s.conditionId,
      month: s.month,
      preV2: ts < V2_CUTOVER_TS,
      fills: full.fills,
      takerRows: taker.n,
      qty: full.qty,
      takerQty: taker.qty,
      notional: full.notional,
      takerNotional: taker.notional,
    });
  }

  const sum = (f: (m: MarketTakerShare) => number) => markets.reduce((a, m) => a + f(m), 0);
  const agg = (ms: MarketTakerShare[]) => {
    const notional = ms.reduce((a, m) => a + m.notional, 0);
    const taker = ms.reduce((a, m) => a + m.takerNotional, 0);
    return notional > 0 ? taker / notional : 0;
  };

  // Market-level bootstrap of the aggregate (weighted) notional taker share.
  const rnd = mulberry32(seed);
  const R = 5_000;
  const shares = new Float64Array(R);
  for (let r = 0; r < R; r++) {
    let tn = 0;
    let nn = 0;
    for (let i = 0; i < markets.length; i++) {
      const m = markets[(rnd() * markets.length) | 0];
      tn += m.takerNotional;
      nn += m.notional;
    }
    shares[r] = nn > 0 ? tn / nn : 0;
  }
  shares.sort();

  const byMonthMap = new Map<string, MarketTakerShare[]>();
  for (const m of markets) {
    if (!byMonthMap.has(m.month)) byMonthMap.set(m.month, []);
    byMonthMap.get(m.month)!.push(m);
  }

  return {
    wallet,
    marketsSampled: markets.length,
    takerShareRows: sum((m) => m.takerRows) / Math.max(1, sum((m) => m.fills)),
    takerShareQty: sum((m) => m.takerQty) / Math.max(1, sum((m) => m.qty)),
    takerShareNotional: agg(markets),
    takerNotionalCI95: { lo: shares[Math.floor(0.025 * R)], hi: shares[Math.floor(0.975 * R)] },
    byEra: (["pre-V2", "post-V2"] as const).map((era) => {
      const ms = markets.filter((m) => (era === "pre-V2") === m.preV2);
      return { era, markets: ms.length, takerShareNotional: agg(ms) };
    }),
    byMonth: [...byMonthMap]
      .map(([month, ms]) => ({ month, markets: ms.length, takerShareNotional: agg(ms) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    markets,
  };
}

// re-export for the analyze command's fee-floor assembly
export { bootstrapMeanCI };
