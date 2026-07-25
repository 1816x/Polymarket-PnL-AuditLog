/**
 * Phase 2 — PnL engine. Builds three derived tables from the ingested base
 * tables (fills, activity, markets, tokens) and computes per-wallet summaries.
 *
 * Core accounting identity (validated against raw data in the Phase-2 probes):
 *
 *   cashPnl(wallet, market) = Σ REDEEM.usdcSize + Σ MERGE.usdcSize
 *                           + Σ sell proceeds − Σ buy cost
 *
 * Everything is realized CASH visible in the public feeds. No estimates enter
 * these numbers: rebates are wallet-level rows (no conditionId) reported as a
 * separate line, and any CLOB taker fees invisible to the public feeds are
 * Phase 3's job to measure on-chain (external reconciliation bounds them here).
 *
 * Facts the SQL below encodes (all verified against the real store):
 *  - Only activity types present: MERGE, REDEEM, MAKER_REBATE, TAKER_REBATE,
 *    REWARD. No SPLIT/CONVERSION rows exist for these wallets.
 *  - Zero-usdc REDEEM rows also have size=0 (no-op dust) — plain SUMs are safe.
 *  - REDEEM rows with usdcSize>0 carry the WINNING outcomeIndex; losing-side
 *    burns are never recorded with a size, so per-outcome share residuals are
 *    only meaningful on the winning side (the losing side's residual is real
 *    inventory but worth exactly $0 at settlement).
 *  - fills.outcomeIndex can be 999 (enrichment-lag placeholder, 7 rows) — the
 *    tokens table (asset → outcomeIndex) is the authoritative outcome join.
 *  - MERGE burns one share of EACH side per $1 returned (mergeQty applies to
 *    both outcome columns when computing residuals).
 */
import type { Db } from "../store/schema.ts";

export interface BuildStats {
  positions: number;
  settlements: number;
  marketPnl: number;
  seconds: number;
}

