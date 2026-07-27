/**
 * Data API client — fills (/trades) and cash-flow activity (/activity).
 *
 * Both are PUBLIC (no auth) and accept any wallet via `user=`. Confirmed in
 * Phase 0. `/trades` carries no maker/taker field and no fee field (those come
 * from on-chain). `/activity` is REQUIRED for realized PnL because it carries
 * REDEEM/SPLIT/MERGE rows that /trades omits — though note REDEEM.usdcSize was
 * observed to be 0, so settlement value is computed from outcome × net position,
 * not trusted from the REDEEM row.
 */
import { z } from "zod";
import { DATA_API, LB_API } from "../config/constants.ts";
import { getJson } from "./http.ts";

const TradeSchema = z.object({
  proxyWallet: z.string(),
  side: z.string(), // BUY | SELL
  asset: z.string(), // ERC-1155 outcome-token id (positionId)
  conditionId: z.string(),
  size: z.number(), // share count (float; carries precision noise)
  price: z.number(), // per-share price in [0,1]
  timestamp: z.number(), // epoch seconds
  outcome: z.string().nullable().optional(),
  outcomeIndex: z.number().nullable().optional(),
  title: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  transactionHash: z.string(),
});
export type Trade = z.infer<typeof TradeSchema>;

const ActivitySchema = z.object({
  proxyWallet: z.string(),
  type: z.string(), // TRADE | SPLIT | MERGE | REDEEM | REWARD | CONVERSION | MAKER_REBATE | TAKER_REBATE | ...
  conditionId: z.string().nullable().optional(),
  asset: z.string().nullable().optional(),
  side: z.string().nullable().optional(),
  size: z.number().nullable().optional(),
  usdcSize: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  outcome: z.string().nullable().optional(),
  outcomeIndex: z.number().nullable().optional(),
  timestamp: z.number(),
  title: z.string().nullable().optional(),
  transactionHash: z.string().nullable().optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export interface TradeQuery {
  user: string;
  takerOnly?: boolean; // default true on the API; we pass false to include maker fills
  conditionId?: string;
  side?: "BUY" | "SELL";
  limit?: number;
  start?: number; // epoch seconds
  end?: number;
}

/** Fetch a page of fills for a wallet. Pagination/windowing lives in the ingest layer. */
export async function getTrades(q: TradeQuery): Promise<Trade[]> {
  const p = new URLSearchParams({ user: q.user });
  p.set("takerOnly", String(q.takerOnly ?? false));
  if (q.conditionId) p.set("market", q.conditionId);
  if (q.side) p.set("side", q.side);
  p.set("limit", String(q.limit ?? 100));
  if (q.start !== undefined) p.set("start", String(q.start));
  if (q.end !== undefined) p.set("end", String(q.end));
  const raw = await getJson(`${DATA_API}/trades?${p.toString()}`, { label: `data /trades ${q.user}` });
  return z.array(TradeSchema).parse(raw);
}

export interface ActivityQuery {
  user: string;
  limit?: number;
  start?: number;
  end?: number;
  /** Comma-joined activity types to include, e.g. "REDEEM,MERGE,REWARD". Omit for all. */
  type?: string;
}

// ---------------------------------------------------------------------------
// Polymarket's OWN per-position PnL (Phase 2 reconciliation oracle — never our
// source of truth, spec §-recon). One row per outcome TOKEN; sum the ≤2 rows of
// a conditionId to compare per-market.
// ---------------------------------------------------------------------------

const ClosedPositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  avgPrice: z.number().nullable().optional(),
  totalBought: z.number().nullable().optional(),
  realizedPnl: z.number().nullable().optional(),
  curPrice: z.number().nullable().optional(),
  outcomeIndex: z.number().nullable().optional(),
  title: z.string().nullable().optional(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

/** Polymarket's own realized PnL per closed position. `market` filters by conditionId. */
export async function getClosedPositions(q: {
  user: string;
  market?: string;
  limit?: number;
  offset?: number;
}): Promise<ClosedPosition[]> {
  const p = new URLSearchParams({ user: q.user });
  if (q.market) p.set("market", q.market);
  p.set("limit", String(q.limit ?? 50));
  if (q.offset) p.set("offset", String(q.offset));
  const raw = await getJson(`${DATA_API}/closed-positions?${p.toString()}`, {
    label: `data /closed-positions ${q.user}`,
  });
  return z.array(ClosedPositionSchema).parse(raw);
}

const OpenPositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  size: z.number().nullable().optional(),
  avgPrice: z.number().nullable().optional(),
  cashPnl: z.number().nullable().optional(),
  realizedPnl: z.number().nullable().optional(),
  curPrice: z.number().nullable().optional(),
  redeemable: z.boolean().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  outcomeIndex: z.number().nullable().optional(),
  title: z.string().nullable().optional(),
});
export type OpenPosition = z.infer<typeof OpenPositionSchema>;

/** Current (open/redeemable) positions with Polymarket's own PnL fields. */
export async function getPositions(q: {
  user: string;
  market?: string;
  limit?: number;
  sizeThreshold?: number;
}): Promise<OpenPosition[]> {
  const p = new URLSearchParams({ user: q.user });
  if (q.market) p.set("market", q.market);
  p.set("limit", String(q.limit ?? 50));
  p.set("sizeThreshold", String(q.sizeThreshold ?? 0));
  const raw = await getJson(`${DATA_API}/positions?${p.toString()}`, { label: `data /positions ${q.user}` });
  return z.array(OpenPositionSchema).parse(raw);
}

/** Current portfolio (token holdings) value in USDC, per Polymarket. */
export async function getPortfolioValue(user: string): Promise<number | null> {
  const raw = await getJson(`${DATA_API}/value?user=${encodeURIComponent(user)}`, {
    label: `data /value ${user}`,
  });
  const arr = z.array(z.object({ user: z.string().optional(), value: z.number() })).safeParse(raw);
  if (arr.success && arr.data[0]) return arr.data[0].value;
  const obj = z.object({ value: z.number() }).safeParse(raw);
  return obj.success ? obj.data.value : null;
}

// ---------------------------------------------------------------------------
// Phase 5 control group — market participants + leaderboard PnL/volume.
// ---------------------------------------------------------------------------

/**
 * All trades in a market, WITHOUT a user filter — the participant list for the
 * control-group sampling frame. One page (default 500) is enough to sample
 * participants; we are not enumerating every trade (documented in the report).
 */
export async function getMarketTrades(conditionId: string, limit = 500): Promise<Trade[]> {
  const p = new URLSearchParams({ market: conditionId, takerOnly: "false", limit: String(limit) });
  const raw = await getJson(`${DATA_API}/trades?${p.toString()}`, { label: `data /trades market ${conditionId.slice(0, 10)}` });
  return z.array(TradeSchema).parse(raw);
}

const LbEntrySchema = z.object({ proxyWallet: z.string(), amount: z.number(), name: z.string().nullable().optional() });

/** All-time realized profit for an address (Polymarket's own number — the same metric used for the subjects). */
export async function getLeaderboardProfit(address: string): Promise<number | null> {
  const raw = await getJson(`${LB_API}/profit?window=all&address=${encodeURIComponent(address)}`, { label: `lb /profit ${address.slice(0, 10)}` });
  const arr = z.array(LbEntrySchema).safeParse(raw);
  return arr.success && arr.data[0] ? arr.data[0].amount : null;
}

/** All-time traded volume (USDC) for an address. */
export async function getLeaderboardVolume(address: string): Promise<number | null> {
  const raw = await getJson(`${LB_API}/volume?window=all&address=${encodeURIComponent(address)}`, { label: `lb /volume ${address.slice(0, 10)}` });
  const arr = z.array(LbEntrySchema).safeParse(raw);
  return arr.success && arr.data[0] ? arr.data[0].amount : null;
}

/** Fetch a page of activity rows for a wallet (limit capped at 500 by the API). */
export async function getActivity(q: ActivityQuery): Promise<Activity[]> {
  const p = new URLSearchParams({ user: q.user });
  p.set("limit", String(Math.min(q.limit ?? 100, 500)));
  if (q.start !== undefined) p.set("start", String(q.start));
  if (q.end !== undefined) p.set("end", String(q.end));
  if (q.type) p.set("type", q.type);
  const raw = await getJson(`${DATA_API}/activity?${p.toString()}`, { label: `data /activity ${q.user}` });
  return z.array(ActivitySchema).parse(raw);
}
