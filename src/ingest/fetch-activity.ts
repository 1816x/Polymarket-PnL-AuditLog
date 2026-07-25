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
import { endCursorIngest, topUpIngest } from "./paginate.ts";
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

/**
 * Extend a completed activity stream to now. IMPORTANT: in a top-up, run this
 * BEFORE topUpFills for the same wallet — with the activity cutoff ≤ the fills
 * cutoff, a market closing between the two has complete fills and (at worst) a
 * not-yet-fetched redeem, which the engine prices via residValue at settlement.
 * The reverse order fabricates redeem cash without its fills (phantom inflows —
 * exactly the Phase-1 artifact this fixes).
 */
export function topUpActivity(
  repo: Repository,
  wallet: string,
  stopAtTs: number,
  opts: { delayMs: number; log: (m: string) => void },
): Promise<PaginateResult> {
  return topUpIngest({
    dataset: "activity",
    wallet,
    repo,
    pageLimit: PAGE_LIMIT,
    delayMs: opts.delayMs,
    stopAtTs,
    fetchPage: (end, limit) => getActivity({ user: wallet, end, limit, type: NON_TRADE_TYPES }),
    insert: (w, rows) => repo.insertActivity(w, rows as Activity[]),
    log: opts.log,
  });
}
