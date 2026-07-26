/**
 * Phase 3 / H2 — fetch the TAKER SUBSET of fills for a deterministic sample of
 * markets via `/trades?user&market&takerOnly=true` (verified live: the flag is
 * honored with a market filter; a full fill set minus this subset = the maker
 * fills, since we already hold every fill locally).
 *
 * Raw cache: one gzipped NDJSON file per (wallet, market) —
 * data/raw/taker/<wallet>/<conditionId>.ndjson.gz. File existence = resume
 * (replayed offline instead of refetched), matching fetch-markets.ts.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { getTrades } from "../clients/data.ts";
import type { Trade } from "../clients/data.ts";
import type { Repository } from "../store/repository.ts";
import type { SampledMarket } from "../analysis/sampling.ts";

const RAW_DIR = "data/raw/taker";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TakerIngestResult {
  markets: number;
  replayed: number;
  takerRows: number;
  fullPages: number; // markets that needed cursor-walking beyond one page
  failed: number; // markets skipped after retries (refetched on the next run)
}

// Modest page size: 10k-row pages triggered sustained 429s at any concurrency;
// taker subsets rarely exceed a few hundred rows per market anyway.
const PAGE_LIMIT = 2_000;

async function fetchMarketTakerFills(wallet: string, conditionId: string): Promise<{ rows: Trade[]; walked: boolean }> {
  const rows = await getTrades({ user: wallet, conditionId, takerOnly: true, limit: PAGE_LIMIT });
  if (rows.length < PAGE_LIMIT) return { rows, walked: false };
  const all = [...rows];
  let end = Math.min(...rows.map((r) => r.timestamp));
  for (;;) {
    const page = await getTrades({ user: wallet, conditionId, takerOnly: true, limit: PAGE_LIMIT, end });
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    const minTs = Math.min(...page.map((r) => r.timestamp));
    end = minTs === end ? end - 1 : minTs;
  }
  return { rows: all, walked: true };
}

export async function ingestTakerFills(
  repo: Repository,
  sample: SampledMarket[],
  opts: { concurrency?: number; delayMs?: number; log?: (m: string) => void } = {},
): Promise<TakerIngestResult> {
  const concurrency = opts.concurrency ?? 4;
  const delayMs = opts.delayMs ?? 60;
  const log = opts.log ?? (() => {});
  const res: TakerIngestResult = { markets: 0, replayed: 0, takerRows: 0, fullPages: 0, failed: 0 };
  const t0 = Date.now();
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= sample.length) return;
      const s = sample[i];
      const dir = `${RAW_DIR}/${s.wallet}`;
      mkdirSync(dir, { recursive: true });
      const path = `${dir}/${s.conditionId}.ndjson.gz`;
      let rows: Trade[];
      if (existsSync(path)) {
        const text = gunzipSync(readFileSync(path)).toString("utf8").trim();
        rows = text ? (text.split("\n").map((l) => JSON.parse(l)) as Trade[]) : [];
        res.replayed++;
      } else {
        try {
          const fetched = await fetchMarketTakerFills(s.wallet, s.conditionId);
          rows = fetched.rows;
          if (fetched.walked) res.fullPages++;
        } catch (e) {
          // A market that exhausts the HTTP retries (rate-limit bursts) is
          // skipped, NOT fatal — no cache file is written, so the next run
          // refetches it. Back off harder before continuing.
          res.failed++;
          log(`  ⚠ ${s.conditionId.slice(0, 14)}… skipped (${e instanceof Error ? e.message.slice(0, 60) : e}); will refetch on next run`);
          await sleep(3_000);
          continue;
        }
        writeFileSync(path, gzipSync(rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : ""));
        if (delayMs > 0) await sleep(delayMs);
      }
      // Whole file = whole page set for this market → seq semantics hold.
      repo.insertFills(s.wallet, rows, "taker_fills");
      res.takerRows += rows.length;
      res.markets++;
      if (res.markets % 200 === 0 || res.markets === sample.length) {
        const rate = res.markets / Math.max((Date.now() - t0) / 1000, 0.001);
        log(
          `taker ${res.markets}/${sample.length} markets (${res.replayed} replayed) · ` +
            `${res.takerRows} taker rows · ${rate.toFixed(1)} mkt/s · ETA ${Math.round((sample.length - res.markets) / Math.max(rate, 0.001))}s`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return res;
}
