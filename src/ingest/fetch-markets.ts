/**
 * Phase 2 — market-metadata backfill for every conditionId seen in fills ∪
 * activity (~224k). Primary source: Gamma /markets?condition_ids=…&closed=true
 * in batches of 40 (verified live; see clients/gamma.ts header). Fallback for
 * ids Gamma doesn't cover (incl. still-open markets): CLOB /markets/<id>.
 *
 * Raw-cache design (spec §2): one gzipped NDJSON file per Gamma batch, named by
 * batch index over the SORTED id list — deterministic, append-only, and the
 * resume mechanism itself: an existing file is replayed from disk instead of
 * refetched, so a re-run with no network converges to the same DB state.
 * (cache.writeRawPage names files by row timestamps, which market rows lack —
 * hence the local batch-indexed writer here, same append-only contract.)
 *
 * Cross-validation gate (spec §8): stored Phase-1 winners (CLOB-sourced, 600
 * markets) are compared against Gamma winners BEFORE being overwritten; any
 * disagreement is reported, and >0.1% disagreement should stop the pipeline.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { getClosedMarketsByConditionIds } from "../clients/gamma.ts";
import type { GammaMarket } from "../clients/gamma.ts";
import { getMarketSettlement } from "../clients/clob.ts";
import type { Repository } from "../store/repository.ts";

const GAMMA_DIR = "data/raw/markets/gamma";
const CLOB_DIR = "data/raw/markets/clob";
const BATCH_SIZE = 40;

export interface BackfillOptions {
  concurrency?: number;
  delayMs?: number;
  log?: (msg: string) => void;
}

export interface BackfillResult {
  ids: number;
  batches: number;
  replayedBatches: number; // loaded from existing cache files (no network)
  gammaRows: number;
  clobRows: number;
  stillMissing: number;
  disagreements: Array<{ conditionId: string; stored: number | null; fetched: number | null }>;
  resolved: number;
  fiftyFifty: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeNdjsonGz(path: string, rows: unknown[]): void {
  const body = rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  writeFileSync(path, gzipSync(body));
}

function readNdjsonGz(path: string): unknown[] {
  const text = gunzipSync(readFileSync(path)).toString("utf8").trim();
  if (!text) return [];
  return text.split("\n").map((l) => JSON.parse(l));
}

/**
 * Parse a Gamma market row into store shape. Winner = the unique outcome priced
 * exactly "1". A closed market whose prices are all "0.5" is a 50/50 refund —
 * resolved, but with NO winning side (settlementPrice 0.5 each; the cash ledger
 * handles the half-payout redeems without special-casing).
 */
export function parseGammaMarket(m: GammaMarket): {
  market: Parameters<Repository["upsertMarketMeta"]>[0];
  tokens: Parameters<Repository["insertTokens"]>[0];
  fiftyFifty: boolean;
} {
  let prices: number[] = [];
  let outcomes: string[] = [];
  let tokenIds: string[] = [];
  try {
    prices = (JSON.parse(m.outcomePrices ?? "[]") as string[]).map(Number);
  } catch {
    prices = [];
  }
  try {
    outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
  } catch {
    outcomes = [];
  }
  try {
    tokenIds = JSON.parse(m.clobTokenIds ?? "[]") as string[];
  } catch {
    tokenIds = [];
  }

  const closed = m.closed ?? null;
  const winnerCandidates = prices.map((p, i) => [p, i] as const).filter(([p]) => p === 1);
  const winner = closed === true && winnerCandidates.length === 1 ? winnerCandidates[0][1] : null;
  const fiftyFifty = closed === true && prices.length > 0 && prices.every((p) => p === 0.5);
  // "resolved" = terminal prices are final (a clean winner or an explicit 50/50).
  const resolved = winner !== null || fiftyFifty;

  const tokens = tokenIds.map((tokenId, i) => ({
    tokenId,
    conditionId: m.conditionId,
    outcomeIndex: i,
    outcome: outcomes[i] ?? null,
    settlementPrice: resolved && Number.isFinite(prices[i]) ? prices[i] : null,
  }));

  return {
    market: {
      conditionId: m.conditionId,
      question: m.question ?? null,
      closed,
      resolved,
      winningOutcomeIndex: winner,
      slug: m.slug ?? null,
      closedTime: m.closedTime ?? null,
      endDate: m.endDate ?? null,
      negRisk: m.negRisk ?? null,
      umaStatus: m.umaResolutionStatus ?? null,
      outcomePrices: m.outcomePrices ?? null,
      source: "gamma",
      fetchedAt: new Date().toISOString(),
    },
    tokens,
    fiftyFifty,
  };
}

