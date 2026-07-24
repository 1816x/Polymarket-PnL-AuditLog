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
import { DATA_API } from "../config/constants.ts";
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
}

/** Fetch a page of activity rows for a wallet (limit capped at 500 by the API). */
export async function getActivity(q: ActivityQuery): Promise<Activity[]> {
  const p = new URLSearchParams({ user: q.user });
  p.set("limit", String(Math.min(q.limit ?? 100, 500)));
  if (q.start !== undefined) p.set("start", String(q.start));
  if (q.end !== undefined) p.set("end", String(q.end));
  const raw = await getJson(`${DATA_API}/activity?${p.toString()}`, { label: `data /activity ${q.user}` });
  return z.array(ActivitySchema).parse(raw);
}
