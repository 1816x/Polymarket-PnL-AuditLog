/**
 * Phase 3 / Workstream B analysis — decode the sampled receipts:
 *
 *  1. FEES: the OrderFilled `fee` word (5th data word, both eras) is trusted
 *     ONLY after the empirical gate passes on this very sample: decoded
 *     amounts must reconcile with the local fills and every maker leg must
 *     carry fee = 0 (spec §8 — no unverified field feeds a published number).
 *  2. ROLE VALIDATION: on sampled markets, the Data-API taker classification
 *     (taker_fills) must agree with the on-chain role per (wallet, tx).
 *  3. FEED-GAP: pre-V2 inflow-market txs are scanned for CTF PositionSplit
 *     (mint-type matches) and ERC-1155 transfers crediting the wallet — the
 *     candidate acquisition channels the /trades feed never showed.
 */
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Db } from "../store/schema.ts";
import { extractWalletFills } from "../clients/onchain.ts";
import { CTF_TOPICS, V2_CUTOVER_TS, TOKEN_SCALE } from "../config/constants.ts";
import type { ChainSampleEntry } from "../ingest/fetch-onchain.ts";
import { receiptPath } from "../ingest/fetch-onchain.ts";

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}
interface RpcReceipt {
  transactionHash: string;
  logs: RpcLog[];
}

const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

export function loadReceipt(tx: string): RpcReceipt | null {
  const p = receiptPath(tx);
  if (!existsSync(p)) return null;
  return JSON.parse(gunzipSync(readFileSync(p)).toString("utf8")) as RpcReceipt;
}

const topicAddr = (t: string): string => ("0x" + t.slice(-40)).toLowerCase();

// ---------------------------------------------------------------------------
// 1+2: fee measurement + role validation over "feerole" entries
// ---------------------------------------------------------------------------

export interface FeeRoleResult {
  wallet: string;
  txs: number;
  txsMissingReceipt: number;
  legs: number;
  makerLegs: number;
  takerLegs: number;
  /**
   * MINT-type matches (tx contains a CTF PositionSplit): the exchange mints a
   * fresh Up/Down pair to satisfy crossing buys. Their OrderFilled legs report
   * GROSS both-sided flows (≠ the net API fill) and carry a NON-ZERO `fee`
   * word (~10% of the output amount) that demonstrably never left the wallet:
   * share conservation closes to ~0 and the cash ledger reconciles with
   * Polymarket's own accounting to cents. The decode/fee gates therefore apply
   * to STANDARD matches only; mint txs are bucketed and reported, not judged.
   */
  mintTxs: number;
  mintLegs: number;
  mintFeeWordLegs: number; // mint legs with a nonzero fee word (artifact, see above)
  /** empirical decode gate — STANDARD (non-mint) txs only */
  txAmountMatched: number;
  txAmountChecked: number;
  makerLegFeeViolations: number; // standard maker legs with fee != 0 (must be 0)
  /** measured fees — STANDARD txs only */
  feeLegs: number;
  feeTotal: number;
  feeByEra: Array<{ era: "pre-V2" | "post-V2"; legs: number; feeLegs: number; feeTotal: number; notional: number }>;
  /** API-vs-chain role agreement per (tx) — all txs (roles come from topics) */
  roleChecked: number;
  roleAgreed: number;
  roleMixedTxs: number;
}

