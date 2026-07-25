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
    -- seq disambiguates LEGITIMATE duplicate fills: one tx can contain several
    -- fills with identical (asset, side, size, price, ts) — e.g. one taker order
    -- crossing two same-size maker quotes. seq = occurrence index of the
    -- identical tuple within one API page, so INSERT OR IGNORE still dedups
    -- window-overlap refetches while preserving true multiplicity. (Phase 2
    -- finding: the original PK without seq silently dropped ~226 rows in a
    -- single busy 5-minute market.)
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
      seq          INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (wallet, tx, asset, side, size, price, ts, seq)
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

    -- Outcome-token map: fills.asset -> (conditionId, outcomeIndex). This is the
    -- robust outcome join (fills.outcomeIndex can be the 999 enrichment-lag
    -- placeholder). settlementPrice is the terminal $ value of one share (1/0,
    -- or 0.5 on a 50/50 refund), NULL while the market is unresolved.
    CREATE TABLE IF NOT EXISTS tokens (
      tokenId         TEXT PRIMARY KEY,
      conditionId     TEXT NOT NULL,
      outcomeIndex    INTEGER NOT NULL,
      outcome         TEXT,
      settlementPrice REAL
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_cond ON tokens (conditionId);

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
  migrateMarketsColumns(db);
  return db;
}

/**
 * Additive column migration for `markets` (Phase 2 metadata backfill). SQLite has
 * no ADD COLUMN IF NOT EXISTS, so check PRAGMA table_info. Existing Phase-1 rows
 * (CLOB-sourced settlement sample) are preserved — they serve as a cross-check
 * set against the Gamma backfill before being overwritten.
 */
function migrateMarketsColumns(db: DatabaseSync): void {
  const have = new Set(
    (db.prepare(`PRAGMA table_info(markets)`).all() as Array<{ name: string }>).map((r) => r.name),
  );
  const want: Array<[string, string]> = [
    ["slug", "TEXT"],
    ["closedTime", "TEXT"], // e.g. "2026-03-30 20:05:33+00" (Gamma)
    ["endDate", "TEXT"],
    ["negRisk", "INTEGER"],
    ["umaStatus", "TEXT"],
    ["outcomePrices", "TEXT"], // raw JSON-encoded array, e.g. '["1", "0"]'
    ["source", "TEXT"], // 'gamma' | 'clob'
  ];
  for (const [col, type] of want) {
    if (!have.has(col)) db.exec(`ALTER TABLE markets ADD COLUMN ${col} ${type}`);
  }
}