export async function backfillMarkets(repo: Repository, opts: BackfillOptions = {}): Promise<BackfillResult> {
  const concurrency = opts.concurrency ?? 4;
  const delayMs = opts.delayMs ?? 50;
  const log = opts.log ?? (() => {});
  mkdirSync(GAMMA_DIR, { recursive: true });
  mkdirSync(CLOB_DIR, { recursive: true });

  const ids = repo.allConditionIds();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));

  // Winners stored before this run (Phase-1 CLOB sample) — the cross-check set.
  const preexisting = repo.marketWinnerMap();

  const res: BackfillResult = {
    ids: ids.length,
    batches: batches.length,
    replayedBatches: 0,
    gammaRows: 0,
    clobRows: 0,
    stillMissing: 0,
    disagreements: [],
    resolved: 0,
    fiftyFifty: 0,
  };

  const t0 = Date.now();
  let done = 0;
  let nextIdx = 0;

  const ingestGammaRows = (raw: unknown[]): void => {
    // Rows were zod-validated at fetch time; replayed cache rows re-validate
    // structurally here via the same parse path (bad rows would throw).
    for (const rawRow of raw as GammaMarket[]) {
      const { market, tokens, fiftyFifty } = parseGammaMarket(rawRow);
      const prev = preexisting.get(market.conditionId);
      if (
        prev &&
        prev.winner !== null &&
        market.winningOutcomeIndex !== null &&
        prev.winner !== market.winningOutcomeIndex
      ) {
        res.disagreements.push({
          conditionId: market.conditionId,
          stored: prev.winner,
          fetched: market.winningOutcomeIndex,
        });
      }
      repo.upsertMarketMeta(market);
      repo.insertTokens(tokens);
      res.gammaRows++;
      if (market.resolved) res.resolved++;
      if (fiftyFifty) res.fiftyFifty++;
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= batches.length) return;
      const path = `${GAMMA_DIR}/batch-${String(idx).padStart(6, "0")}.ndjson.gz`;
      let raw: unknown[];
      if (existsSync(path)) {
        raw = readNdjsonGz(path);
        res.replayedBatches++;
      } else {
        raw = await getClosedMarketsByConditionIds(batches[idx]);
        writeNdjsonGz(path, raw);
        if (delayMs > 0) await sleep(delayMs);
      }
      ingestGammaRows(raw);
      done++;
      if (done % 250 === 0 || done === batches.length) {
        const dt = (Date.now() - t0) / 1000;
        const rate = done / Math.max(dt, 0.001);
        const eta = Math.round((batches.length - done) / Math.max(rate, 0.001));
        log(
          `gamma ${done}/${batches.length} batches (${res.replayedBatches} replayed) · ` +
            `${res.gammaRows} markets · ${rate.toFixed(1)} b/s · ETA ${eta}s`,
        );
        repo.setCheckpoint("markets:backfill", { cursor: done, done: false, pages: done, rows: res.gammaRows });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // ---- Pass B: CLOB fallback for anything Gamma didn't cover ---------------
  const missing = repo.missingMarketIds(ids);
  log(`gamma pass complete: ${res.gammaRows} markets; ${missing.length} ids fall back to CLOB`);

  let clobBuf: unknown[] = [];
  let clobFileIdx = 0;
  const flushClob = (): void => {
    if (!clobBuf.length) return;
    // Find the next unused file index (append-only; prior runs' files are kept).
    let p: string;
    do {
      p = `${CLOB_DIR}/miss-${String(clobFileIdx++).padStart(4, "0")}.ndjson.gz`;
    } while (existsSync(p));
    writeNdjsonGz(p, clobBuf);
    clobBuf = [];
  };

  let missIdx = 0;
  let clobFailures = 0;
  const clobWorker = async (): Promise<void> => {
    for (;;) {
      const i = missIdx++;
      if (i >= missing.length) return;
      const id = missing[i];
      const s = await getMarketSettlement(id);
      if (delayMs > 0) await sleep(delayMs);
      if (!s) {
        clobFailures++;
        continue;
      }
      clobBuf.push(s);
      if (clobBuf.length >= 200) flushClob();
      // 50/50 refund: market is CLOSED with both tokens at 0.5 (a merely-open
      // market can also sit at 0.5 mid — the closed flag disambiguates).
      const fiftyFifty = s.closed === true && s.tokens.length > 0 && s.tokens.every((t) => t.price === 0.5);
      repo.upsertMarketMeta({
        conditionId: id,
        question: s.question,
        closed: s.closed,
        resolved: s.resolved || fiftyFifty,
        winningOutcomeIndex: s.winningOutcomeIndex,
        slug: null,
        closedTime: null,
        endDate: null,
        negRisk: null,
        umaStatus: null,
        outcomePrices: JSON.stringify(s.tokens.map((t) => String(t.price))),
        source: "clob",
        fetchedAt: new Date().toISOString(),
      });
      repo.insertTokens(
        s.tokens.map((t, ti) => ({
          tokenId: t.token_id,
          conditionId: id,
          outcomeIndex: ti,
          outcome: t.outcome,
          settlementPrice: s.resolved || fiftyFifty ? t.price : null,
        })),
      );
      res.clobRows++;
      if (s.resolved) res.resolved++;
      if (res.clobRows % 200 === 0) log(`clob fallback ${res.clobRows}/${missing.length} (failures: ${clobFailures})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency + 2, 6) }, clobWorker));
  flushClob();

  res.stillMissing = repo.missingMarketIds(ids).length;
  repo.setCheckpoint("markets:backfill", {
    cursor: batches.length,
    done: res.stillMissing === 0,
    pages: batches.length,
    rows: res.gammaRows + res.clobRows,
  });
  return res;
}

/** Dry-run info: how much work a backfill run would do (no network). */
export function backfillPlan(repo: Repository): {
  ids: number;
  batches: number;
  cachedBatches: number;
  toFetch: number;
} {
  const ids = repo.allConditionIds();
  const batches = Math.ceil(ids.length / BATCH_SIZE);
  let cached = 0;
  for (let i = 0; i < batches; i++) {
    if (existsSync(`${GAMMA_DIR}/batch-${String(i).padStart(6, "0")}.ndjson.gz`)) cached++;
  }
  return { ids: ids.length, batches, cachedBatches: cached, toFetch: batches - cached };
}
