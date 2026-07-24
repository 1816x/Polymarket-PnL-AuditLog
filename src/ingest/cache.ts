/**
 * Append-only raw page cache (spec §2): every raw API page is written to disk,
 * gzipped, one file per page, and NEVER overwritten. This is the reproducible
 * source of truth; the SQLite store is derived from it. Files are named by the
 * timestamp range they cover so the cache is self-describing and ordered.
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const RAW_ROOT = "data/raw";

/** Write one page of raw rows as gzipped NDJSON. Returns the path (or null if empty). */
export function writeRawPage(dataset: string, wallet: string, rows: unknown[]): string | null {
  if (rows.length === 0) return null;
  const dir = `${RAW_ROOT}/${dataset}/${wallet}`;
  mkdirSync(dir, { recursive: true });
  const tsList = rows
    .map((r) => (r as { timestamp?: number }).timestamp ?? 0)
    .filter((n) => typeof n === "number");
  const maxTs = tsList.length ? Math.max(...tsList) : 0;
  const minTs = tsList.length ? Math.min(...tsList) : 0;
  // Include row count to keep the name unique even if two pages share a ts range.
  let path = `${dir}/${maxTs}-${minTs}-${rows.length}.ndjson.gz`;
  let n = 0;
  while (existsSync(path)) path = `${dir}/${maxTs}-${minTs}-${rows.length}.${++n}.ndjson.gz`;
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, gzipSync(ndjson));
  return path;
}
