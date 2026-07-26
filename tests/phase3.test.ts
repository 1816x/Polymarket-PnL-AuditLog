/**
 * Phase 3 tests — decomposition identity (H3), seeded-bootstrap determinism
 * (H1), and slug→series parsing. Same in-memory-DB approach as pnl.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/schema.ts";
import { Repository } from "../src/store/repository.ts";
import { buildDerived } from "../src/analysis/pnl.ts";
import { decomposeWallet, seriesOfSlug } from "../src/analysis/decompose.ts";
import { bootstrapMeanCI, mulberry32, quantile } from "../src/analysis/stats.ts";

const W = "0xwallet1";
let txn = 0;

function fill(repo: Repository, cid: string, asset: string, oi: number, size: number, price: number, ts = 1000) {
  repo.insertFills(W, [
    { proxyWallet: W, side: "BUY", asset, conditionId: cid, size, price, timestamp: ts, outcomeIndex: oi, transactionHash: `0xp3t${txn++}` },
  ]);
}
function act(repo: Repository, cid: string, type: string, usdc: number, size: number, oi: number | null, ts = 2000) {
  repo.insertActivity(W, [
    { proxyWallet: W, type, conditionId: cid, usdcSize: usdc, size, timestamp: ts, outcomeIndex: oi, transactionHash: `0xp3a${txn++}` },
  ]);
}
function market(repo: Repository, cid: string, winner: number, slug: string | null = null) {
  repo.upsertMarketMeta({
    conditionId: cid, question: cid, closed: true, resolved: true, winningOutcomeIndex: winner,
    slug, closedTime: null, endDate: null, negRisk: false, umaStatus: "resolved",
    outcomePrices: JSON.stringify(winner === 0 ? ["1", "0"] : ["0", "1"]), source: "gamma",
    fetchedAt: "2026-07-26T00:00:00Z",
  });
  repo.insertTokens([
    { tokenId: cid + "u", conditionId: cid, outcomeIndex: 0, outcome: "Up", settlementPrice: winner === 0 ? 1 : 0 },
    { tokenId: cid + "d", conditionId: cid, outcomeIndex: 1, outcome: "Down", settlementPrice: winner === 1 ? 1 : 0 },
  ]);
}

test("H3 decomposition: identity holds and legs are attributed sensibly", () => {
  const db = openDb(":memory:");
  const repo = new Repository(db);

  // d1: perfectly paired below $1 — all PnL is "paired".
  fill(repo, "d1", "d1u", 0, 100, 0.48);
  fill(repo, "d1", "d1d", 1, 100, 0.49);
  act(repo, "d1", "MERGE", 100, 100, null);
  market(repo, "d1", 0, "btc-updown-5m-1774900800");

  // d2: pure single-leg directional win — all PnL is "directional".
  fill(repo, "d2", "d2u", 0, 50, 0.6);
  act(repo, "d2", "REDEEM", 50, 50, 0);
  market(repo, "d2", 0, "eth-updown-15m-1774900800");

  // d3: paired + directional remainder (60 Up / 40 Down, Up wins, all redeemed).
  fill(repo, "d3", "d3u", 0, 60, 0.5);
  fill(repo, "d3", "d3d", 1, 40, 0.45);
  act(repo, "d3", "REDEEM", 60, 60, 0);
  market(repo, "d3", 0, "sol-updown-5m-1774900800");

  buildDerived(db);
  const d = decomposeWallet(db, W);

  assert.equal(d.markets, 3);
  assert.equal(d.singleLegMkts, 1);
  assert.equal(d.bothSidesMkts, 2);
  assert.ok(Math.abs(d.identityError) < 1e-9, `identity must close: ${d.identityError}`);

  // d1: paired = 100 × (1 − 0.97) = +3, directional 0.
  // d2: paired 0, directional = 50 − 30 = +20.
  // d3: paired = 40 × (1 − 0.95) = +2; total = 60 − (30+18) = 12 → directional 10.
  assert.ok(Math.abs(d.pairedPnl - 5) < 1e-9, `pairedPnl ${d.pairedPnl}`);
  assert.ok(Math.abs(d.directionalPnl - 30) < 1e-9, `directionalPnl ${d.directionalPnl}`);
  assert.ok(Math.abs(d.singleLegPnl - 20) < 1e-9);

  assert.ok(d.pairCost);
  // pairs: d1 has 100 sets @0.97, d3 has 40 @0.95 → weighted mean.
  const expMean = (100 * 0.97 + 40 * 0.95) / 140;
  assert.ok(Math.abs((d.pairCost!.weightedMean ?? 0) - expMean) < 1e-9);
  assert.equal(d.pairCost!.sharePairsUnder1, 1); // all sets below $1
  assert.equal(d.bySeries.length, 3);
  db.close();
});

test("seriesOfSlug parses short and long slug shapes", () => {
  assert.equal(seriesOfSlug("btc-updown-5m-1774900800"), "btc-5m");
  assert.equal(seriesOfSlug("sol-updown-15m-1784917800"), "sol-15m");
  assert.equal(seriesOfSlug("bitcoin-up-or-down-july-24-2pm-et"), "bitcoin-daily");
  assert.equal(seriesOfSlug("something-else"), null);
  assert.equal(seriesOfSlug(null), null);
});

test("bootstrap is deterministic under a seed and brackets the mean", () => {
  const rnd = mulberry32(7);
  const xs = Array.from({ length: 500 }, () => rnd() * 10 - 4); // mean ≈ 1
  const a = bootstrapMeanCI(xs, 2000, 42);
  const b = bootstrapMeanCI(xs, 2000, 42);
  assert.deepEqual(a, b); // deterministic
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(a.lo < mean && mean < a.hi, `CI [${a.lo}, ${a.hi}] should contain ${mean}`);
  const c = bootstrapMeanCI(xs, 2000, 43);
  assert.notDeepEqual(a, c); // seed matters
});

test("quantile on sorted arrays", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantile(xs, 0), 1);
  assert.equal(quantile(xs, 0.5), 6);
  assert.equal(quantile(xs, 1), 10);
});
