/**
 * Ingest NON-TRADE activity for a wallet via /activity (REDEEM/MERGE/SPLIT/
 * CONVERSION/REWARD/MAKER_REBATE/TAKER_REBATE), 500 rows/page, end-cursor paging.
 *
 * We deliberately exclude TRADE rows here — fills come from /trades far more
 * efficiently (10k/page vs 500). These rows carry settlement (REDEEM), position
 * mechanics (SPLIT/MERGE/CONVERSION), and — crucially for H2 — measured rebates.
 */
import { getActivity } from "../clients/data.ts";
import type { Activity } from "../clients/data.ts";
import type { Repository } from "../store/repository.ts";
import { endCursorIngest } from "./paginate.ts";
import type { PaginateResult } from "./paginate.ts";

const PAGE_LIMIT = 500; // Data API caps /activity at 500
const NON_TRADE_TYPES = "REDEEM,MERGE,SPLIT,CONVERSION,REWARD,MAKER_REBATE,TAKER_REBATE";

export function ingestActivity(
  repo: Repository,
  wallet: string,
  opts: { maxPages: number; delayMs: number; log: (m: string) => void },
): Promise<PaginateResult> {
  return endCursorIngest({
    dataset: "activity",
    wallet,
    repo,
    pageLimit: PAGE_LIMIT,
    maxPages: opts.maxPages,
    delayMs: opts.delayMs,
    fetchPage: (end, limit) => getActivity({ user: wallet, end, limit, type: NON_TRADE_TYPES }),
    insert: (w, rows) => repo.insertActivity(w, rows as Activity[]),
    log: opts.log,
  });
}
