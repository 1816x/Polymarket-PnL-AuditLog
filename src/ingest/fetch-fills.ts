/**
 * Ingest ALL fills for a wallet via /trades (takerOnly=false), 10k rows/page,
 * end-cursor pagination, append-only raw cache + idempotent SQLite load, resumable.
 */
import { getTrades } from "../clients/data.ts";
import type { Trade } from "../clients/data.ts";
import type { Repository } from "../store/repository.ts";
import { endCursorIngest } from "./paginate.ts";
import type { PaginateResult } from "./paginate.ts";

const PAGE_LIMIT = 10_000; // Data API clamps /trades at 10k

export function ingestFills(
  repo: Repository,
  wallet: string,
  opts: { maxPages: number; delayMs: number; log: (m: string) => void },
): Promise<PaginateResult> {
  return endCursorIngest({
    dataset: "fills",
    wallet,
    repo,
    pageLimit: PAGE_LIMIT,
    maxPages: opts.maxPages,
    delayMs: opts.delayMs,
    fetchPage: (end, limit) => getTrades({ user: wallet, takerOnly: false, end, limit }),
    insert: (w, rows) => repo.insertFills(w, rows as Trade[]),
    log: opts.log,
  });
}
