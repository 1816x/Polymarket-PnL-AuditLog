/**
 * Local SQLite store (built-in `node:sqlite`, no native dependency).
 *
 * This is the DERIVED, queryable index over the append-only raw page cache in
 * data/raw. The raw cache is the source of truth (spec §2); this store is
 * reproducible from it and exists for fast aggregate queries + idempotent dedup.
 *
 * Idempotency (spec §5): every row table uses a natural-key PRIMARY KEY and loads
 * happen via INSERT OR IGNORE, so re-running ingest never duplicates rows.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DB_PATH = "data/audit.db";

export type Db = DatabaseSync;

export function openDb(path: string = DB_PATH): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS fills (
      wallet       TEXT    NOT NULL,
      tx           TEXT    NOT NULL,
      asset        TEXT    NOT NULL,
      conditionId  TEXT    NOT NULL,
      side         TEXT    NOT NULL,
      size         REAL    NOT NULL,
      price        REAL    NOT NULL,
      ts           INTEGER NOT NULL,
      outcomeIndex INTEGER,
      PRIMARY KEY (wallet, tx, asset, side, size, price, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_fills_wallet_ts ON fills (wallet, ts);
    CREATE INDEX IF NOT EXISTS idx_fills_cond      ON fills (conditionId);

    CREATE TABLE IF NOT EXISTS activity (
      wallet       TEXT    NOT NULL,
      type         TEXT    NOT NULL,
      ts           INTEGER NOT NULL,
      conditionId  TEXT,
      tx           TEXT,
      asset        TEXT,
      usdcSize     REAL,
      size         REAL,
      outcomeIndex INTEGER,
      PRIMARY KEY (wallet, type, ts, conditionId, tx, usdcSize)
    );
    CREATE INDEX IF NOT EXISTS idx_activity_wallet_type ON activity (wallet, type);

    CREATE TABLE IF NOT EXISTS markets (
      conditionId         TEXT PRIMARY KEY,
      question            TEXT,
      closed              INTEGER,
      resolved            INTEGER,
      winningOutcomeIndex INTEGER,
      fetchedAt           TEXT
    );

    -- Resume state: one row per (dataset:wallet) ingest stream.
    CREATE TABLE IF NOT EXISTS checkpoints (
      key       TEXT PRIMARY KEY,
      cursor    INTEGER,
      done      INTEGER DEFAULT 0,
      pages     INTEGER DEFAULT 0,
      rows      INTEGER DEFAULT 0,
      updatedAt TEXT
    );
  `);
  return db;
}
