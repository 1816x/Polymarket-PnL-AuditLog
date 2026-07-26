/**
 * Deterministic stratified sampling shared by the Phase-3 samplers (taker-subset
 * ingest and on-chain receipt sample).
 *
 * Determinism without an RNG: conditionIds are keccak outputs (uniform
 * pseudo-random hex), so ordering by conditionId within a stratum and taking
 * the first N is equivalent to a fixed-seed random draw — and two independent
 * runs (or two different samplers) select exactly the same markets, which is
 * what lets the API-role sample and the on-chain validation sample overlap by
 * construction.
 *
 * Strata: calendar month of resolvedTs, per wallet. Quota: ceil(target/months)
 * per month, so thin months are still represented and the total lands near the
 * target.
 */
import type { Db } from "../store/schema.ts";

export interface SampledMarket {
  wallet: string;
  conditionId: string;
  month: string; // YYYY-MM (UTC, of resolvedTs)
  fillCount: number;
}

/** Deterministic per-month sample of resolved markets with fills, for one wallet. */
export function sampleResolvedMarkets(db: Db, wallet: string, target: number): SampledMarket[] {
  const months = (
    db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m', resolvedTs, 'unixepoch') m
         FROM market_pnl WHERE wallet = ? AND status = 'resolved' AND fillCount > 0 ORDER BY 1`,
      )
      .all(wallet) as Array<{ m: string }>
  ).map((r) => r.m);
  if (months.length === 0) return [];
  const perMonth = Math.max(1, Math.ceil(target / months.length));

  const stmt = db.prepare(
    `SELECT conditionId, fillCount
     FROM market_pnl
     WHERE wallet = ? AND status = 'resolved' AND fillCount > 0
       AND strftime('%Y-%m', resolvedTs, 'unixepoch') = ?
     ORDER BY conditionId
     LIMIT ?`,
  );
  const out: SampledMarket[] = [];
  for (const month of months) {
    for (const r of stmt.all(wallet, month, perMonth) as Array<{ conditionId: string; fillCount: number }>) {
      out.push({ wallet, conditionId: r.conditionId, month, fillCount: r.fillCount });
    }
  }
  return out;
}

/**
 * Deterministic sample of pre-cutover inflow markets (feed-gap question),
 * largest inflow value first — we want to explain dollars, not market counts.
 */
export function sampleInflowMarkets(
  db: Db,
  wallet: string,
  beforeTs: number,
  limit: number,
): Array<{ wallet: string; conditionId: string; inflowValue: number }> {
  return (
    db
      .prepare(
        `SELECT wallet, conditionId,
                MAX(0, -MIN(COALESCE(resid0, 0), 0)) * COALESCE(price0, 0)
              + MAX(0, -MIN(COALESCE(resid1, 0), 0)) * COALESCE(price1, 0) AS inflowValue
         FROM market_pnl
         WHERE wallet = ? AND hasInflow = 1 AND resolvedTs < ?
         ORDER BY inflowValue DESC, conditionId
         LIMIT ?`,
      )
      .all(wallet, beforeTs, limit) as Array<{ wallet: string; conditionId: string; inflowValue: number }>
  );
}
