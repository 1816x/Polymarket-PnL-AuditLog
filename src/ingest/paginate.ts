/**
 * Generic end-cursor time pagination for the Data API.
 *
 * We do NOT use offset paging — the Data API caps offset (~5–10k), which cannot
 * reach a wallet's full history. Instead we walk backward in time using the `end`
 * timestamp as a cursor: fetch a page (sorted newest-first), advance the cursor to
 * the oldest ts in the page, repeat. The cursor is INCLUSIVE and rows are deduped
 * (INSERT OR IGNORE), so a same-second boundary never drops a fill; a stall guard
 * covers the (implausible) case of more than one full page sharing one second.
 *
 * Progress is checkpointed after every page, so an interrupted run resumes without
 * re-requesting anything already committed (spec §2).
 */
import type { Repository, Checkpoint } from "../store/repository.ts";
import { writeRawPage } from "./cache.ts";

export interface PaginateOptions {
  dataset: string; // "fills" | "activity" — cache subdir + checkpoint key
  wallet: string;
  repo: Repository;
  pageLimit: number;
  maxPages: number;
  delayMs: number;
  fetchPage: (end: number | undefined, limit: number) => Promise<Array<{ timestamp: number }>>;
  insert: (wallet: string, rows: unknown[]) => number;
  log: (msg: string) => void;
}

export interface PaginateResult {
  pages: number;
  rows: number;
  done: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function endCursorIngest(opts: PaginateOptions): Promise<PaginateResult> {
  const key = `${opts.dataset}:${opts.wallet}`;
  const cp: Checkpoint = opts.repo.getCheckpoint(key) ?? { cursor: null, done: false, pages: 0, rows: 0 };
  if (cp.done) {
    opts.log(`  ${key}: already complete (${cp.rows} rows, ${cp.pages} pages) — skipping`);
    return { pages: cp.pages, rows: cp.rows, done: true };
  }

  let cursor: number | undefined = cp.cursor ?? undefined;
  let pages = cp.pages;
  let rows = cp.rows;
  let pagesThisRun = 0;

  while (pagesThisRun < opts.maxPages) {
    const batch = await opts.fetchPage(cursor, opts.pageLimit);
    if (batch.length === 0) {
      opts.repo.setCheckpoint(key, { cursor: cursor ?? null, done: true, pages, rows });
      opts.log(`  ${key}: done (empty page). total ${rows} rows in ${pages} pages`);
      return { pages, rows, done: true };
    }

    writeRawPage(opts.dataset, opts.wallet, batch);
    const inserted = opts.insert(opts.wallet, batch);
    const minTs = Math.min(...batch.map((r) => r.timestamp));

    pages++;
    pagesThisRun++;
    rows += inserted;

    // Advance cursor (inclusive). Stall guard: if we didn't move and nothing new
    // was inserted, one second holds > pageLimit rows — skip it to avoid a loop.
    let nextCursor = minTs;
    if (cursor !== undefined && nextCursor === cursor && inserted === 0) {
      opts.log(`  ${key}: ⚠ >${opts.pageLimit} rows at ts=${minTs}; skipping that second`);
      nextCursor = cursor - 1;
    }
    cursor = nextCursor;

    opts.repo.setCheckpoint(key, { cursor, done: false, pages, rows });

    if (pages % 10 === 0 || batch.length < opts.pageLimit) {
      const d = new Date(minTs * 1000).toISOString().slice(0, 16);
      opts.log(`  ${key}: page ${pages} (+${inserted}), ${rows} rows, back to ${d}`);
    }

    if (batch.length < opts.pageLimit) {
      opts.repo.setCheckpoint(key, { cursor, done: true, pages, rows });
      opts.log(`  ${key}: done (short page). total ${rows} rows in ${pages} pages`);
      return { pages, rows, done: true };
    }
    if (opts.delayMs) await sleep(opts.delayMs);
  }

  opts.log(`  ${key}: paused after ${pagesThisRun} pages (maxPages). resume to continue. ${rows} rows so far`);
  return { pages, rows, done: false };
}

/**
 * Top-up: fetch NEW rows from "now" backward until reaching `stopAtTs` (the
 * store's previous coverage edge, minus an overlap margin). Used to extend a
 * completed stream to a fresh snapshot instant. No checkpointing — runs are
 * small and fully idempotent (raw pages are append-only; inserts dedup), so an
 * interrupted top-up is simply re-run.
 */
export async function topUpIngest(
  opts: Omit<PaginateOptions, "maxPages"> & { stopAtTs: number },
): Promise<PaginateResult> {
  const key = `${opts.dataset}:${opts.wallet} (top-up)`;
  let cursor: number | undefined = undefined;
  let pages = 0;
  let rows = 0;
  for (;;) {
    const batch = await opts.fetchPage(cursor, opts.pageLimit);
    if (batch.length === 0) break;
    writeRawPage(opts.dataset, opts.wallet, batch);
    rows += opts.insert(opts.wallet, batch);
    pages++;
    const minTs = Math.min(...batch.map((r) => r.timestamp));
    if (minTs <= opts.stopAtTs || batch.length < opts.pageLimit) break;
    cursor = minTs === cursor ? minTs - 1 : minTs; // same stall guard as the main walk
    if (opts.delayMs) await sleep(opts.delayMs);
  }
  opts.log(`  ${key}: +${rows} new rows in ${pages} pages (down to stopAt=${opts.stopAtTs})`);
  return { pages, rows, done: true };
}
