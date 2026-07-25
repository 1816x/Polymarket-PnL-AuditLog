/**
 * Data access over the SQLite store. NO business logic — just typed reads/writes
 * (spec §4). Inserts are idempotent (INSERT OR IGNORE on natural keys).
 */
import type { Db } from "./schema.ts";
import type { Trade, Activity } from "../clients/data.ts";

export interface Checkpoint {
  cursor: number | null;
  done: boolean;
  pages: number;
  rows: number;
}

export class Repository {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Insert a page of fills in one transaction. Returns count of NEW rows.
   * `seq` is the occurrence index of an identical (tx, asset, side, size,
   * price, ts) tuple WITHIN this batch — the batch must therefore be one whole
   * API page (or one whole raw-cache file, which is the same thing), never a
   * sub-chunk, or true duplicates would collapse.
   */
  insertFills(wallet: string, rows: Trade[], targetTable = "fills"): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO ${targetTable} (wallet, tx, asset, conditionId, side, size, price, ts, outcomeIndex, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const occurrence = new Map<string, number>();
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const key = `${r.transactionHash}|${r.asset}|${r.side}|${r.size}|${r.price}|${r.timestamp}`;
        const seq = occurrence.get(key) ?? 0;
        occurrence.set(key, seq + 1);
        const res = stmt.run(
          wallet,
          r.transactionHash,
          r.asset,
          r.conditionId,
          r.side,
          r.size,
          r.price,
          r.timestamp,
          r.outcomeIndex ?? null,
          seq,
        );
        inserted += Number(res.changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return inserted;
  }

  /** Insert a page of activity rows in one transaction. Returns count of NEW rows. */
  insertActivity(wallet: string, rows: Activity[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO activity (wallet, type, ts, conditionId, tx, asset, usdcSize, size, outcomeIndex)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const res = stmt.run(
          wallet,
          r.type,
          r.timestamp,
          r.conditionId ?? "",
          r.transactionHash ?? "",
          r.asset ?? null,
          r.usdcSize ?? 0,
          r.size ?? null,
          r.outcomeIndex ?? null,
        );
        inserted += Number(res.changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return inserted;
  }

  upsertMarket(m: {
    conditionId: string;
    question: string | null;
    closed: boolean | null;
    resolved: boolean;
    winningOutcomeIndex: number | null;
    fetchedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO markets (conditionId, question, closed, resolved, winningOutcomeIndex, fetchedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.conditionId,
        m.question,
        m.closed === null ? null : m.closed ? 1 : 0,
        m.resolved ? 1 : 0,
        m.winningOutcomeIndex,
        m.fetchedAt,
      );
  }

  /** Upsert full market metadata (Phase 2 backfill; replaces the Phase-1 sample row if present). */
  upsertMarketMeta(m: {
    conditionId: string;
    question: string | null;
    closed: boolean | null;
    resolved: boolean;
    winningOutcomeIndex: number | null;
    slug: string | null;
    closedTime: string | null;
    endDate: string | null;
    negRisk: boolean | null;
    umaStatus: string | null;
    outcomePrices: string | null;
    source: "gamma" | "clob";
    fetchedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO markets
           (conditionId, question, closed, resolved, winningOutcomeIndex,
            slug, closedTime, endDate, negRisk, umaStatus, outcomePrices, source, fetchedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.conditionId,
        m.question,
        m.closed === null ? null : m.closed ? 1 : 0,
        m.resolved ? 1 : 0,
        m.winningOutcomeIndex,
        m.slug,
        m.closedTime,
        m.endDate,
        m.negRisk === null ? null : m.negRisk ? 1 : 0,
        m.umaStatus,
        m.outcomePrices,
        m.source,
        m.fetchedAt,
      );
  }

  /** Upsert outcome-token rows for one market (2 per binary market). */
  insertTokens(
    rows: Array<{
      tokenId: string;
      conditionId: string;
      outcomeIndex: number;
      outcome: string | null;
      settlementPrice: number | null;
    }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO tokens (tokenId, conditionId, outcomeIndex, outcome, settlementPrice)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const t of rows) stmt.run(t.tokenId, t.conditionId, t.outcomeIndex, t.outcome, t.settlementPrice);
  }

  /** All distinct conditionIds across fills ∪ activity, sorted (deterministic batch order). */
  allConditionIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT conditionId FROM fills
         UNION
         SELECT conditionId FROM activity WHERE conditionId IS NOT NULL AND conditionId <> ''
         ORDER BY 1`,
      )
      .all() as Array<{ conditionId: string }>;
    return rows.map((r) => r.conditionId);
  }

  /** Map conditionId -> {winningOutcomeIndex, source} for all stored resolved markets. */
  marketWinnerMap(): Map<string, { winner: number | null; source: string | null }> {
    const rows = this.db
      .prepare(`SELECT conditionId, winningOutcomeIndex w, source FROM markets WHERE resolved = 1`)
      .all() as Array<{ conditionId: string; w: number | null; source: string | null }>;
    return new Map(rows.map((r) => [r.conditionId, { winner: r.w, source: r.source }]));
  }

  /** ConditionIds (from the given list) that have no row in `markets` yet. */
  missingMarketIds(ids: string[]): string[] {
    const have = new Set(
      (this.db.prepare(`SELECT conditionId FROM markets`).all() as Array<{ conditionId: string }>).map(
        (r) => r.conditionId,
      ),
    );
    return ids.filter((id) => !have.has(id));
  }

  // --- checkpoints -------------------------------------------------------
  getCheckpoint(key: string): Checkpoint | null {
    const row = this.db.prepare(`SELECT cursor, done, pages, rows FROM checkpoints WHERE key = ?`).get(key) as
      | { cursor: number | null; done: number; pages: number; rows: number }
      | undefined;
    if (!row) return null;
    return { cursor: row.cursor, done: !!row.done, pages: row.pages, rows: row.rows };
  }

  setCheckpoint(key: string, cp: Checkpoint): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (key, cursor, done, pages, rows, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, cp.cursor, cp.done ? 1 : 0, cp.pages, cp.rows, new Date().toISOString());
  }

  // --- report queries ----------------------------------------------------
  fillCount(wallet: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) c FROM fills WHERE wallet = ?`).get(wallet) as { c: number }).c);
  }

