/**
 * Central configuration for the Polymarket PnL forensic auditor.
 *
 * Every value here was verified live against official docs / on-chain / live API
 * calls during Phase-0 reconnaissance (2026-07-24). Where a value is provisional
 * or came from secondary reporting it is flagged inline — DO NOT silently trust
 * those; they must be confirmed against a primary source before they feed a
 * published number (spec §8).
 *
 * No secrets live here. The project is read-only and never uses a wallet key
 * (spec §9). The only credential the tool can optionally consume is a Polygon
 * RPC provider URL via POLYGON_RPC_URL — that is read-only infrastructure.
 */

// ---------------------------------------------------------------------------
// API base URLs (confirmed, no auth required for the endpoints we use)
// ---------------------------------------------------------------------------
export const GAMMA_API = "https://gamma-api.polymarket.com";
export const DATA_API = "https://data-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";

// ---------------------------------------------------------------------------
// Polygon (chainId 137) contracts — confirmed via PolygonScan labels + on-chain
// ---------------------------------------------------------------------------
export const CONTRACTS = {
  // Conditional Tokens Framework (ERC-1155) — UNCHANGED across the V2 cutover.
  // Source of authoritative settlement via payoutNumerators / ConditionResolution.
  conditionalTokens: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",

  // CTF Exchange — the venue that emits OrderFilled (maker/taker + fee).
  exchangeV1: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", // pre-cutover
  exchangeV2: "0xe111180000d2663c0091e4f400237545b87b996b", // post-cutover (confirmed on-chain in Phase 0)

  // Neg-Risk exchanges (multi-outcome); own V1/V2 pair.
  negRiskExchangeV1: "0xc5d563a36ae78145c45a50134d48a1215220f80a",
  negRiskExchangeV2: "0xe2222d279d744050d28e00520010520000310f59",

  // Collateral tokens (6 decimals). Both symbols verified on-chain in Phase 0.
  usdcE: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // pre-cutover collateral (symbol: USDC)
  pUSD: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", // post-cutover collateral (symbol: pUSD, verified)
} as const;

/** All exchange addresses that can emit an OrderFilled we care about. */
export const EXCHANGE_ADDRESSES = new Set<string>([
  CONTRACTS.exchangeV1,
  CONTRACTS.exchangeV2,
  CONTRACTS.negRiskExchangeV1,
  CONTRACTS.negRiskExchangeV2,
]);

// ---------------------------------------------------------------------------
// The CLOB "V2" migration cutover — the biggest architectural boundary.
// After this instant: V2 contracts, pUSD collateral, deprecated v1 subgraphs.
// ---------------------------------------------------------------------------
export const V2_CUTOVER_ISO = "2026-04-28T11:00:00Z";
export const V2_CUTOVER_TS = Math.floor(Date.parse(V2_CUTOVER_ISO) / 1000);

export type ExchangeEra = "v1" | "v2";
/** Pick the contract era in effect at a given epoch-seconds timestamp. */
export function eraFor(tsSeconds: number): ExchangeEra {
  return tsSeconds >= V2_CUTOVER_TS ? "v2" : "v1";
}

// ---------------------------------------------------------------------------
// OrderFilled event — topic0 observed on-chain (V2). The full data-word ABI is
// only PROVISIONALLY decoded (see clients/onchain.ts); the 3 indexed topics
// (orderHash, maker, taker) are unambiguous and are all Phase 0 relies on.
// The exact V2 non-indexed field layout must be confirmed against the verified
// contract ABI before the fee/amount fields feed a published number (spec §8).
// ---------------------------------------------------------------------------
export const ORDER_FILLED_TOPIC_V2 =
  "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";

/** Fixed-point scale for USDC.e / pUSD and for outcome-token share amounts (6 dp). */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SCALE = 10 ** TOKEN_DECIMALS;

// ---------------------------------------------------------------------------
// Taker-fee schedule — fee = shares * rate * price * (1 - price), takers only.
// Rate is TIME-VARYING; never hardcode a single value mid-logic (spec §3.3).
// Dates below are from SECONDARY reporting (agent research) and MUST be pinned
// to primary Polymarket announcements before the pre/post-fees cut is published.
// Makers pay 0 (confirmed on-chain in Phase 0: maker leg fee == 0).
// ---------------------------------------------------------------------------
export interface FeeRatePeriod {
  fromTs: number; // epoch seconds, inclusive
  rate: number;
  note: string;
}

export const CRYPTO_FEE_SCHEDULE: FeeRatePeriod[] = [
  { fromTs: 0, rate: 0, note: "no taker fee before intro" },
  {
    fromTs: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
    rate: 0.072,
    note: "PROVISIONAL intro ~Jan 2026 (15m crypto first); pin exact date to primary source",
  },
  {
    fromTs: Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000),
    rate: 0.07,
    note: "PROVISIONAL crypto rate eased 0.072->0.07 ~Jul 2026; pin exact date",
  },
];

/** Crypto taker-fee rate in effect at a timestamp (0 before fees existed). */
export function cryptoFeeRate(tsSeconds: number): number {
  let rate = 0;
  for (const p of CRYPTO_FEE_SCHEDULE) if (tsSeconds >= p.fromTs) rate = p.rate;
  return rate;
}

// ---------------------------------------------------------------------------
// Polygon RPC. Public endpoints are increasingly gated; these were reachable in
// Phase 0. Override with POLYGON_RPC_URL (a provider key gives reliable backfill).
// ---------------------------------------------------------------------------
export const DEFAULT_POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://polygon.api.onfinality.io/public",
  "https://1rpc.io/matic",
];

export function polygonRpcUrls(): string[] {
  const fromEnv = process.env.POLYGON_RPC_URL?.trim();
  return fromEnv ? [fromEnv, ...DEFAULT_POLYGON_RPCS] : [...DEFAULT_POLYGON_RPCS];
}

// ---------------------------------------------------------------------------
// Subjects of the audit — the five wallets named in the article (spec §1).
// Usernames are resolved to proxy addresses at runtime (ingest/resolve-wallets).
// ---------------------------------------------------------------------------
export type SubjectSeed =
  | { id: number; kind: "address"; address: string; profile: string }
  | { id: number; kind: "username"; username: string; profile: string };

export const SUBJECTS: SubjectSeed[] = [
  {
    id: 1,
    kind: "address",
    address: "0xb27bc932bf8110d8f78e55da7d5f0497a18b5b82",
    profile: "BTC, 5m & 15m. Balanced version. Closes near neutral.",
  },
  {
    id: 2,
    kind: "username",
    username: "BadFallen",
    profile: "Standardized sizes (~30/65/90). Median 5 side-changes per market.",
  },
  {
    id: 3,
    kind: "username",
    username: "neversmiling",
    profile: "BTC/ETH/SOL/XRP, 5m/15m/1h. Less balanced final positions.",
  },
  {
    id: 4,
    kind: "username",
    username: "pspspsps5",
    profile: "Predominantly directional. Buys both sides in ~36% of markets.",
  },
  {
    id: 5,
    kind: "address",
    address: "0xce25e214d5cfe4f459cf67f08df581885aae7fdc",
    profile: "BTC/ETH/SOL/XRP, 5m & 15m. Both sides in 94.4% of markets. Final imbalance <1%.",
  },
];
