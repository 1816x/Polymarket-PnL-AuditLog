/**
 * Offline rebuild of the `fills` table from the append-only raw page cache
 * (data/raw/fills/<wallet>/*.ndjson.gz) — no network.
 *
 * Why this exists (Phase 2 finding): the original fills PRIMARY KEY had no
 * occurrence counter, so LEGITIMATE duplicate fills — identical (tx, asset,
 * side, size, price, ts), common in busy 5-minute markets when one taker order
 * crosses several same-size quotes — collapsed under INSERT OR IGNORE. The raw
 * cache preserved the true multiplicity, so the store is rebuilt from it with
 * the seq-augmented PK (see schema.ts).
 *
 * Replay correctness: seq is assigned per raw FILE (= one API page). A tuple
 * appearing k× in a page gets seq 0..k-1; window-overlap refetches of the same
 * rows in another file produce the same seqs and dedup via OR IGNORE, so
 * replaying all files in any order converges to the union.
 */
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Db } from "../store/schema.ts";
import { Repository } from "../store/repository.ts";
import type { Trade } from "../clients/data.ts";

const RAW_FILLS = "data/raw/fills";

export interface RebuildResult {
  wallets: number;
  files: number;
  rawRows: number;
  storedRows: number;
  perWallet: Array<{ wallet: string; files: number; rawRows: number; stored: number; before: number }>;
}

export function rebuildFills(db: Db, log: (m: string) => void = () => {}): RebuildResult {
  const repo = new Repository(db);

  db.exec(`
    DROP TABLE IF EXISTS fills_rebuild;
    CREATE TABLE fills_rebuild (
      wallet       TEXT    NOT NULL,
      tx           TEXT    NOT NULL,
      asset        TEXT    NOT NULL,
      conditionId  TEXT    NOT NULL,
      side         TEXT    NOT NULL,
      size         REAL    NOT NULL,
      price        REAL    NOT NULL,
      ts           INTEGER NOT NULL,
      outcomeIndex INTEGER,
      seq          INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (wallet, tx, asset, side, size, price, ts, seq)
    );
  `);

  const res: RebuildResult = { wallets: 0, files: 0, rawRows: 0, storedRows: 0, perWallet: [] };
  const walletDirs = readdirSync(RAW_FILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const wallet of walletDirs) {
    const before = Number(
      (db.prepare(`SELECT COUNT(*) c FROM fills WHERE wallet = ?`).get(wallet) as { c: number }).c,
    );
    const dir = `${RAW_FILLS}/${wallet}`;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson.gz"));
    let rawRows = 0;
    const t0 = Date.now();
    for (let i = 0; i < files.length; i++) {
      const text = gunzipSync(readFileSync(`${dir}/${files[i]}`)).toString("utf8").trim();
      if (!text) continue;
      const rows = text.split("\n").map((l) => JSON.parse(l)) as Trade[];
      rawRows += rows.length;
      repo.insertFills(wallet, rows, "fills_rebuild");
      if ((i + 1) % 200 === 0 || i + 1 === files.length) {
        const rate = (i + 1) / Math.max((Date.now() - t0) / 1000, 0.001);
        log(`  ${wallet.slice(0, 10)}: ${i + 1}/${files.length} files (${rawRows} raw rows, ${rate.toFixed(1)} f/s)`);
      }
    }
    const stored = Number(
      (db.prepare(`SELECT COUNT(*) c FROM fills_rebuild WHERE wallet = ?`).get(wallet) as { c: number }).c,
    );
    res.perWallet.push({ wallet, files: files.length, rawRows, stored, before });
    res.wallets++;
    res.files += files.length;
    res.rawRows += rawRows;
    res.storedRows += stored;
    // Keep the resume-state row count honest.
    const cp = repo.getCheckpoint(`fills:${wallet}`);
    if (cp) repo.setCheckpoint(`fills:${wallet}`, { ...cp, rows: stored });
  }

  log("swapping tables (drop old fills → rename → reindex)…");
  db.exec(`
    DROP TABLE fills;
    ALTER TABLE fills_rebuild RENAME TO fills;
    CREATE INDEX IF NOT EXISTS idx_fills_wallet_ts ON fills (wallet, ts);
    CREATE INDEX IF NOT EXISTS idx_fills_cond      ON fills (conditionId);
  `);
  return res;
}
