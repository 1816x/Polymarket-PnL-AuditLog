/**
 * Phase 2 — PnL engine fixture tests (spec §5). Runner is node:test (built-in;
 * chosen over vitest to keep dependencies minimal — same precedent as using
 * node:sqlite instead of better-sqlite3; the substitution is flagged in
 * docs/phase2-report.md).
 *
 * Every case is a synthetic ledger with a hand-computed expected PnL, covering
 * the exact behaviours observed in the real data: pair wins, MERGE unwinds,
 * directional losses with zero-usdc redeems, the rare sells, unclaimed
 * winning shares (residual value), oi=999 placeholder fills resolved via the
 * token map, orphan redeems, open markets, 50/50 refunds, and a ledger-closure
 * property check over a pseudo-random ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/schema.ts";
import type { Db } from "../src/store/schema.ts";
import { Repository } from "../src/store/repository.ts";
import { buildDerived, walletSummaries } from "../src/analysis/pnl.ts";

const W = "0xwallet1";

interface FillSpec {
  cid: string;
  asset: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  ts: number;
  oi: number | null;
  wallet?: string;
}
interface ActSpec {
  cid: string;
  type: "MERGE" | "REDEEM" | "MAKER_REBATE" | "TAKER_REBATE" | "REWARD";
  usdc: number;
  size: number;
  ts: number;
  oi?: number | null;
  wallet?: string;
}
interface MarketSpec {
  cid: string;
  winner: number | null; // null + resolved=true => 50/50
  resolved: boolean;
  closed: boolean;
  prices?: [number | null, number | null];
  tokens?: [string, string]; // asset ids for outcome 0/1
}

let txCounter = 0;

function setup(fills: FillSpec[], acts: ActSpec[], markets: MarketSpec[]): { db: Db; repo: Repository } {
  const db = openDb(":memory:");
  const repo = new Repository(db);
  for (const f of fills) {
    repo.insertFills(f.wallet ?? W, [
      {
        proxyWallet: f.wallet ?? W,
        side: f.side,
        asset: f.asset,
        conditionId: f.cid,
        size: f.size,
        price: f.price,
        timestamp: f.ts,
        outcomeIndex: f.oi,
        transactionHash: `0xtx${txCounter++}`,
      },
    ]);
  }
  for (const a of acts) {
    repo.insertActivity(a.wallet ?? W, [
      {
        proxyWallet: a.wallet ?? W,
        type: a.type,
        conditionId: a.cid || null,
        usdcSize: a.usdc,
        size: a.size,
        timestamp: a.ts,
        outcomeIndex: a.oi ?? null,
        transactionHash: `0xatx${txCounter++}`,
      },
    ]);
  }
  for (const m of markets) {
    repo.upsertMarketMeta({
      conditionId: m.cid,
      question: `Q ${m.cid}`,
      closed: m.closed,
      resolved: m.resolved,
      winningOutcomeIndex: m.winner,
      slug: null,
      closedTime: null,
      endDate: null,
      negRisk: false,
      umaStatus: m.resolved ? "resolved" : null,
      outcomePrices: m.prices ? JSON.stringify(m.prices.map(String)) : null,
      source: "gamma",
      fetchedAt: "2026-07-25T00:00:00Z",
    });
    if (m.tokens) {
      repo.insertTokens(
        m.tokens.map((tokenId, i) => ({
          tokenId,
          conditionId: m.cid,
          outcomeIndex: i,
          outcome: i === 0 ? "Up" : "Down",
          settlementPrice: m.resolved ? (m.prices?.[i] ?? null) : null,
        })),
      );
    }
  }
  return { db, repo };
}

function row(db: Db, cid: string, wallet = W): Record<string, number | string | null> {
  const r = db.prepare(`SELECT * FROM market_pnl WHERE wallet = ? AND conditionId = ?`).get(wallet, cid);
  assert.ok(r, `market_pnl row missing for ${cid}`);
  return r as Record<string, number | string | null>;
}

const approx = (a: number | string | null, b: number, eps = 1e-9) => {
  assert.ok(Math.abs(Number(a) - b) < eps, `expected ${a} ≈ ${b}`);
};

test("perfect pair, winning side redeemed", () => {
  const { db } = setup(
    [
      { cid: "m1", asset: "a1u", side: "BUY", size: 10, price: 0.48, ts: 1000, oi: 0 },
      { cid: "m1", asset: "a1d", side: "BUY", size: 10, price: 0.49, ts: 1001, oi: 1 },
    ],
    [
      { cid: "m1", type: "REDEEM", usdc: 10, size: 10, ts: 2000, oi: 0 },
      { cid: "m1", type: "REDEEM", usdc: 0, size: 0, ts: 2300, oi: 0 }, // no-op dust re-redeem
    ],
    [{ cid: "m1", winner: 0, resolved: true, closed: true, prices: [1, 0], tokens: ["a1u", "a1d"] }],
  );
  buildDerived(db);
  const r = row(db, "m1");
  approx(r.cashPnl, 10 - (10 * 0.48 + 10 * 0.49)); // +0.30
  approx(r.resid0, 0);
  approx(r.resid1, 10); // losing shares remain, worth 0
  approx(r.residValue, 0);
  approx(r.pairedQty, 10);
  assert.equal(r.status, "resolved");
  assert.equal(r.winnerIdx, 0);
  assert.equal(r.winnerSource, "gamma");
  assert.equal(Number(r.winnerAgree), 1); // metadata & redeem-inference agree
  db.close();
});

test("pair unwound via MERGE (no redeem)", () => {
  const { db } = setup(
    [
      { cid: "m2", asset: "a2u", side: "BUY", size: 5, price: 0.5, ts: 1000, oi: 0 },
      { cid: "m2", asset: "a2d", side: "BUY", size: 5, price: 0.48, ts: 1001, oi: 1 },
    ],
    [{ cid: "m2", type: "MERGE", usdc: 5, size: 5, ts: 1500 }],
    [{ cid: "m2", winner: 1, resolved: true, closed: true, prices: [0, 1], tokens: ["a2u", "a2d"] }],
  );
  buildDerived(db);
  const r = row(db, "m2");
  approx(r.cashPnl, 5 - 4.9); // +0.10 merge arb
  approx(r.resid0, 0);
  approx(r.resid1, 0);
  approx(r.residValue, 0);
  assert.equal(r.status, "resolved");
  db.close();
});

test("directional loss: zero-usdc redeem, winner from metadata only", () => {
  const { db } = setup(
    [{ cid: "m3", asset: "a3u", side: "BUY", size: 20, price: 0.6, ts: 1000, oi: 0 }],
    [{ cid: "m3", type: "REDEEM", usdc: 0, size: 0, ts: 2000, oi: 0 }],
    [{ cid: "m3", winner: 1, resolved: true, closed: true, prices: [0, 1], tokens: ["a3u", "a3d"] }],
  );
  buildDerived(db);
  const r = row(db, "m3");
  approx(r.cashPnl, -12);
  assert.equal(r.status, "resolved");
  assert.equal(r.winnerIdx, 1);
  assert.equal(r.winnerSource, "gamma"); // no paying redeem to infer from
  assert.equal(r.redeemWinnerIdx, null);
  approx(r.resid0, 20); // worthless losing shares
  approx(r.residValue, 0);
  db.close();
});

test("market with sells", () => {
  const { db } = setup(
    [
      { cid: "m4", asset: "a4u", side: "BUY", size: 10, price: 0.5, ts: 1000, oi: 0 },
      { cid: "m4", asset: "a4u", side: "SELL", size: 4, price: 0.7, ts: 1100, oi: 0 },
    ],
    [{ cid: "m4", type: "REDEEM", usdc: 6, size: 6, ts: 2000, oi: 0 }],
    [{ cid: "m4", winner: 0, resolved: true, closed: true, prices: [1, 0], tokens: ["a4u", "a4d"] }],
  );
  buildDerived(db);
  const r = row(db, "m4");
  approx(r.cashPnl, 6 + 2.8 - 5); // +3.80
  approx(r.resid0, 0);
  approx(r.residValue, 0);
  db.close();
});

test("unclaimed winning shares are valued at settlement (residValue)", () => {
  const { db } = setup(
    [{ cid: "m5", asset: "a5u", side: "BUY", size: 10, price: 0.55, ts: 1000, oi: 0 }],
    [],
    [{ cid: "m5", winner: 0, resolved: true, closed: true, prices: [1, 0], tokens: ["a5u", "a5d"] }],
  );
  buildDerived(db);
  const r = row(db, "m5");
  approx(r.cashPnl, -5.5); // no cash back yet…
  approx(r.resid0, 10);
  approx(r.residValue, 10); // …but holds $10 of winning shares
  assert.equal(r.status, "resolved");
  const s = walletSummaries(db).find((x) => x.wallet === W)!;
  approx(s.realizedTotal, -5.5 + 10);
  db.close();
});

test("oi=999 placeholder fills are resolved via the token map", () => {
  const { db } = setup(
    [{ cid: "m6", asset: "a6u", side: "BUY", size: 10, price: 0.5, ts: 1000, oi: 999 }],
    [{ cid: "m6", type: "REDEEM", usdc: 10, size: 10, ts: 2000, oi: 0 }],
    [{ cid: "m6", winner: 0, resolved: true, closed: true, prices: [1, 0], tokens: ["a6u", "a6d"] }],
  );
  buildDerived(db);
  const r = row(db, "m6");
  approx(r.buyQty0, 10); // grouped under outcome 0 despite oi=999 on the fill
  approx(r.buyQtyUnk, 0);
  approx(r.cashPnl, 5);
  approx(r.resid0, 0);
  db.close();
});

test("orphan redeem: activity with zero fills is flagged, cash still counted", () => {
  const { db } = setup(
    [],
    [{ cid: "m7", type: "REDEEM", usdc: 7, size: 7, ts: 2000, oi: 1 }],
    [{ cid: "m7", winner: 1, resolved: true, closed: true, prices: [0, 1], tokens: ["a7u", "a7d"] }],
  );
  buildDerived(db);
  const r = row(db, "m7");
  assert.equal(r.status, "orphan-activity");
  approx(r.cashPnl, 7);
  const s = walletSummaries(db).find((x) => x.wallet === W)!;
  assert.equal(s.orphanMkts, 1);
  approx(s.orphanCash, 7);
  approx(s.resolvedCashPnl, 0); // orphans never enter the headline
  db.close();
});

test("open market is excluded from realized PnL", () => {
  const { db } = setup(
    [{ cid: "m8", asset: "a8u", side: "BUY", size: 10, price: 0.5, ts: 1000, oi: 0 }],
    [],
    [{ cid: "m8", winner: null, resolved: false, closed: false, tokens: ["a8u", "a8d"] }],
  );
  buildDerived(db);
  const r = row(db, "m8");
  assert.equal(r.status, "open");
  assert.equal(r.residValue, null); // no settlement prices yet
  const s = walletSummaries(db).find((x) => x.wallet === W)!;
  assert.equal(s.openMkts, 1);
  approx(s.openNetCash, -5); // capital at risk
  approx(s.resolvedCashPnl, 0);
  db.close();
});

test("market missing metadata entirely → status no-metadata", () => {
  const { db } = setup(
    [{ cid: "m9", asset: "a9u", side: "BUY", size: 3, price: 0.4, ts: 1000, oi: 0 }],
    [],
    [],
  );
  buildDerived(db);
  const r = row(db, "m9");
  assert.equal(r.status, "no-metadata");
  db.close();
});

test("50/50 refund: cash exact, residuals NULL, no spurious inflow flag", () => {
  const { db } = setup(
    [
      { cid: "m10", asset: "aAu", side: "BUY", size: 4, price: 0.5, ts: 1000, oi: 0 },
      { cid: "m10", asset: "aAd", side: "BUY", size: 4, price: 0.5, ts: 1001, oi: 1 },
    ],
    [
      { cid: "m10", type: "REDEEM", usdc: 2, size: 4, ts: 2000, oi: 0 },
      { cid: "m10", type: "REDEEM", usdc: 2, size: 4, ts: 2000, oi: 1 },
    ],
    [{ cid: "m10", winner: null, resolved: true, closed: true, prices: [0.5, 0.5], tokens: ["aAu", "aAd"] }],
  );
  buildDerived(db);
  const r = row(db, "m10");
  approx(r.cashPnl, 0); // paid 4, refunded 4
  assert.equal(r.resid0, null);
  assert.equal(r.resid1, null);
  assert.equal(r.status, "resolved");
  const s = walletSummaries(db).find((x) => x.wallet === W)!;
  assert.equal(s.inflowMkts, 0);
  db.close();
});

test("rebates are wallet-level, separated from market PnL", () => {
  const { db } = setup(
    [{ cid: "m11", asset: "aBu", side: "BUY", size: 10, price: 0.5, ts: 1000, oi: 0 }],
    [
      { cid: "m11", type: "REDEEM", usdc: 10, size: 10, ts: 2000, oi: 0 },
      { cid: "", type: "MAKER_REBATE", usdc: 3.5, size: 0, ts: 2100 },
      { cid: "", type: "REWARD", usdc: 0.5, size: 0, ts: 2200 },
    ],
    [{ cid: "m11", winner: 0, resolved: true, closed: true, prices: [1, 0], tokens: ["aBu", "aBd"] }],
  );
  buildDerived(db);
  const s = walletSummaries(db).find((x) => x.wallet === W)!;
  approx(s.resolvedCashPnl, 5); // rebate NOT inside
  approx(s.rebates, 4);
  approx(s.totalWithRebates, 9);
  db.close();
});

test("legitimate duplicate fills (same tx/asset/side/size/price/ts) are ALL kept", () => {
  const db = openDb(":memory:");
  const repo = new Repository(db);
  const dup = {
    proxyWallet: W, side: "BUY", asset: "aDu", conditionId: "mD",
    size: 7, price: 0.5, timestamp: 1000, outcomeIndex: 0, transactionHash: "0xsame",
  };
  // One page containing the same fill twice (one taker order crossing two
  // same-size maker quotes) → both must be stored.
  const inserted = repo.insertFills(W, [dup, { ...dup }]);
  assert.equal(inserted, 2);
  // Window-overlap refetch of the same page → fully deduped.
  const again = repo.insertFills(W, [dup, { ...dup }]);
  assert.equal(again, 0);
  const n = (db.prepare(`SELECT COUNT(*) c, SUM(size) q FROM fills`).get() as { c: number; q: number });
  assert.equal(n.c, 2);
  assert.equal(n.q, 14);
  db.close();
});

test("idempotent rebuild: second buildDerived produces identical tables", () => {
  const { db } = setup(
    [
      { cid: "m1", asset: "a1u", side: "BUY", size: 10, price: 0.48, ts: 1000, oi: 0 },
      { cid: "m1", asset: "a1d", side: "BUY", size: 10, price: 0.49, ts: 1001, oi: 1 },
    ],
    [{ cid: "m1", type: "REDEEM", usdc: 10, size: 10, ts: 2000, oi: 0 }],
    [{ cid: "m1", winner: 0, resolved: true, closed: true, prices: [1, 0], tokens: ["a1u", "a1d"] }],
  );
  const s1 = buildDerived(db);
  const pnl1 = row(db, "m1").cashPnl;
  const s2 = buildDerived(db);
  assert.deepEqual(
    { p: s1.positions, s: s1.settlements, m: s1.marketPnl },
    { p: s2.positions, s: s2.settlements, m: s2.marketPnl },
  );
  assert.equal(row(db, "m1").cashPnl, pnl1);
  db.close();
});

test("property: ledger closes on a pseudo-random ledger (2 wallets × 60 markets)", () => {
  // Deterministic LCG so the fixture is reproducible.
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const fills: FillSpec[] = [];
  const acts: ActSpec[] = [];
  const markets: MarketSpec[] = [];
  const wallets = ["0xwA", "0xwB"];
  for (let m = 0; m < 60; m++) {
    const cid = `pm${m}`;
    const winner = rnd() < 0.5 ? 0 : 1;
    markets.push({
      cid,
      winner,
      resolved: true,
      closed: true,
      prices: winner === 0 ? [1, 0] : [0, 1],
      tokens: [`${cid}u`, `${cid}d`],
    });
    for (const w of wallets) {
      if (rnd() < 0.2) continue; // wallet skipped this market
      let up = 0;
      let down = 0;
      const nFills = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < nFills; i++) {
        const oi = rnd() < 0.5 ? 0 : 1;
        const size = Math.round(rnd() * 500) / 10 + 1;
        const price = Math.round((0.2 + rnd() * 0.6) * 100) / 100;
        fills.push({ cid, asset: oi === 0 ? `${cid}u` : `${cid}d`, side: "BUY", size, price, ts: 1000 + i, oi, wallet: w });
        if (oi === 0) up += size;
        else down += size;
      }
      const mergeQty = Math.min(up, down) * (rnd() < 0.5 ? 1 : rnd());
      if (mergeQty > 0.01) {
        acts.push({ cid, type: "MERGE", usdc: mergeQty, size: mergeQty, ts: 1500, wallet: w });
        up -= mergeQty;
        down -= mergeQty;
      }
      const winShares = winner === 0 ? up : down;
      if (winShares > 0.01 && rnd() < 0.9) {
        acts.push({ cid, type: "REDEEM", usdc: winShares, size: winShares, ts: 2000, oi: winner, wallet: w });
        acts.push({ cid, type: "REDEEM", usdc: 0, size: 0, ts: 2300, oi: winner, wallet: w });
      }
    }
  }
  const { db } = setup(fills, acts, markets);
  buildDerived(db);
  for (const s of walletSummaries(db)) {
    assert.ok(
      Math.abs(s.ledgerClosureError) < 1e-6,
      `ledger must close for ${s.wallet}: err=${s.ledgerClosureError}`,
    );
    // Sanity: every market resolved, no DQ flags on clean synthetic data.
    assert.equal(s.openMkts, 0);
    assert.equal(s.winnerDisagreeMkts, 0);
    assert.equal(s.inflowMkts, 0);
  }
  db.close();
});