/** (Re)build positions, settlements and market_pnl. Idempotent: DROP + CREATE. */
export function buildDerived(db: Db, log: (m: string) => void = () => {}): BuildStats {
  const t0 = Date.now();
  const count = (t: string) =>
    Number((db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c);

  // ---- positions: per (wallet, market, outcome) fill aggregates -----------
  // Streaming aggregation in JS over chunked rowid scans. A plain SQL GROUP BY
  // over ~20M rows needs a multi-GB temp b-tree, which does not fit the disk
  // headroom next to the (freelist-bloated) main DB file — whereas the final
  // aggregate is only ~600k groups, and the new tables reuse the DB's own
  // freelist pages. Outcome mapping per fill: tokens.outcomeIndex by asset
  // (authoritative), else the fill's own 0/1 (999 placeholders excluded),
  // else NULL.
  log("building positions (streaming fills aggregation)…");
  db.exec(`
    DROP TABLE IF EXISTS pos_raw;
    DROP TABLE IF EXISTS positions;
    CREATE TABLE positions (
      wallet TEXT NOT NULL, conditionId TEXT NOT NULL, oi INTEGER,
      buyQty REAL NOT NULL, buyCost REAL NOT NULL,
      sellQty REAL NOT NULL, sellProceeds REAL NOT NULL,
      fillCount INTEGER NOT NULL, firstTs INTEGER, lastTs INTEGER
    );
  `);
  const tokOi = new Map<string, number>();
  for (const t of db.prepare(`SELECT tokenId, outcomeIndex FROM tokens`).all() as Array<{
    tokenId: string;
    outcomeIndex: number;
  }>) {
    tokOi.set(t.tokenId, t.outcomeIndex);
  }
  type Agg = [number, number, number, number, number, number, number]; // buyQty, buyCost, sellQty, sellProceeds, n, minTs, maxTs
  const groups = new Map<string, Agg>();
  const CHUNK = 250_000;
  const chunkStmt = db.prepare(
    `SELECT rowid rid, wallet, conditionId, asset, side, size, price, ts, outcomeIndex
     FROM fills WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`,
  );
  let lastRid = -1;
  let scanned = 0;
  for (;;) {
    const chunk = chunkStmt.all(lastRid) as Array<{
      rid: number;
      wallet: string;
      conditionId: string;
      asset: string;
      side: string;
      size: number;
      price: number;
      ts: number;
      outcomeIndex: number | null;
    }>;
    if (chunk.length === 0) break;
    for (const f of chunk) {
      const oi = tokOi.get(f.asset) ?? (f.outcomeIndex === 0 || f.outcomeIndex === 1 ? f.outcomeIndex : null);
      const key = `${f.wallet}|${f.conditionId}|${oi ?? "x"}`;
      let g = groups.get(key);
      if (!g) {
        g = [0, 0, 0, 0, 0, f.ts, f.ts];
        groups.set(key, g);
      }
      if (f.side === "BUY") {
        g[0] += f.size;
        g[1] += f.size * f.price;
      } else {
        g[2] += f.size;
        g[3] += f.size * f.price;
      }
      g[4]++;
      if (f.ts < g[5]) g[5] = f.ts;
      if (f.ts > g[6]) g[6] = f.ts;
    }
    lastRid = chunk[chunk.length - 1].rid;
    scanned += chunk.length;
    if (scanned % 2_000_000 < CHUNK) log(`  …scanned ${scanned.toLocaleString("en-US")} fills, ${groups.size} groups`);
  }
  const insPos = db.prepare(`INSERT INTO positions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  for (const [key, g] of groups) {
    const sep1 = key.indexOf("|");
    const sep2 = key.indexOf("|", sep1 + 1);
    const oiStr = key.slice(sep2 + 1);
    insPos.run(
      key.slice(0, sep1),
      key.slice(sep1 + 1, sep2),
      oiStr === "x" ? null : Number(oiStr),
      g[0], g[1], g[2], g[3], g[4], g[5], g[6],
    );
  }
  db.exec("COMMIT");
  groups.clear();
  db.exec(`CREATE INDEX idx_positions_wc ON positions (wallet, conditionId);`);
  const nPos = count("positions");
  log(`  positions: ${nPos} rows (from ${scanned.toLocaleString("en-US")} fills scanned)`);

  // ---- settlements: per (wallet, market) cash-out aggregates --------------
  log("building settlements (aggregating activity)…");
  db.exec(`
    DROP TABLE IF EXISTS settlements;
    CREATE TABLE settlements AS
    SELECT wallet, conditionId,
           SUM(CASE WHEN type = 'MERGE'  THEN usdcSize ELSE 0 END) mergeCash,
           SUM(CASE WHEN type = 'MERGE'  THEN size     ELSE 0 END) mergeQty,
           SUM(CASE WHEN type = 'REDEEM' THEN usdcSize ELSE 0 END) redeemCash,
           SUM(CASE WHEN type = 'REDEEM' THEN size     ELSE 0 END) redeemQty,
           MAX(CASE WHEN type = 'REDEEM' AND usdcSize > 0 AND outcomeIndex IN (0, 1)
                    THEN outcomeIndex END)                          redeemWinnerIdx,
           MAX(CASE WHEN type = 'REDEEM' THEN ts END)               lastRedeemTs,
           MAX(CASE WHEN type = 'MERGE'  THEN ts END)               lastMergeTs
    FROM activity
    WHERE type IN ('MERGE', 'REDEEM') AND conditionId IS NOT NULL AND conditionId <> ''
    GROUP BY 1, 2;
    CREATE INDEX idx_settlements_wc ON settlements (wallet, conditionId);
  `);
  const nSet = count("settlements");
  log(`  settlements: ${nSet} rows`);

  // ---- market_pnl: the per-(wallet × market) ledger ------------------------
  // Winner precedence: metadata (gamma/clob) over redeem-inference; both are
  // kept and compared (winnerAgree). Residuals attribute redeemQty to the
  // winning side only (see file header). residValue prices any leftover shares
  // at their settlement price — computable only when token prices are known.
  log("building market_pnl (join + classify)…");
  db.exec(`
    DROP TABLE IF EXISTS market_pnl;
    CREATE TABLE market_pnl AS
    WITH pos2 AS (
      SELECT wallet, conditionId,
             SUM(CASE WHEN oi = 0 THEN buyQty  ELSE 0 END) buyQty0,
             SUM(CASE WHEN oi = 1 THEN buyQty  ELSE 0 END) buyQty1,
             SUM(CASE WHEN oi IS NULL THEN buyQty ELSE 0 END) buyQtyUnk,
             SUM(CASE WHEN oi = 0 THEN buyCost ELSE 0 END) buyCost0,
             SUM(CASE WHEN oi = 1 THEN buyCost ELSE 0 END) buyCost1,
             SUM(buyQty)  buyQty,
             SUM(buyCost) buyCost,
             SUM(CASE WHEN oi = 0 THEN sellQty ELSE 0 END) sellQty0,
             SUM(CASE WHEN oi = 1 THEN sellQty ELSE 0 END) sellQty1,
             SUM(sellQty)      sellQty,
             SUM(sellProceeds) sellProceeds,
             SUM(fillCount)    fillCount,
             MIN(firstTs)      firstTs,
             MAX(lastTs)       lastTs
      FROM positions
      GROUP BY 1, 2
    ),
    joined AS (
      SELECT
        COALESCE(p.wallet, s.wallet)           wallet,
        COALESCE(p.conditionId, s.conditionId) conditionId,
        (p.wallet IS NULL)                     isOrphan,
        COALESCE(p.buyQty0, 0)  buyQty0,  COALESCE(p.buyQty1, 0)  buyQty1,
        COALESCE(p.buyQtyUnk, 0) buyQtyUnk,
        COALESCE(p.buyCost0, 0) buyCost0, COALESCE(p.buyCost1, 0) buyCost1,
        COALESCE(p.buyQty, 0)   buyQty,   COALESCE(p.buyCost, 0)  buyCost,
        COALESCE(p.sellQty0, 0) sellQty0, COALESCE(p.sellQty1, 0) sellQty1,
        COALESCE(p.sellQty, 0)  sellQty,  COALESCE(p.sellProceeds, 0) sellProceeds,
        COALESCE(p.fillCount, 0) fillCount,
        p.firstTs firstTs, p.lastTs lastTs,
        COALESCE(s.mergeCash, 0)  mergeCash,  COALESCE(s.mergeQty, 0)  mergeQty,
        COALESCE(s.redeemCash, 0) redeemCash, COALESCE(s.redeemQty, 0) redeemQty,
        s.redeemWinnerIdx redeemWinnerIdx,
        s.lastRedeemTs lastRedeemTs, s.lastMergeTs lastMergeTs,
        m.conditionId IS NOT NULL           hasMeta,
        m.resolved                          mResolved,
        m.closed                            mClosed,
        m.winningOutcomeIndex               mWinner,
        m.source                            mSource,
        m.negRisk                           negRisk,
        m.slug                              slug,
        t0.settlementPrice                  price0,
        t1.settlementPrice                  price1,
        -- On a 50/50 (metadata resolved, no winner) redeem-inference is
        -- meaningless (BOTH sides pay 0.5) — winner stays NULL.
        CASE WHEN m.resolved = 1 AND m.winningOutcomeIndex IS NULL THEN NULL
             ELSE COALESCE(m.winningOutcomeIndex, s.redeemWinnerIdx)
        END winnerIdx,
        CASE
          WHEN m.winningOutcomeIndex IS NOT NULL AND s.redeemWinnerIdx IS NOT NULL
          THEN (m.winningOutcomeIndex = s.redeemWinnerIdx)
        END winnerAgree,
        CASE
          WHEN m.winningOutcomeIndex IS NOT NULL THEN COALESCE(m.source, 'meta')
          WHEN s.redeemWinnerIdx IS NOT NULL     THEN 'redeem'
        END winnerSource,
        COALESCE(
          unixepoch(substr(m.closedTime, 1, 19)),
          unixepoch(m.endDate),
          s.lastRedeemTs, s.lastMergeTs, p.lastTs
        ) resolvedTs
      FROM pos2 p
      FULL OUTER JOIN settlements s ON s.wallet = p.wallet AND s.conditionId = p.conditionId
      LEFT JOIN markets m ON m.conditionId = COALESCE(p.conditionId, s.conditionId)
      LEFT JOIN tokens t0 ON t0.conditionId = m.conditionId AND t0.outcomeIndex = 0
      LEFT JOIN tokens t1 ON t1.conditionId = m.conditionId AND t1.outcomeIndex = 1
    ),
    calc AS (
      SELECT *,
        redeemCash + mergeCash + sellProceeds - buyCost cashPnl,
        -- share residuals: what remains after sells, merges (both sides) and
        -- redeems (winning side only — losing burns carry size 0). On a 50/50
        -- refund (resolved, no winner) BOTH sides pay 0.5 and the per-side
        -- redeem split is unknowable → residuals are NULL there (cash stays
        -- exact; the market is typically fully redeemed anyway).
        CASE WHEN mResolved = 1 AND mWinner IS NULL THEN NULL
             ELSE buyQty0 - sellQty0 - mergeQty - (CASE WHEN winnerIdx = 0 THEN redeemQty ELSE 0 END)
        END resid0,
        CASE WHEN mResolved = 1 AND mWinner IS NULL THEN NULL
             ELSE buyQty1 - sellQty1 - mergeQty - (CASE WHEN winnerIdx = 1 THEN redeemQty ELSE 0 END)
        END resid1,
        MIN(buyQty0, buyQty1) pairedQty,
        MAX(buyQty0, buyQty1) - MIN(buyQty0, buyQty1) directionalQty
      FROM joined
    )
    SELECT *,
      CASE
        WHEN price0 IS NOT NULL AND price1 IS NOT NULL
        THEN MAX(resid0, 0) * price0 + MAX(resid1, 0) * price1
      END residValue,
      (resid0 < -0.01 OR resid1 < -0.01) hasInflow, -- redeemed/merged more than bought (external token inflow)
      CASE
        WHEN isOrphan                                     THEN 'orphan-activity'
        WHEN mResolved = 1 OR redeemWinnerIdx IS NOT NULL THEN 'resolved'
        WHEN NOT hasMeta                                  THEN 'no-metadata'
        WHEN mClosed = 1                                  THEN 'closed-unresolved'
        ELSE 'open'
      END status
    FROM calc;

    CREATE INDEX idx_mpnl_wallet  ON market_pnl (wallet);
    CREATE INDEX idx_mpnl_status  ON market_pnl (wallet, status);
    CREATE INDEX idx_mpnl_cond    ON market_pnl (conditionId);
  `);
  const nPnl = count("market_pnl");
  log(`  market_pnl: ${nPnl} rows`);

  return { positions: nPos, settlements: nSet, marketPnl: nPnl, seconds: (Date.now() - t0) / 1000 };
}

// ---------------------------------------------------------------------------
// Per-wallet summaries + the ledger-closure check
// ---------------------------------------------------------------------------

export interface WalletSummary {
  wallet: string;
  markets: number;
  resolvedMkts: number;
  openMkts: number;
  orphanMkts: number;
  noMetaMkts: number;
  fills: number;
  buyCost: number;
  sellProceeds: number;
  mergeCash: number;
  redeemCash: number;
  /** Realized cash PnL over resolved markets (the headline component). */
  resolvedCashPnl: number;
  /** Settlement value of unredeemed winning-side shares in resolved markets. */
  resolvedResidValue: number;
  /** resolvedCashPnl + resolvedResidValue. */
  realizedTotal: number;
  /** Net cash currently sunk into open/unresolved markets (capital at risk). */
  openNetCash: number;
  orphanCash: number;
  /** Wallet-level measured rebates/rewards (MAKER_REBATE + TAKER_REBATE + REWARD). */
  rebates: number;
  /** realizedTotal + rebates. */
  totalWithRebates: number;
  winnerDisagreeMkts: number;
  inflowMkts: number;
  firstTs: number | null;
  lastTs: number | null;
  /** Σ cashPnl over ALL statuses minus the same identity computed from base tables. */
  ledgerClosureError: number;
}

export function walletSummaries(db: Db): WalletSummary[] {
  const rows = db
    .prepare(
      `SELECT wallet,
              COUNT(*)                                                        markets,
              SUM(status = 'resolved')                                        resolvedMkts,
              SUM(status IN ('open', 'closed-unresolved'))                    openMkts,
              SUM(status = 'orphan-activity')                                 orphanMkts,
              SUM(status = 'no-metadata')                                     noMetaMkts,
              SUM(fillCount)                                                  fills,
              SUM(buyCost)                                                    buyCost,
              SUM(sellProceeds)                                               sellProceeds,
              SUM(mergeCash)                                                  mergeCash,
              SUM(redeemCash)                                                 redeemCash,
              SUM(CASE WHEN status = 'resolved' THEN cashPnl ELSE 0 END)      resolvedCashPnl,
              SUM(CASE WHEN status = 'resolved' THEN COALESCE(residValue, 0) ELSE 0 END) resolvedResidValue,
              SUM(CASE WHEN status IN ('open', 'closed-unresolved', 'no-metadata') THEN cashPnl ELSE 0 END) openNetCash,
              SUM(CASE WHEN status = 'orphan-activity' THEN cashPnl ELSE 0 END) orphanCash,
              SUM(winnerAgree = 0)                                            winnerDisagreeMkts,
              SUM(hasInflow)                                                  inflowMkts,
              MIN(firstTs)                                                    firstTs,
              MAX(lastTs)                                                     lastTs,
              SUM(cashPnl)                                                    allCashPnl
       FROM market_pnl
       GROUP BY wallet
       ORDER BY wallet`,
    )
    .all() as Array<Record<string, number | string | null>>;

  const rebateStmt = db.prepare(
    `SELECT COALESCE(SUM(usdcSize), 0) s FROM activity
     WHERE wallet = ? AND type IN ('MAKER_REBATE', 'TAKER_REBATE', 'REWARD')`,
  );
  // Ledger closure, computed straight from base tables (independent path).
  const baseStmt = db.prepare(
    `SELECT
       (SELECT COALESCE(SUM(usdcSize), 0) FROM activity
         WHERE wallet = ? AND type IN ('MERGE', 'REDEEM')
           AND conditionId IS NOT NULL AND conditionId <> '')
     + (SELECT COALESCE(SUM(CASE WHEN side = 'SELL' THEN size * price ELSE -size * price END), 0)
          FROM fills WHERE wallet = ?) v`,
  );

  return rows.map((r) => {
    const wallet = String(r.wallet);
    const rebates = Number((rebateStmt.get(wallet) as { s: number }).s);
    const base = Number((baseStmt.get(wallet, wallet) as { v: number }).v);
    const resolvedCashPnl = Number(r.resolvedCashPnl ?? 0);
    const resolvedResidValue = Number(r.resolvedResidValue ?? 0);
    const realizedTotal = resolvedCashPnl + resolvedResidValue;
    return {
      wallet,
      markets: Number(r.markets),
      resolvedMkts: Number(r.resolvedMkts ?? 0),
      openMkts: Number(r.openMkts ?? 0),
      orphanMkts: Number(r.orphanMkts ?? 0),
      noMetaMkts: Number(r.noMetaMkts ?? 0),
      fills: Number(r.fills ?? 0),
      buyCost: Number(r.buyCost ?? 0),
      sellProceeds: Number(r.sellProceeds ?? 0),
      mergeCash: Number(r.mergeCash ?? 0),
      redeemCash: Number(r.redeemCash ?? 0),
      resolvedCashPnl,
      resolvedResidValue,
      realizedTotal,
      openNetCash: Number(r.openNetCash ?? 0),
      orphanCash: Number(r.orphanCash ?? 0),
      rebates,
      totalWithRebates: realizedTotal + rebates,
      winnerDisagreeMkts: Number(r.winnerDisagreeMkts ?? 0),
      inflowMkts: Number(r.inflowMkts ?? 0),
      firstTs: r.firstTs === null ? null : Number(r.firstTs),
      lastTs: r.lastTs === null ? null : Number(r.lastTs),
      ledgerClosureError: Number(r.allCashPnl ?? 0) - base,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase-2 artifacts (small, commit-safe; the full market_pnl stays in SQLite)
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";

const csvEsc = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportArtifacts(db: Db, sums: WalletSummary[], labels: Map<string, string>, dir = "output/phase2"): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  // 1) summary.json — the numbers the report quotes.
  const summaryPath = `${dir}/summary.json`;
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        method:
          "cash-ledger: cashPnl = Σ REDEEM.usdcSize + Σ MERGE.usdcSize + sells − buys per (wallet, market); " +
          "rebates wallet-level, separate; residValue = unredeemed shares × settlement price; " +
          "no fee estimates (Phase 3 measures on-chain).",
        wallets: sums.map((s) => ({ label: labels.get(s.wallet) ?? null, ...s })),
      },
      null,
      2,
    ),
  );
  written.push(summaryPath);

  // 2) daily-pnl.csv — realized cash PnL by resolution day (equity-curve source).
  const daily = db
    .prepare(
      `SELECT wallet, date(resolvedTs, 'unixepoch') day, COUNT(*) markets,
              SUM(cashPnl) cashPnl, SUM(COALESCE(residValue, 0)) residValue
       FROM market_pnl WHERE status = 'resolved'
       GROUP BY 1, 2 ORDER BY 1, 2`,
    )
    .all() as Array<Record<string, unknown>>;
  const dailyPath = `${dir}/daily-pnl.csv`;
  writeFileSync(
    dailyPath,
    ["wallet,label,day,markets,cashPnl,residValue"]
      .concat(
        daily.map((r) =>
          [r.wallet, labels.get(String(r.wallet)) ?? "", r.day, r.markets, r.cashPnl, r.residValue].map(csvEsc).join(","),
        ),
      )
      .join("\n") + "\n",
  );
  written.push(dailyPath);

  // 3) extreme-markets.csv — top/bottom 25 per wallet by cashPnl, for eyeballing.
  const extremes: Array<Record<string, unknown>> = [];
  for (const s of sums) {
    for (const dirn of ["DESC", "ASC"] as const) {
      extremes.push(
        ...(db
          .prepare(
            `SELECT p.wallet, p.conditionId, m.question, p.status, p.cashPnl, p.residValue,
                    p.buyCost, p.mergeCash, p.redeemCash, p.fillCount, p.winnerIdx, p.winnerSource
             FROM market_pnl p LEFT JOIN markets m ON m.conditionId = p.conditionId
             WHERE p.wallet = ? AND p.status = 'resolved'
             ORDER BY p.cashPnl ${dirn} LIMIT 25`,
          )
          .all(s.wallet) as Array<Record<string, unknown>>),
      );
    }
  }
  const extremesPath = `${dir}/extreme-markets.csv`;
  const cols = ["wallet", "conditionId", "question", "status", "cashPnl", "residValue", "buyCost", "mergeCash", "redeemCash", "fillCount", "winnerIdx", "winnerSource"];
  writeFileSync(
    extremesPath,
    [cols.join(",")].concat(extremes.map((r) => cols.map((c) => csvEsc(r[c])).join(","))).join("\n") + "\n",
  );
  written.push(extremesPath);

  return written;
}

const usd = (n: number): string =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

export function formatSummaries(sums: WalletSummary[], labels: Map<string, string>): string {
  const lines: string[] = [];
  const day = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "—");
  for (const s of sums) {
    const label = labels.get(s.wallet) ?? s.wallet.slice(0, 10);
    lines.push(`${label}  (${s.wallet})`);
    lines.push(`  markets: ${s.markets}  resolved: ${s.resolvedMkts}  open/unresolved: ${s.openMkts}  orphan: ${s.orphanMkts}  no-meta: ${s.noMetaMkts}`);
    lines.push(`  period: ${day(s.firstTs)} → ${day(s.lastTs)}  fills: ${s.fills.toLocaleString("en-US")}`);
    lines.push(`  buys: ${usd(s.buyCost)}   sells: ${usd(s.sellProceeds)}   merges: ${usd(s.mergeCash)}   redeems: ${usd(s.redeemCash)}`);
    lines.push(`  ── realized cash PnL (resolved mkts): ${usd(s.resolvedCashPnl)}  + residual value ${usd(s.resolvedResidValue)}  = ${usd(s.realizedTotal)}`);
    lines.push(`  ── rebates (measured, wallet-level):  ${usd(s.rebates)}   ⇒ TOTAL incl. rebates: ${usd(s.totalWithRebates)}`);
    lines.push(`  open-market net cash: ${usd(s.openNetCash)}   orphan cash: ${usd(s.orphanCash)}`);
    lines.push(`  DQ: winner disagreements ${s.winnerDisagreeMkts} · inflow markets ${s.inflowMkts} · ledger closure ${s.ledgerClosureError.toExponential(2)}`);
    lines.push("");
  }
  return lines.join("\n");
}
