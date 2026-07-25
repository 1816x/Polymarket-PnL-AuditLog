/**
 * CLOB API client — market metadata + settlement (PUBLIC, no auth).
 *
 * Phase 0 finding: GET /markets/<conditionId> is the RELIABLE settlement source.
 * It returns `closed` plus a per-token array with an explicit `winner` boolean and
 * `price` (0 or 1 once resolved) — cleaner and more consistent than Gamma's
 * outcomePrices (which flaked for freshly-resolved short-term markets). The
 * authoritative tiebreaker remains on-chain payoutNumerators (see onchain.ts),
 * used on the reconciliation sample.
 *
 * (This is the market-metadata endpoint, NOT the auth-gated /data/trades.)
 */
import { z } from "zod";
import { CLOB_API } from "../config/constants.ts";
import { getJson } from "./http.ts";

const ClobTokenSchema = z.object({
  token_id: z.string(),
  outcome: z.string(),
  price: z.number(),
  winner: z.boolean().nullable().optional(),
});
export type ClobToken = z.infer<typeof ClobTokenSchema>;

const ClobMarketSchema = z.object({
  question: z.string().nullable().optional(),
  condition_id: z.string().nullable().optional(),
  closed: z.boolean().nullable().optional(),
  active: z.boolean().nullable().optional(),
  tokens: z.array(ClobTokenSchema).nullable().optional(),
});
export type ClobMarket = z.infer<typeof ClobMarketSchema>;

export interface Settlement {
  conditionId: string;
  resolved: boolean;
  /** Raw `closed` flag from the market object (needed to tell a 50/50 refund from an open market). */
  closed: boolean | null;
  /** outcome index (0/1) that won, or null if unresolved/ambiguous. */
  winningOutcomeIndex: number | null;
  winningTokenId: string | null;
  question: string | null;
  tokens: ClobToken[];
}

/** Fetch a market and derive its settlement (winning outcome), or null if not found. */
export async function getMarketSettlement(conditionId: string): Promise<Settlement | null> {
  let market: ClobMarket;
  try {
    const raw = await getJson(`${CLOB_API}/markets/${conditionId}`, { label: `clob market ${conditionId}` });
    market = ClobMarketSchema.parse(raw);
  } catch {
    return null;
  }
  const tokens = market.tokens ?? [];
  const winnerIdx = tokens.findIndex((t) => t.winner === true || t.price === 1);
  const resolved = market.closed === true && winnerIdx >= 0;
  return {
    conditionId,
    resolved,
    closed: market.closed ?? null,
    winningOutcomeIndex: resolved ? winnerIdx : null,
    winningTokenId: resolved ? tokens[winnerIdx].token_id : null,
    question: market.question ?? null,
    tokens,
  };
}
