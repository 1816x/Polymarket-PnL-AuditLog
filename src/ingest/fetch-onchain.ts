/**
 * Phase 3 / Workstream B — deterministic on-chain receipt sample.
 *
 * Two strata:
 *  - "feerole": fill txs from the SAME deterministic market sample the taker
 *    ingest uses (sampling.ts guarantees the overlap), spread across each
 *    market's timeline → fee measurement + API-vs-chain role validation.
 *  - "feedgap": pre-V2 inflow markets (largest inflow value first) → their
 *    fill txs + merge/redeem txs, to classify how the feed-invisible shares
 *    were acquired (mint-match legs vs transfers).
 *
 * Writes ONLY files (raw receipts + a manifest) — no DB writes — so it can run
 * concurrently with the taker ingest against the same SQLite store (WAL:
 * many readers, one writer). Resume = receipt-file existence.
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import type { Db } from "../store/schema.ts";
import { getTransactionReceipt } from "../clients/onchain.ts";
import { sampleResolvedMarkets, sampleInflowMarkets } from "../analysis/sampling.ts";
import { V2_CUTOVER_TS } from "../config/constants.ts";

const RECEIPT_DIR = "data/raw/receipts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ChainSampleKind = "feerole" | "feedgap-fill" | "feedgap-merge" | "feedgap-redeem";

export interface ChainSampleEntry {
  kind: ChainSampleKind;
  wallet: string;
  conditionId: string;
  tx: string;
}

/** Spread picks over a list: first, quartiles, last (deduped, ≤ n). */
function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  const idx = new Set<number>();
  for (let i = 0; i < n; i++) idx.add(Math.round((i * (list.length - 1)) / (n - 1)));
  return [...idx].sort((a, b) => a - b).map((i) => list[i]);
}

/** Build the deterministic receipt sample (pure DB reads). */
export function buildChainSample(
  db: Db,
  wallets: string[],
  opts: { feeMarketsPerWallet?: number; txPerMarket?: number; inflowMarketsPerWallet?: number } = {},
): ChainSampleEntry[] {
  const feeMarkets = opts.feeMarketsPerWallet ?? 32;
  const txPerMarket = opts.txPerMarket ?? 5;
  const inflowMarkets = opts.inflowMarketsPerWallet ?? 40;

  const entries: ChainSampleEntry[] = [];
  const seenTx = new Set<string>();
  const push = (e: ChainSampleEntry) => {
    if (!seenTx.has(e.tx)) {
      seenTx.add(e.tx);
      entries.push(e);
    }
  };
  // INDEXED BY: without it the planner picks idx_fills_wallet_ts for the
  // wallet=? term and scans the wallet's entire 15M-row history per market.
  const fillTxStmt = db.prepare(
    `SELECT DISTINCT tx FROM fills INDEXED BY idx_fills_cond
     WHERE conditionId = ? AND wallet = ? ORDER BY ts, tx`,
  );
  const actTxStmt = db.prepare(
    `SELECT tx FROM activity INDEXED BY idx_activity_cond
     WHERE conditionId = ? AND wallet = ? AND type = ? AND tx <> ''
     ORDER BY usdcSize DESC, ts LIMIT 1`,
  );

  for (const w of wallets) {
    for (const m of sampleResolvedMarkets(db, w, feeMarkets)) {
      const txs = (fillTxStmt.all(m.conditionId, w) as Array<{ tx: string }>).map((r) => r.tx);
      for (const tx of spread(txs, txPerMarket)) push({ kind: "feerole", wallet: w, conditionId: m.conditionId, tx });
    }
    for (const m of sampleInflowMarkets(db, w, V2_CUTOVER_TS, inflowMarkets)) {
      const txs = (fillTxStmt.all(m.conditionId, w) as Array<{ tx: string }>).map((r) => r.tx);
      for (const tx of spread(txs, 2)) push({ kind: "feedgap-fill", wallet: w, conditionId: m.conditionId, tx });
      const merge = actTxStmt.get(m.conditionId, w, "MERGE") as { tx: string } | undefined;
      if (merge) push({ kind: "feedgap-merge", wallet: w, conditionId: m.conditionId, tx: merge.tx });
      const redeem = actTxStmt.get(m.conditionId, w, "REDEEM") as { tx: string } | undefined;
      if (redeem) push({ kind: "feedgap-redeem", wallet: w, conditionId: m.conditionId, tx: redeem.tx });
    }
  }
  return entries;
}

export const receiptPath = (tx: string): string => `${RECEIPT_DIR}/${tx}.json.gz`;

export interface ChainFetchResult {
  total: number;
  fetched: number;
  cached: number;
  failed: string[];
}

export async function fetchChainSample(
  entries: ChainSampleEntry[],
  opts: { concurrency?: number; delayMs?: number; log?: (m: string) => void } = {},
): Promise<ChainFetchResult> {
  const concurrency = opts.concurrency ?? 3;
  const delayMs = opts.delayMs ?? 100;
  const log = opts.log ?? (() => {});
  mkdirSync(RECEIPT_DIR, { recursive: true });

  const res: ChainFetchResult = { total: entries.length, fetched: 0, cached: 0, failed: [] };
  const t0 = Date.now();
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      const e = entries[i];
      const path = receiptPath(e.tx);
      if (existsSync(path)) {
        res.cached++;
      } else {
        let receipt = null;
        for (let attempt = 0; attempt < 3 && !receipt; attempt++) {
          try {
            receipt = await getTransactionReceipt(e.tx);
          } catch {
            /* rpcCall already rotates endpoints; retry the rotation */
          }
          if (!receipt && attempt < 2) await sleep(500 * (attempt + 1));
        }
        if (receipt) {
          writeFileSync(path, gzipSync(JSON.stringify(receipt)));
          res.fetched++;
        } else {
          res.failed.push(e.tx);
        }
        if (delayMs > 0) await sleep(delayMs);
      }
      done++;
      if (done % 100 === 0 || done === entries.length) {
        const rate = done / Math.max((Date.now() - t0) / 1000, 0.001);
        log(
          `receipts ${done}/${entries.length} (cached ${res.cached}, failed ${res.failed.length}) · ` +
            `${rate.toFixed(1)}/s · ETA ${Math.round((entries.length - done) / Math.max(rate, 0.001))}s`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return res;
}