  distinctMarkets(wallet: string): number {
    return Number(
      (this.db.prepare(`SELECT COUNT(DISTINCT conditionId) c FROM fills WHERE wallet = ?`).get(wallet) as { c: number })
        .c,
    );
  }

  dateRange(wallet: string): { min: number; max: number } | null {
    const r = this.db.prepare(`SELECT MIN(ts) mn, MAX(ts) mx FROM fills WHERE wallet = ?`).get(wallet) as {
      mn: number | null;
      mx: number | null;
    };
    return r.mn === null ? null : { min: r.mn, max: r.mx as number };
  }

  sideCounts(wallet: string): { buy: number; sell: number } {
    const rows = this.db
      .prepare(`SELECT side, COUNT(*) c FROM fills WHERE wallet = ? GROUP BY side`)
      .all(wallet) as Array<{ side: string; c: number }>;
    let buy = 0;
    let sell = 0;
    for (const r of rows) {
      if (r.side.toUpperCase() === "BUY") buy = Number(r.c);
      else if (r.side.toUpperCase() === "SELL") sell = Number(r.c);
    }
    return { buy, sell };
  }

  activityTypeCounts(wallet: string): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT type, COUNT(*) c FROM activity WHERE wallet = ? GROUP BY type`)
      .all(wallet) as Array<{ type: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.type] = Number(r.c);
    return out;
  }

  rebateTotal(wallet: string): number {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(usdcSize),0) s FROM activity WHERE wallet = ? AND type IN ('REWARD','MAKER_REBATE','TAKER_REBATE')`,
      )
      .get(wallet) as { s: number };
    return Number(r.s);
  }

  /** Distinct conditionIds for a wallet (for settlement sampling). */
  marketIds(wallet: string, limit?: number): string[] {
    const sql = `SELECT DISTINCT conditionId FROM fills WHERE wallet = ?` + (limit ? ` LIMIT ${limit}` : "");
    return (this.db.prepare(sql).all(wallet) as Array<{ conditionId: string }>).map((r) => r.conditionId);
  }
}