export function analyzeFeeRole(db: Db, entries: ChainSampleEntry[], wallet: string): FeeRoleResult {
  const mine = entries.filter((e) => e.kind === "feerole" && e.wallet === wallet);
  const fillAgg = db.prepare(
    `SELECT COALESCE(SUM(size), 0) qty, COALESCE(SUM(size * price), 0) notional,
            MIN(ts) ts, COUNT(*) n
     FROM fills WHERE wallet = ? AND tx = ?`,
  );
  const takerAny = db.prepare(`SELECT COUNT(*) n FROM taker_fills WHERE wallet = ? AND tx = ?`);
  const sampledMkts = new Set(
    (db.prepare(`SELECT DISTINCT conditionId FROM taker_fills WHERE wallet = ?`).all(wallet) as Array<{ conditionId: string }>).map(
      (r) => r.conditionId,
    ),
  );
  // taker_fills only covers sampled markets; role validation is restricted to them.

  const res: FeeRoleResult = {
    wallet,
    txs: 0,
    txsMissingReceipt: 0,
    legs: 0,
    makerLegs: 0,
    takerLegs: 0,
    mintTxs: 0,
    mintLegs: 0,
    mintFeeWordLegs: 0,
    txAmountMatched: 0,
    txAmountChecked: 0,
    makerLegFeeViolations: 0,
    feeLegs: 0,
    feeTotal: 0,
    feeByEra: [
      { era: "pre-V2", legs: 0, feeLegs: 0, feeTotal: 0, notional: 0 },
      { era: "post-V2", legs: 0, feeLegs: 0, feeTotal: 0, notional: 0 },
    ],
    roleChecked: 0,
    roleAgreed: 0,
    roleMixedTxs: 0,
  };

  for (const e of mine) {
    const receipt = loadReceipt(e.tx);
    if (!receipt) {
      res.txsMissingReceipt++;
      continue;
    }
    res.txs++;
    const isMint = receipt.logs.some(
      (l) => l.address.toLowerCase() === CTF_ADDRESS && l.topics[0]?.toLowerCase() === CTF_TOPICS.positionSplit,
    );
    const legs = extractWalletFills(receipt as Parameters<typeof extractWalletFills>[0], wallet);
    const local = fillAgg.get(wallet, e.tx) as { qty: number; notional: number; ts: number | null; n: number };
    const era = (local.ts ?? 0) < V2_CUTOVER_TS ? 0 : 1;

    let chainShares = 0;
    const roles = new Set<string>();
    for (const l of legs) {
      res.legs++;
      const tokenOnTakerSide = l.makerAssetId === 0n;
      const shares = tokenOnTakerSide ? l.takerAmount : l.makerAmount;
      const cash = tokenOnTakerSide ? l.makerAmount : l.takerAmount;
      chainShares += shares;
      roles.add(l.role);
      if (l.role === "maker") res.makerLegs++;
      else res.takerLegs++;

      if (isMint) {
        res.mintLegs++;
        if (l.fee > 1e-9) res.mintFeeWordLegs++;
        continue; // fee/amount accounting below is standard-match only
      }
      const eraBucket = res.feeByEra[era];
      eraBucket.legs++;
      eraBucket.notional += cash;
      if (l.role === "maker" && l.fee > 1e-9) res.makerLegFeeViolations++;
      if (l.fee > 1e-9) {
        res.feeLegs++;
        res.feeTotal += l.fee;
        eraBucket.feeLegs++;
        eraBucket.feeTotal += l.fee;
      }
    }
    if (isMint) res.mintTxs++;

    // Amount gate (standard txs): Σ on-chain wallet shares vs Σ local sizes.
    if (!isMint && local.n > 0 && legs.length > 0) {
      res.txAmountChecked++;
      if (Math.abs(chainShares - local.qty) < Math.max(0.05, local.qty * 1e-4)) res.txAmountMatched++;
    }

    // Role gate (all txs with API truth available): roles come from indexed
    // topics and are unaffected by mint mechanics.
    if (sampledMkts.has(e.conditionId) && legs.length > 0) {
      if (roles.size === 2) {
        res.roleMixedTxs++;
      } else {
        const chainSaysTaker = roles.has("taker");
        const apiSaysTaker = ((takerAny.get(wallet, e.tx) as { n: number }).n ?? 0) > 0;
        res.roleChecked++;
        if (chainSaysTaker === apiSaysTaker) res.roleAgreed++;
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// 3: feed-gap classification over "feedgap-*" entries
// ---------------------------------------------------------------------------

export interface FeedGapResult {
  wallet: string;
  marketsSampled: number;
  sampledInflowValue: number;
  marketsWithMintEvidence: number; // ≥1 sampled fill-tx contains a CTF PositionSplit
  inflowValueWithMintEvidence: number;
  marketsWithDirectTransferIn: number; // ERC-1155 credit to wallet outside OrderFilled flows
  txsScanned: number;
  txsMissingReceipt: number;
}

export function analyzeFeedGap(db: Db, entries: ChainSampleEntry[], wallet: string): FeedGapResult {
  const mine = entries.filter((e) => e.kind.startsWith("feedgap") && e.wallet === wallet);
  const byMarket = new Map<string, ChainSampleEntry[]>();
  for (const e of mine) {
    if (!byMarket.has(e.conditionId)) byMarket.set(e.conditionId, []);
    byMarket.get(e.conditionId)!.push(e);
  }
  const inflowStmt = db.prepare(
    `SELECT MAX(0, -MIN(COALESCE(resid0, 0), 0)) * COALESCE(price0, 0)
          + MAX(0, -MIN(COALESCE(resid1, 0), 0)) * COALESCE(price1, 0) v
     FROM market_pnl WHERE wallet = ? AND conditionId = ?`,
  );

  const res: FeedGapResult = {
    wallet,
    marketsSampled: byMarket.size,
    sampledInflowValue: 0,
    marketsWithMintEvidence: 0,
    inflowValueWithMintEvidence: 0,
    marketsWithDirectTransferIn: 0,
    txsScanned: 0,
    txsMissingReceipt: 0,
  };
  const w = wallet.toLowerCase();

  for (const [conditionId, es] of byMarket) {
    const inflowValue = Number((inflowStmt.get(wallet, conditionId) as { v: number }).v ?? 0);
    res.sampledInflowValue += inflowValue;
    let mint = false;
    let directIn = false;
    for (const e of es) {
      const receipt = loadReceipt(e.tx);
      if (!receipt) {
        res.txsMissingReceipt++;
        continue;
      }
      res.txsScanned++;
      const isFillTx = e.kind === "feedgap-fill";
      for (const log of receipt.logs) {
        const addr = log.address.toLowerCase();
        if (addr !== CTF_ADDRESS) continue;
        const t0 = log.topics[0]?.toLowerCase();
        if (isFillTx && t0 === CTF_TOPICS.positionSplit) mint = true;
        // Direct ERC-1155 credit to the wallet inside a fill tx is normal
        // (that's how bought tokens arrive); the interesting signal is a
        // credit in a NON-fill tx (merge/redeem txs shouldn't credit tokens).
        if (!isFillTx && (t0 === CTF_TOPICS.transferSingle || t0 === CTF_TOPICS.transferBatch)) {
          const to = log.topics[3] ? topicAddr(log.topics[3]) : "";
          if (to === w) directIn = true;
        }
      }
    }
    if (mint) {
      res.marketsWithMintEvidence++;
      res.inflowValueWithMintEvidence += inflowValue;
    }
    if (directIn) res.marketsWithDirectTransferIn++;
  }
  return res;
}

/** Fee drag estimate for the post-fee floor: taker notional × measured rate. */
export function measuredFeeRate(r: FeeRoleResult, era: "pre-V2" | "post-V2"): number {
  const e = r.feeByEra.find((x) => x.era === era)!;
  return e.notional > 0 ? e.feeTotal / e.notional : 0;
}

export { TOKEN_SCALE };
