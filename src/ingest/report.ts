/**
 * Phase 1 volume report: reads the store and reports what was ingested — fill and
 * market counts, date range, BUY/SELL split (answers spec §3.2 "do they sell?"),
 * non-trade activity (incl. measured rebates for H2), and a settlement-resolution
 * rate estimated from a random market sample (full resolution is Phase 2).
 */
import type { Repository } from "../store/repository.ts";
import { getMarketSettlement } from "../clients/clob.ts";

export interface WalletVolume {
  wallet: string;
  label: string;
  fills: number;
  markets: number;
  dateRange: { min: number; max: number } | null;
  side: { buy: number; sell: number };
  activityTypes: Record<string, number>;
  rebateTotal: number;
  settlementSample: { sampled: number; resolved: number } | null;
}

function isoDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Fetch settlement for a random sample of the wallet's markets; cache + count resolved. */
export async function sampleSettlement(
  repo: Repository,
  wallet: string,
  n: number,
): Promise<{ sampled: number; resolved: number }> {
  const ids = repo.marketIds(wallet);
  // Fisher–Yates partial shuffle for a uniform sample.
  for (let i = ids.length - 1; i > 0 && i > ids.length - 1 - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const sample = ids.slice(Math.max(0, ids.length - n));
  const fetchedAt = new Date().toISOString();
  let resolved = 0;
  for (const cid of sample) {
    const s = await getMarketSettlement(cid);
    if (s) {
      if (s.resolved) resolved++;
      repo.upsertMarket({
        conditionId: cid,
        question: s.question,
        closed: s.resolved ? true : null,
        resolved: s.resolved,
        winningOutcomeIndex: s.winningOutcomeIndex,
        fetchedAt,
      });
    }
  }
  return { sampled: sample.length, resolved };
}

export function collectVolume(repo: Repository, wallet: string, label: string): WalletVolume {
  return {
    wallet,
    label,
    fills: repo.fillCount(wallet),
    markets: repo.distinctMarkets(wallet),
    dateRange: repo.dateRange(wallet),
    side: repo.sideCounts(wallet),
    activityTypes: repo.activityTypeCounts(wallet),
    rebateTotal: repo.rebateTotal(wallet),
    settlementSample: null,
  };
}

export function formatVolume(vols: WalletVolume[]): string {
  const lines: string[] = [];
  let tFills = 0;
  let tMarkets = 0;
  let tBuy = 0;
  let tSell = 0;
  for (const v of vols) {
    const range = v.dateRange ? `${isoDay(v.dateRange.min)} → ${isoDay(v.dateRange.max)}` : "—";
    const sellPct = v.side.buy + v.side.sell > 0 ? (100 * v.side.sell) / (v.side.buy + v.side.sell) : 0;
    const samp = v.settlementSample
      ? `${v.settlementSample.resolved}/${v.settlementSample.sampled} resolved (${((100 * v.settlementSample.resolved) / Math.max(1, v.settlementSample.sampled)).toFixed(0)}%)`
      : "—";
    lines.push(`\n■ ${v.label}  (${v.wallet})`);
    lines.push(`    fills:    ${v.fills.toLocaleString()}`);
    lines.push(`    markets:  ${v.markets.toLocaleString()} distinct conditionIds`);
    lines.push(`    range:    ${range}`);
    lines.push(`    side:     BUY ${v.side.buy.toLocaleString()} / SELL ${v.side.sell.toLocaleString()}  (${sellPct.toFixed(2)}% sells)`);
    lines.push(`    activity: ${JSON.stringify(v.activityTypes)}`);
    lines.push(`    rebates:  ${v.rebateTotal.toFixed(4)} USDC (measured REWARD/MAKER_REBATE/TAKER_REBATE)`);
    lines.push(`    settled:  ${samp} (sample)`);
    tFills += v.fills;
    tMarkets += v.markets;
    tBuy += v.side.buy;
    tSell += v.side.sell;
  }
  lines.push(`\n${"═".repeat(64)}`);
  lines.push(`TOTAL: ${tFills.toLocaleString()} fills, ${tMarkets.toLocaleString()} market-rows across ${vols.length} wallets`);
  lines.push(`       BUY ${tBuy.toLocaleString()} / SELL ${tSell.toLocaleString()} (${tBuy + tSell > 0 ? ((100 * tSell) / (tBuy + tSell)).toFixed(2) : "0"}% sells)`);
  return lines.join("\n");
}
