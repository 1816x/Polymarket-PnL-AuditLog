/**
 * CLI entrypoint for the Polymarket PnL forensic auditor.
 *
 * Phase 0 subcommands:
 *   resolve            Resolve the 5 subject wallets (usernames -> proxy addresses).
 *   recon [opts]       Download one wallet's raw fills/activity, read a market's
 *                      settlement, and reconstruct maker/taker on-chain for one tx,
 *                      dumping raw structures so we can confirm the data has the
 *                      shape the rest of the spec assumes (spec §7 checkpoint).
 *
 * Global: --dry-run prints the request plan and exits without calling anything.
 *
 * Run: `node src/cli.ts <command> [options]`
 */
import { mkdir, writeFile } from "node:fs/promises";
import { getActivity, getTrades, getClosedPositions, getPositions, getPortfolioValue } from "./clients/data.ts";
import { getMarketSettlement } from "./clients/clob.ts";
import { extractWalletFills, getTransactionReceipt } from "./clients/onchain.ts";
import { getRequestCount as reqCount } from "./clients/http.ts";
import { polygonRpcUrls } from "./config/constants.ts";
import { resolveSubjects } from "./ingest/resolve-wallets.ts";
import type { ResolvedSubject } from "./ingest/resolve-wallets.ts";
import { openDb, openDbReadOnly } from "./store/schema.ts";
import { Repository } from "./store/repository.ts";
import { ingestFills, topUpFills } from "./ingest/fetch-fills.ts";
import { ingestActivity, topUpActivity } from "./ingest/fetch-activity.ts";
import { rebuildFills } from "./ingest/rebuild-fills.ts";
import { collectVolume, formatVolume, sampleSettlement } from "./ingest/report.ts";
import { backfillMarkets, backfillPlan } from "./ingest/fetch-markets.ts";
import { buildDerived, walletSummaries, formatSummaries, exportArtifacts } from "./analysis/pnl.ts";
import { sampleResolvedMarkets } from "./analysis/sampling.ts";
import { ingestTakerFills } from "./ingest/fetch-taker.ts";
import { buildChainSample, fetchChainSample } from "./ingest/fetch-onchain.ts";
import type { ChainSampleEntry } from "./ingest/fetch-onchain.ts";
import { walletMakerTaker } from "./analysis/maker-taker.ts";
import { analyzeFeeRole, analyzeFeedGap, measuredFeeRate } from "./analysis/fees.ts";
import { decomposeWallet } from "./analysis/decompose.ts";
import { walletStats } from "./analysis/stats.ts";

const OUT_DIR = "output/phase0";
const DEFAULT_WALLET = "0xfcdc071df7080c214196bb0b3b751e5417f9d8e3"; // neversmiling (resolved)

interface Args {
  command: string;
  dryRun: boolean;
  wallet?: string;
  tx?: string;
  limit: number;
  maxPages: number;
  delayMs: number;
  sample: number;
  fillsOnly: boolean;
  activityOnly: boolean;
  concurrency: number;
  market?: string;
  samples: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? "help",
    dryRun: false,
    limit: 10,
    maxPages: 1_000_000,
    delayMs: 100,
    sample: 150,
    fillsOnly: false,
    activityOnly: false,
    concurrency: 4,
    samples: 50,
  };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") a.dryRun = true;
    else if (t === "--wallet") a.wallet = argv[++i]?.toLowerCase();
    else if (t === "--tx") a.tx = argv[++i];
    else if (t === "--limit") a.limit = Number(argv[++i]) || 10;
    else if (t === "--max-pages") a.maxPages = Number(argv[++i]) || a.maxPages;
    else if (t === "--delay") a.delayMs = Number(argv[++i]) || 0;
    else if (t === "--sample") a.sample = Number(argv[++i]) || 0;
    else if (t === "--fills-only") a.fillsOnly = true;
    else if (t === "--activity-only") a.activityOnly = true;
    else if (t === "--concurrency") a.concurrency = Number(argv[++i]) || a.concurrency;
    else if (t === "--market") a.market = argv[++i];
    else if (t === "--samples") a.samples = Number(argv[++i]) || a.samples;
  }
  return a;
}

/** Resolved subjects that are usable (have an address), optionally filtered to one wallet. */
async function usableWallets(filter?: string): Promise<ResolvedSubject[]> {
  const resolved = await resolveSubjects();
  let usable = resolved.filter((r) => r.address);
  if (filter) usable = usable.filter((r) => r.address === filter);
  return usable;
}

function stamp(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function dump(name: string, data: unknown): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}/${name}`;
  await writeFile(path, JSON.stringify(data, null, 2));
  console.log(`  ↳ wrote ${path}`);
}

function hr(): void {
  console.log("─".repeat(72));
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------
async function cmdResolve(args: Args): Promise<void> {
  console.log("PHASE 0 — resolve subject wallets\n");
  if (args.dryRun) {
    console.log("[dry-run] would issue, per subject:");
    console.log("  • usernames: 1× Gamma /public-search, then 1× Gamma /public-profile (round-trip),");
    console.log("               + up to 1× Data /v1/leaderboard fallback if no exact match");
    console.log("  • addresses: 1× Gamma /public-profile");
    console.log(`  ~ ${1}–${3} requests × 5 subjects ≈ 5–15 requests total. No calls made.`);
    return;
  }

  const resolved = await resolveSubjects();
  hr();
  console.log("id  status      address                                     name/roundtrip   method");
  hr();
  for (const r of resolved) {
    const addr = r.address ?? "—".padEnd(42);
    const rt = (r.roundTripName ?? "—").padEnd(15);
    console.log(`${String(r.id).padEnd(3)} ${r.status.padEnd(11)} ${addr.padEnd(43)} ${rt} ${r.method}`);
    for (const n of r.notes) console.log(`      ⚠ ${n}`);
  }
  hr();
  const usable = resolved.filter((r) => r.address);
  const excluded = resolved.filter((r) => !r.address);
  console.log(`\n${usable.length}/5 wallets usable; ${excluded.length} excluded.`);
  if (excluded.length) {
    console.log(`Excluded (documented, per spec §1): ${excluded.map((e) => e.label).join(", ")}`);
  }
  await dump("resolved-wallets.json", resolved);
  console.log(`\nRequests made: ${reqCount()}`);
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------
interface FillInterpretation {
  role: string;
  shares: number; // outcome-token amount on this leg (the non-collateral side)
  cash: number; // collateral amount on this leg
  impliedPrice: number; // cash/shares — MAY be the outcome COMPLEMENT of the /trades price
  fee: number;
  counterparty: string;
}

/**
 * Split an OrderFilled leg into token vs collateral sides (asset id 0 == collateral).
 * We deliberately do NOT infer BUY/SELL here: the economic side/price come from
 * the /trades record. On-chain is used only as a role + fee oracle. The implied
 * price can be the complement of the /trades price (taker orders match against the
 * opposite outcome), so it is reported but not reconciled.
 */
function interpret(fill: {
  role: string;
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmount: number;
  takerAmount: number;
  fee: number;
  counterparty: string;
}): FillInterpretation {
  const tokenOnTakerSide = fill.makerAssetId === 0n; // collateral on maker side => token on taker side
  const shares = tokenOnTakerSide ? fill.takerAmount : fill.makerAmount;
  const cash = tokenOnTakerSide ? fill.makerAmount : fill.takerAmount;
  const impliedPrice = shares > 0 ? cash / shares : 0;
  return { role: fill.role, shares, cash, impliedPrice, fee: fill.fee, counterparty: fill.counterparty };
}

async function cmdRecon(args: Args): Promise<void> {
  const wallet = args.wallet ?? DEFAULT_WALLET;
  console.log(`PHASE 0 — recon for wallet ${wallet}\n`);

  if (args.dryRun) {
    console.log("[dry-run] recon would issue:");
    console.log(`  • 3× Data /trades (takerOnly=false, takerOnly=true, and an older window; limit ${args.limit})`);
    console.log("  • 1× Data /activity (limit 100)");
    console.log("  • up to 8× CLOB /markets/<conditionId> (until a resolved market is found)");
    console.log("  • 1× eth_getTransactionReceipt (Polygon RPC, with failover)");
    console.log(`  ≈ 5–10 requests total. RPC endpoints: ${polygonRpcUrls().length} configured. No calls made.`);
    return;
  }

  // 1) Fills — full (takerOnly=false) vs taker-only, to test the cheap set-diff signal.
  const allFills = await getTrades({ user: wallet, takerOnly: false, limit: args.limit });
  const takerFills = await getTrades({ user: wallet, takerOnly: true, limit: args.limit });
  // For the settlement demo, look ~1h before the latest fill so the short (5–15 min)
  // markets have resolved. Reference time comes from the DATA, not the container clock.
  const latestTs = allFills[0]?.timestamp ?? 0;
  const olderFills = latestTs
    ? await getTrades({ user: wallet, takerOnly: false, limit: args.limit, end: latestTs - 3600 })
    : [];
  console.log("── Fills (/trades) ──────────────────────────────────────────────────");
  console.log(`  takerOnly=false → ${allFills.length} rows (all fills)`);
  console.log(`  takerOnly=true  → ${takerFills.length} rows (taker fills only)`);
  console.log("  note: both hit the row limit, so counts alone don't give the split — on-chain is ground truth (below)");
  if (allFills[0]) {
    const t = allFills[0];
    console.log(`  sample fill: ${t.side} ${t.size} @ ${t.price}  "${t.title}"`);
    console.log(`               conditionId=${t.conditionId}`);
    console.log(`               tx=${t.transactionHash}`);
  }

  // 2) Activity — confirm REDEEM/settlement rows exist and their shape.
  const activity = await getActivity({ user: wallet, limit: 100 });
  const typeCounts: Record<string, number> = {};
  for (const r of activity) typeCounts[r.type] = (typeCounts[r.type] ?? 0) + 1;
  console.log("\n── Activity (/activity) ─────────────────────────────────────────────");
  console.log(`  last ${activity.length} rows, types: ${JSON.stringify(typeCounts)}`);
  const redeem = activity.find((r) => r.type === "REDEEM");
  if (redeem) {
    console.log(`  REDEEM sample: usdcSize=${redeem.usdcSize} (⇒ compute settlement from outcome×net position, not this field)`);
  }

  // 3) Settlement — CLOB /markets, searching recent markets for a resolved one.
  console.log("\n── Settlement (CLOB /markets) ───────────────────────────────────────");
  const uniqueConds = [...new Set([...olderFills, ...allFills].map((f) => f.conditionId))].slice(0, 8);
  let settlement = null;
  for (const cid of uniqueConds) {
    const s = await getMarketSettlement(cid);
    if (s?.resolved) {
      settlement = s;
      break;
    }
  }
  if (settlement) {
    const wt = settlement.tokens.map((t) => `${t.outcome}=${t.winner ? "WON" : t.price}`).join(", ");
    console.log(`  resolved market "${settlement.question}"`);
    console.log(`    conditionId=${settlement.conditionId}`);
    console.log(`    winner: outcomeIndex=${settlement.winningOutcomeIndex} [${wt}]`);
  } else {
    console.log(`  none of ${uniqueConds.length} sampled markets resolved yet (short windows may be freshly open)`);
  }

  // 4) Maker/taker reconstruction — the H2 method — on one real tx.
  console.log("\n── Maker/taker reconstruction (on-chain OrderFilled) ────────────────");
  const txHash = args.tx ?? allFills[0]?.transactionHash;
  let onchainFills: FillInterpretation[] = [];
  let rawFills: unknown[] = [];
  if (!txHash) {
    console.log("  no tx available to decode");
  } else {
    console.log(`  tx ${txHash}`);
    console.log(`  RPC: ${polygonRpcUrls()[0]} (+${polygonRpcUrls().length - 1} fallback)`);
    const receipt = await getTransactionReceipt(txHash);
    if (!receipt) {
      console.log("  receipt not found");
    } else {
      const fills = extractWalletFills(receipt, wallet);
      rawFills = fills.map((f) => ({ ...f, makerAssetId: f.makerAssetId.toString(), takerAssetId: f.takerAssetId.toString() }));
      onchainFills = fills.map(interpret);
      console.log(`  block ${parseInt(receipt.blockNumber, 16)}, ${receipt.logs.length} logs; ${fills.length} leg(s) involve this wallet`);
      for (const f of onchainFills) {
        console.log(
          `    role=${f.role.toUpperCase().padEnd(5)} shares=${f.shares}  cash=${f.cash}  impliedPx=${f.impliedPrice.toFixed(4)}  fee=${f.fee}`,
        );
      }
      // Reconcile against the /trades record: aggregate legs; reconcile SHARES only
      // (price/side come from /trades; on-chain gives role + fee).
      const matchTrade = allFills.find((t) => t.transactionHash === txHash);
      if (matchTrade && onchainFills.length) {
        const totShares = onchainFills.reduce((s, f) => s + f.shares, 0);
        const totFee = onchainFills.reduce((s, f) => s + f.fee, 0);
        const roles = [...new Set(onchainFills.map((f) => f.role))].join("+");
        const sizeOk = Math.abs(totShares - matchTrade.size) < 0.05;
        console.log(
          `  aggregate: role=${roles}, shares=${totShares.toFixed(2)} vs /trades size=${matchTrade.size} ${sizeOk ? "✓" : "✗"}, total fee=${totFee.toFixed(6)}`,
        );
        console.log(
          `  economic terms from /trades: ${matchTrade.side} @ ${matchTrade.price} (on-chain impliedPx may be the complement ${(1 - matchTrade.price).toFixed(2)})`,
        );
        if (roles === "maker") console.log(`  H2 note: role=MAKER; per-leg fee=${totFee.toFixed(6)} (makers pay 0 — validated).`);
        if (roles.includes("taker"))
          console.log("  H2 note: role=TAKER; taker fee decode is PROVISIONAL (tx-level fee sits on the aggregate leg — see docs/phase0-report.md).");
        const inTakerSet = takerFills.some((t) => t.transactionHash === txHash);
        console.log(`  cross-check (inconclusive, paging-confounded): Data-API takerOnly=true ${inTakerSet ? "INCLUDES" : "excludes"} this tx`);
      }
    }
  }

  await dump(`recon-${wallet.slice(0, 10)}.json`, {
    wallet,
    fetchedAt: new Date().toISOString(),
    counts: { allFills: allFills.length, takerFills: takerFills.length, activity: activity.length },
    activityTypeCounts: typeCounts,
    sampleFills: allFills,
    settlement,
    onchain: { txHash, fills: rawFills, interpreted: onchainFills },
  });
  console.log(`\nRequests made: ${reqCount()}`);
}

// ---------------------------------------------------------------------------
// ingest (Phase 1) — full resumable download of fills + non-trade activity
// ---------------------------------------------------------------------------
async function cmdIngest(args: Args): Promise<void> {
  const wallets = await usableWallets(args.wallet);
  console.log(`PHASE 1 — ingest ${wallets.length} wallet(s)\n`);
  const db = openDb();
  const repo = new Repository(db);

  if (args.dryRun) {
    console.log("[dry-run] plan — end-cursor time pagination, append-only raw cache, resumable:");
    for (const w of wallets) {
      const fc = repo.getCheckpoint(`fills:${w.address}`);
      const ac = repo.getCheckpoint(`activity:${w.address}`);
      const st = (c: ReturnType<Repository["getCheckpoint"]>) =>
        !c ? "not started" : c.done ? `done (${c.rows} rows)` : `resume @${c.cursor} (${c.rows} rows so far)`;
      console.log(`  ${w.label} ${w.address}`);
      console.log(`    fills    (/trades  10000/pg): ${st(fc)}`);
      console.log(`    activity (/activity 500/pg) : ${st(ac)}`);
    }
    console.log("\nNo calls made.");
    db.close();
    return;
  }

  const topup = process.argv.includes("--topup");
  for (const w of wallets) {
    const addr = w.address as string;
    stamp(`▶ ${w.label} ${addr}`);
    if (topup) {
      // Top-up order is load-bearing: ACTIVITY FIRST, then fills (see
      // fetch-activity.topUpActivity docstring). stopAt = previous coverage
      // edge minus 5 min of overlap; dedup handles the overlap.
      const edge = (table: string) =>
        Number((db.prepare(`SELECT COALESCE(MAX(ts), 0) m FROM ${table} WHERE wallet = ?`).get(addr) as { m: number }).m);
      if (!args.fillsOnly) {
        const r = await topUpActivity(repo, addr, Math.max(0, edge("activity") - 300), { delayMs: args.delayMs, log: stamp });
        stamp(`  activity top-up: +${r.rows} rows / ${r.pages} pages`);
      }
      if (!args.activityOnly) {
        const r = await topUpFills(repo, addr, Math.max(0, edge("fills") - 300), { delayMs: args.delayMs, log: stamp });
        stamp(`  fills top-up: +${r.rows} rows / ${r.pages} pages`);
      }
      continue;
    }
    if (!args.activityOnly) {
      const r = await ingestFills(repo, addr, { maxPages: args.maxPages, delayMs: args.delayMs, log: stamp });
      stamp(`  fills: ${r.rows} rows / ${r.pages} pages / done=${r.done}`);
    }
    if (!args.fillsOnly) {
      const r = await ingestActivity(repo, addr, { maxPages: args.maxPages, delayMs: args.delayMs, log: stamp });
      stamp(`  activity: ${r.rows} rows / ${r.pages} pages / done=${r.done}`);
    }
  }

  const vols = [];
  for (const w of wallets) {
    const v = collectVolume(repo, w.address as string, w.label);
    if (args.sample > 0 && v.markets > 0) {
      stamp(`sampling settlement for ${w.label} (n=${args.sample})…`);
      v.settlementSample = await sampleSettlement(repo, w.address as string, args.sample);
    }
    vols.push(v);
  }
  console.log("\n" + formatVolume(vols));
  console.log(`\nRequests this run: ${reqCount()}`);
  db.close();
}

// ---------------------------------------------------------------------------
// backfill-markets (Phase 2) — metadata + settlement for every conditionId
// ---------------------------------------------------------------------------
async function cmdBackfillMarkets(args: Args): Promise<void> {
  const db = openDb();
  const repo = new Repository(db);

  if (args.dryRun) {
    const plan = backfillPlan(repo);
    console.log("PHASE 2 — backfill-markets [dry-run]\n");
    console.log(`  distinct conditionIds (fills ∪ activity): ${plan.ids}`);
    console.log(`  gamma batches of 40: ${plan.batches} (${plan.cachedBatches} already cached → replay offline)`);
    console.log(`  gamma requests to make: ${plan.toFetch}`);
    console.log(`  + CLOB fallback for whatever gamma misses (count known only after the gamma pass)`);
    console.log(`  concurrency ${args.concurrency}, delay ${args.delayMs} ms. No calls made.`);
    db.close();
    return;
  }

  stamp(`▶ backfill-markets: metadata for all traded markets`);
  const res = await backfillMarkets(repo, {
    concurrency: args.concurrency,
    delayMs: args.delayMs,
    log: stamp,
  });
  hr();
  console.log(`ids=${res.ids}  gammaRows=${res.gammaRows} (replayed ${res.replayedBatches}/${res.batches} batches)`);
  console.log(`clobRows=${res.clobRows}  stillMissing=${res.stillMissing}  resolved=${res.resolved}  fiftyFifty=${res.fiftyFifty}`);
  console.log(`winner cross-check vs stored rows: ${res.disagreements.length} disagreement(s)`);
  for (const d of res.disagreements.slice(0, 20)) {
    console.log(`  DISAGREE ${d.conditionId}: stored=${d.stored} fetched=${d.fetched}`);
  }
  if (res.disagreements.length > 0) {
    console.log(`\n⚠ GATE: winner disagreements found — investigate before trusting metadata (spec §8).`);
  }
  console.log(`\nRequests made: ${reqCount()}`);
  db.close();
}

// ---------------------------------------------------------------------------
// rebuild-fills (Phase 2, offline) — replay raw cache into the seq-keyed table
// ---------------------------------------------------------------------------
async function cmdRebuildFills(args: Args): Promise<void> {
  const db = openDb();
  if (args.dryRun) {
    console.log("[dry-run] rebuild-fills replays data/raw/fills/**.ndjson.gz into a fresh table");
    console.log("          with the seq-augmented PK, then swaps it in. Fully offline.");
    db.close();
    return;
  }
  console.log("PHASE 2 — rebuild fills from raw cache (seq-augmented PK)\n");
  const res = rebuildFills(db, stamp);
  hr();
  for (const p of res.perWallet) {
    const gained = p.stored - p.before;
    console.log(`  ${p.wallet.slice(0, 10)}… files=${p.files} raw=${p.rawRows} stored=${p.stored} (was ${p.before}, ${gained >= 0 ? "+" : ""}${gained} recovered)`);
  }
  console.log(`\nTOTAL stored: ${res.storedRows} (from ${res.rawRows} raw rows across ${res.files} files)`);
  db.close();
}

// ---------------------------------------------------------------------------
// pnl (Phase 2) — build derived tables + print per-wallet summaries (offline)
// ---------------------------------------------------------------------------
async function cmdPnl(args: Args): Promise<void> {
  const db = openDb();
  if (args.dryRun) {
    console.log("[dry-run] pnl would rebuild positions/settlements/market_pnl from the local store");
    console.log("          and print per-wallet summaries. Fully offline — no API calls ever.");
    db.close();
    return;
  }
  console.log("PHASE 2 — PnL engine (offline; cash-ledger accounting)\n");
  const skipBuild = process.argv.includes("--skip-build");
  if (skipBuild) {
    stamp("(--skip-build: reusing existing derived tables)");
  } else {
    const stats = buildDerived(db, stamp);
    stamp(`derived tables built in ${stats.seconds.toFixed(1)}s`);
  }
  hr();
  const sums = walletSummaries(db);
  const wallets = await usableWallets();
  const labels = new Map(wallets.map((w) => [w.address as string, w.label]));
  console.log(formatSummaries(sums, labels));
  for (const p of exportArtifacts(db, sums, labels)) console.log(`  ↳ wrote ${p}`);
  const worstClosure = Math.max(...sums.map((s) => Math.abs(s.ledgerClosureError)));
  if (worstClosure > 1) {
    console.log(`⚠ GATE: ledger closure error exceeds $1 (${worstClosure}) — the derived tables do NOT`);
    console.log(`  reproduce the base-table cash identity; investigate before using these numbers.`);
  }
  db.close();
}

// ---------------------------------------------------------------------------
// mt-ingest (Phase 3 / H2) — taker-subset download for the market sample
// ---------------------------------------------------------------------------
async function cmdMtIngest(args: Args): Promise<void> {
  const db = openDb();
  const repo = new Repository(db);
  const wallets = await usableWallets(args.wallet);
  const target = args.samples >= 100 ? args.samples : 400; // markets per wallet

  const samples = wallets.flatMap((w) => sampleResolvedMarkets(db, w.address as string, target));
  if (args.dryRun) {
    console.log("PHASE 3 — mt-ingest [dry-run]\n");
    for (const w of wallets) {
      const s = samples.filter((x) => x.wallet === w.address);
      console.log(`  ${w.label}: ${s.length} sampled markets across ${new Set(s.map((x) => x.month)).size} months`);
    }
    console.log(`\n  total ${samples.length} markets ≈ ${samples.length}+ requests (1 per market, cursor-walk if >10k rows).`);
    console.log("  Raw cache: data/raw/taker/<wallet>/<conditionId>.ndjson.gz (existing files replayed). No calls made.");
    db.close();
    return;
  }

  stamp(`▶ mt-ingest: taker subset for ${samples.length} sampled markets`);
  const res = await ingestTakerFills(repo, samples, { concurrency: args.concurrency, delayMs: args.delayMs, log: stamp });
  hr();
  console.log(`markets=${res.markets} (replayed ${res.replayed})  takerRows=${res.takerRows}  cursorWalked=${res.fullPages}`);
  // Quick per-wallet preview by notional (full analysis in `analyze`).
  for (const w of wallets) {
    const addr = w.address as string;
    const t = db
      .prepare(
        `SELECT COALESCE(SUM(size * price), 0) v, COUNT(*) n FROM taker_fills WHERE wallet = ?`,
      )
      .get(addr) as { v: number; n: number };
    const f = db
      .prepare(
        `SELECT COALESCE(SUM(p.buyCost + p.sellProceeds), 0) v, COALESCE(SUM(p.fillCount), 0) n
         FROM positions p WHERE p.wallet = ? AND p.conditionId IN (SELECT DISTINCT conditionId FROM taker_fills WHERE wallet = ?)`,
      )
      .get(addr, addr) as { v: number; n: number };
    const shareN = f.n > 0 ? (100 * t.n) / f.n : 0;
    const shareV = f.v > 0 ? (100 * t.v) / f.v : 0;
    console.log(`  ${w.label}: taker ≈ ${shareN.toFixed(1)}% of fills, ${shareV.toFixed(1)}% of notional (sampled mkts)`);
  }
  console.log(`\nRequests made: ${reqCount()}`);
  db.close();
}

// ---------------------------------------------------------------------------
// chain-sample (Phase 3 / B) — on-chain receipts for fees, role validation,
// and feed-gap classification. Writes files only (concurrent-safe vs mt-ingest).
// ---------------------------------------------------------------------------
async function cmdChainSample(args: Args): Promise<void> {
  // Read-only open: this command runs concurrently with mt-ingest (the DB
  // writer) and must not issue DDL/pragma writes.
  const db = openDbReadOnly();
  const wallets = (await usableWallets(args.wallet)).map((w) => w.address as string);
  const entries = buildChainSample(db, wallets);
  db.close(); // everything below is file/network only

  const byKind = new Map<string, number>();
  for (const e of entries) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);

  if (args.dryRun) {
    console.log("PHASE 3 — chain-sample [dry-run]\n");
    for (const [k, n] of byKind) console.log(`  ${k}: ${n} txs`);
    console.log(`  total ${entries.length} receipts via Polygon RPC (failover: ${polygonRpcUrls().length} endpoints)`);
    console.log("  Raw cache: data/raw/receipts/<tx>.json.gz (existing files skipped). No calls made.");
    return;
  }

  stamp(`▶ chain-sample: ${entries.length} receipts (${[...byKind].map(([k, n]) => `${k}:${n}`).join(", ")})`);
  const res = await fetchChainSample(entries, { concurrency: args.concurrency, delayMs: args.delayMs, log: stamp });
  await mkdir("output/phase3", { recursive: true });
  await writeFile("output/phase3/chain-manifest.json", JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 1));
  hr();
  console.log(`fetched=${res.fetched}  cached=${res.cached}  failed=${res.failed.length} of ${res.total}`);
  if (res.failed.length) console.log(`  failed txs (retry by re-running): ${res.failed.slice(0, 5).join(", ")}${res.failed.length > 5 ? "…" : ""}`);
  console.log(`  ↳ wrote output/phase3/chain-manifest.json`);
}

// ---------------------------------------------------------------------------
// validate (Phase 2) — reconcile our per-market cash PnL against Polymarket's
// own realizedPnl (/closed-positions), plus wallet-level context numbers.
// Polymarket's figures are a CROSS-CHECK, never our source (spec).
// ---------------------------------------------------------------------------
interface MarketDelta {
  wallet: string;
  conditionId: string;
  ours: number;
  oursWithResid: number;
  theirs: number | null;
  delta: number | null;
  rows: number;
  note: string;
}

async function cmdValidate(args: Args): Promise<void> {
  const db = openDb();
  const wallets = await usableWallets(args.wallet);

  if (args.dryRun) {
    console.log(`[dry-run] validate would sample ~${args.samples} resolved markets per wallet`);
    console.log("          (top by |cashPnl| + evenly-spaced) and fetch /closed-positions per market,");
    console.log("          plus 1× /value and 1× /positions page per wallet. No calls made.");
    db.close();
    return;
  }

  console.log("PHASE 2 — validate: our cash PnL vs Polymarket's own realizedPnl\n");
  const labelOf = new Map(wallets.map((w) => [w.address as string, w.label]));
  const perMarket: MarketDelta[] = [];
  const walletLevel: Array<Record<string, unknown>> = [];

  for (const w of wallets) {
    const addr = w.address as string;
    // Sample: top-N/2 by |cashPnl| (stress the extremes) + N/2 evenly spaced
    // over the resolved population (unbiased-ish, deterministic).
    const half = Math.max(2, Math.floor(args.samples / 2));
    const top = db
      .prepare(
        `SELECT conditionId, cashPnl, COALESCE(residValue, 0) rv FROM market_pnl
         WHERE wallet = ? AND status = 'resolved' AND fillCount > 0
         ORDER BY ABS(cashPnl) DESC LIMIT ?`,
      )
      .all(addr, half) as Array<{ conditionId: string; cashPnl: number; rv: number }>;
    const total = (
      db.prepare(`SELECT COUNT(*) c FROM market_pnl WHERE wallet = ? AND status = 'resolved' AND fillCount > 0`).get(addr) as {
        c: number;
      }
    ).c;
    const step = Math.max(1, Math.floor(total / half));
    const spread = db
      .prepare(
        `SELECT conditionId, cashPnl, COALESCE(residValue, 0) rv FROM
           (SELECT conditionId, cashPnl, residValue,
                   ROW_NUMBER() OVER (ORDER BY conditionId) rn
            FROM market_pnl WHERE wallet = ? AND status = 'resolved' AND fillCount > 0)
         WHERE (rn - 1) % ? = 0 LIMIT ?`,
      )
      .all(addr, step, half) as Array<{ conditionId: string; cashPnl: number; rv: number }>;

    const seen = new Set<string>();
    const sample = [...top, ...spread].filter((s) =>
      seen.has(s.conditionId) ? false : (seen.add(s.conditionId), true),
    );

    stamp(`▶ ${w.label}: reconciling ${sample.length} markets against /closed-positions + /positions…`);
    for (const s of sample) {
      // Polymarket splits one market across BOTH endpoints: legs closed by
      // merge/redeem/sell sit in /closed-positions (realizedPnl), while any
      // leftover shares sit in /positions carrying that leg's realizedPnl plus
      // the mark on the remainder (cashPnl; at settlement price once
      // resolved). Their full per-market figure is the sum of all of it —
      // comparable to our cashPnl + residValue.
      const closed = (await getClosedPositions({ user: addr, market: s.conditionId, limit: 10 })).filter(
        (r) => r.conditionId === s.conditionId,
      );
      const open = (await getPositions({ user: addr, market: s.conditionId, sizeThreshold: 0, limit: 10 })).filter(
        (r) => r.conditionId === s.conditionId,
      );
      const theirs =
        closed.reduce((acc, r) => acc + (r.realizedPnl ?? 0), 0) +
        open.reduce((acc, r) => acc + (r.realizedPnl ?? 0) + (r.cashPnl ?? 0), 0);
      const oursWithResid = s.cashPnl + s.rv;
      perMarket.push({
        wallet: addr, conditionId: s.conditionId, ours: s.cashPnl, oursWithResid,
        theirs, delta: oursWithResid - theirs, rows: closed.length + open.length,
        note: closed.length + open.length === 0 ? "no-position-rows" : "",
      });
      if (args.delayMs > 0) await new Promise((r) => setTimeout(r, args.delayMs));
    }

    // Wallet-level context (not a strict oracle): portfolio value + open positions.
    const value = await getPortfolioValue(addr).catch(() => null);
    const open = await getPositions({ user: addr, limit: 500, sizeThreshold: 1 }).catch(() => []);
    const openValue = open.reduce((a, p) => a + (p.size ?? 0) * (p.curPrice ?? 0), 0);
    const openRedeemable = open.filter((p) => p.redeemable).length;
    walletLevel.push({
      wallet: addr, label: w.label, portfolioValue: value,
      openPositions: open.length, openRedeemable, openMarkValue: openValue,
    });
  }

  hr();
  console.log("Per-market reconciliation (ours − Polymarket realizedPnl):\n");
  const byWallet = new Map<string, MarketDelta[]>();
  for (const d of perMarket) {
    if (!byWallet.has(d.wallet)) byWallet.set(d.wallet, []);
    byWallet.get(d.wallet)!.push(d);
  }
  for (const [addr, ds] of byWallet) {
    const ok = ds.filter((d) => d.delta !== null && d.rows > 0);
    const missing = ds.filter((d) => d.rows === 0);
    const deltas = ok.map((d) => Math.abs(d.delta as number)).sort((a, b) => a - b);
    const q = (arr: number[], p: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
    const label = labelOf.get(addr) ?? addr.slice(0, 10);
    console.log(`  ${label} — ${ok.length} compared, ${missing.length} without any position rows`);
    console.log(`    |Δ (ours cash+resid − theirs)|: median $${q(deltas, 0.5).toFixed(4)}  p90 $${q(deltas, 0.9).toFixed(4)}  max $${q(deltas, 1).toFixed(2)}`);
    const worst = ok.sort((a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number)).slice(0, 3);
    for (const d of worst) {
      console.log(`    worst: ${d.conditionId.slice(0, 14)}… ours=${d.oursWithResid.toFixed(4)} theirs=${(d.theirs as number).toFixed(4)} Δ=${(d.delta as number).toFixed(4)}`);
    }
  }
  console.log("\nWallet-level context:");
  for (const wl of walletLevel) {
    console.log(`  ${wl.label}: portfolioValue=$${Number(wl.portfolioValue ?? 0).toFixed(2)}  openPositions(size≥1)=${wl.openPositions} (redeemable: ${wl.openRedeemable}, mark $${Number(wl.openMarkValue).toFixed(2)})`);
  }

  await mkdir("output/phase2", { recursive: true });
  await writeFile(
    "output/phase2/validation.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), perMarket, walletLevel }, null, 2),
  );
  console.log(`\n  ↳ wrote output/phase2/validation.json`);
  console.log(`Requests made: ${reqCount()}`);
  db.close();
}

// ---------------------------------------------------------------------------
// explain (Phase 2) — dump one (wallet × market) ledger for hand-checking
// ---------------------------------------------------------------------------
async function cmdExplain(args: Args): Promise<void> {
  if (!args.market) {
    console.log("usage: node src/cli.ts explain --market 0x… [--wallet 0x…]");
    return;
  }
  const db = openDb();
  const wallet = args.wallet ?? DEFAULT_WALLET;
  const cid = args.market;

  const meta = db.prepare(`SELECT * FROM markets WHERE conditionId = ?`).get(cid) as
    | Record<string, unknown>
    | undefined;
  console.log(`━━ market ${cid}`);
  if (meta) {
    console.log(`   "${meta.question}"  slug=${meta.slug}`);
    console.log(`   closed=${meta.closed} resolved=${meta.resolved} winner=${meta.winningOutcomeIndex} prices=${meta.outcomePrices} source=${meta.source} closedTime=${meta.closedTime}`);
  } else {
    console.log("   (no metadata row)");
  }

  const fills = db
    .prepare(`SELECT side, size, price, ts, outcomeIndex, asset FROM fills WHERE wallet = ? AND conditionId = ? ORDER BY ts`)
    .all(wallet, cid) as Array<{ side: string; size: number; price: number; ts: number; outcomeIndex: number | null; asset: string }>;
  const tokenOi = new Map(
    (db.prepare(`SELECT tokenId, outcomeIndex FROM tokens WHERE conditionId = ?`).all(cid) as Array<{ tokenId: string; outcomeIndex: number }>).map(
      (t) => [t.tokenId, t.outcomeIndex],
    ),
  );
  console.log(`\n━━ fills (${fills.length}) for wallet ${wallet}`);
  const fmtTs = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 19).replace("T", " ");
  const show = fills.length <= 40 ? fills : [...fills.slice(0, 20), null, ...fills.slice(-20)];
  for (const f of show) {
    if (f === null) {
      console.log(`   … ${fills.length - 40} more …`);
      continue;
    }
    const oi = tokenOi.get(f.asset) ?? f.outcomeIndex;
    console.log(`   ${fmtTs(f.ts)}  ${f.side.padEnd(4)} oi=${oi} ${String(f.size).padStart(12)} @ ${f.price}  = $${(f.size * f.price).toFixed(4)}`);
  }
  const acts = db
    .prepare(`SELECT type, ts, usdcSize, size, outcomeIndex FROM activity WHERE wallet = ? AND conditionId = ? ORDER BY ts`)
    .all(wallet, cid) as Array<{ type: string; ts: number; usdcSize: number; size: number | null; outcomeIndex: number | null }>;
  console.log(`\n━━ activity (${acts.length})`);
  for (const a of acts) {
    console.log(`   ${fmtTs(a.ts)}  ${a.type.padEnd(7)} oi=${a.outcomeIndex}  usdc=$${a.usdcSize}  size=${a.size}`);
  }

  const pnl = db.prepare(`SELECT * FROM market_pnl WHERE wallet = ? AND conditionId = ?`).get(wallet, cid) as
    | Record<string, unknown>
    | undefined;
  console.log(`\n━━ computed market_pnl row`);
  if (!pnl) {
    console.log("   (none — run `pnl` first)");
  } else {
    const n = (k: string) => Number(pnl[k] ?? 0);
    console.log(`   status=${pnl.status}  winner=${pnl.winnerIdx} (source=${pnl.winnerSource}, agree=${pnl.winnerAgree})`);
    console.log(`   buys:   qty0=${n("buyQty0").toFixed(4)} qty1=${n("buyQty1").toFixed(4)}  cost=$${n("buyCost").toFixed(4)}`);
    console.log(`   sells:  qty=${n("sellQty").toFixed(4)}  proceeds=$${n("sellProceeds").toFixed(4)}`);
    console.log(`   merge:  qty=${n("mergeQty").toFixed(4)}  cash=$${n("mergeCash").toFixed(4)}`);
    console.log(`   redeem: qty=${n("redeemQty").toFixed(4)}  cash=$${n("redeemCash").toFixed(4)}`);
    console.log(`   residual shares: oi0=${pnl.resid0 === null ? "·" : n("resid0").toFixed(4)}  oi1=${pnl.resid1 === null ? "·" : n("resid1").toFixed(4)}  value=$${pnl.residValue === null ? "·" : n("residValue").toFixed(4)}`);
    console.log(`   paired=${n("pairedQty").toFixed(4)}  directional=${n("directionalQty").toFixed(4)}`);
    console.log(`   ➜ cashPnl = redeem + merge + sells − buys = $${n("cashPnl").toFixed(4)}`);
  }
  db.close();
}

// ---------------------------------------------------------------------------
// analyze (Phase 3) — fully offline: H2 (maker/taker + fees), H3
// (decomposition), H1 stats. Reads taker_fills + cached receipts + market_pnl.
// ---------------------------------------------------------------------------
async function cmdAnalyze(args: Args): Promise<void> {
  const db = openDbReadOnly();
  const wallets = await usableWallets(args.wallet);
  const labels = new Map(wallets.map((w) => [w.address as string, w.label]));

  if (args.dryRun) {
    console.log("[dry-run] analyze runs fully offline over taker_fills, cached receipts and market_pnl,");
    console.log("          writing output/phase3/{maker-taker,fees,decomposition,stats}.json. No calls made.");
    db.close();
    return;
  }

  // Receipt manifest: reuse the persisted one; else rebuild (deterministic).
  let entries: ChainSampleEntry[];
  try {
    entries = JSON.parse(await (await import("node:fs/promises")).readFile("output/phase3/chain-manifest.json", "utf8")).entries;
  } catch {
    entries = buildChainSample(db, wallets.map((w) => w.address as string));
  }

  const pct = (x: number) => (100 * x).toFixed(1) + "%";
  const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const out: Record<string, unknown[]> = { makerTaker: [], feeRole: [], feedGap: [], decomposition: [], stats: [] };
  const gateFailures: string[] = [];

  for (const w of wallets) {
    const addr = w.address as string;
    const label = labels.get(addr) ?? addr.slice(0, 10);
    hr();
    console.log(`■ ${label}  (${addr})`);

    // H2a — maker/taker from the taker-subset sample
    const mt = walletMakerTaker(db, addr);
    out.makerTaker.push(mt);
    console.log(`  maker/taker (n=${mt.marketsSampled} sampled mkts):`);
    console.log(`    taker share — rows ${pct(mt.takerShareRows)} · qty ${pct(mt.takerShareQty)} · notional ${pct(mt.takerShareNotional)} (95% CI ${pct(mt.takerNotionalCI95.lo)}–${pct(mt.takerNotionalCI95.hi)})`);
    for (const e of mt.byEra) if (e.markets > 0) console.log(`    ${e.era}: taker ${pct(e.takerShareNotional)} over ${e.markets} mkts`);

    // H2b — on-chain fees + role validation
    const fr = analyzeFeeRole(db, entries, addr);
    out.feeRole.push(fr);
    const amtRate = fr.txAmountChecked ? fr.txAmountMatched / fr.txAmountChecked : 1;
    const roleRate = fr.roleChecked ? fr.roleAgreed / fr.roleChecked : 1;
    const amtRateV2 = fr.txAmountCheckedV2 ? fr.txAmountMatchedV2 / fr.txAmountCheckedV2 : 1;
    console.log(`  on-chain (${fr.txs} txs, ${fr.legs} legs; ${fr.makerLegs} maker / ${fr.takerLegs} taker; mint-matches ${fr.mintTxs} txs/${fr.mintLegs} legs):`);
    console.log(`    decode gate: post-V2 amounts ${fr.txAmountMatchedV2}/${fr.txAmountCheckedV2} (${pct(amtRateV2)}) · post-V2 maker-fee violations ${fr.makerLegFeeViolationsV2}  [all-era: ${fr.txAmountMatched}/${fr.txAmountChecked}, viol ${fr.makerLegFeeViolations} — V1 gross/fee-word quirks documented]`);
    console.log(`    role gate:   API vs chain agreed ${fr.roleAgreed}/${fr.roleChecked} (${pct(roleRate)}) · mixed-role txs ${fr.roleMixedTxs}`);
    console.log(`    fees (standard txs): ${fr.feeLegs} fee-bearing legs, total ${usd(fr.feeTotal)} · rate pre-V2 ${(100 * measuredFeeRate(fr, "pre-V2")).toFixed(3)}% · post-V2 ${(100 * measuredFeeRate(fr, "post-V2")).toFixed(3)}%`);
    if (fr.mintFeeWordLegs > 0) console.log(`    mint fee-word artifact: ${fr.mintFeeWordLegs}/${fr.mintLegs} mint legs carry a nonzero fee word (no cash left the wallet — see report)`);
    if (amtRateV2 < 0.99 && fr.txAmountCheckedV2 > 0) gateFailures.push(`${label}: post-V2 amount decode ${pct(amtRateV2)} < 99%`);
    if (fr.makerLegFeeViolationsV2 > 0) gateFailures.push(`${label}: ${fr.makerLegFeeViolationsV2} post-V2 maker legs with fee ≠ 0`);
    if (roleRate < 0.99 && fr.roleChecked > 0) gateFailures.push(`${label}: role agreement ${pct(roleRate)} < 99%`);

    // Feed-gap classification (pre-V2 wallets only produce samples)
    const fg = analyzeFeedGap(db, entries, addr);
    out.feedGap.push(fg);
    if (fg.marketsSampled > 0) {
      console.log(`  feed-gap: ${fg.marketsSampled} inflow mkts sampled (${usd(fg.sampledInflowValue)}) — mint evidence in ${fg.marketsWithMintEvidence} (${usd(fg.inflowValueWithMintEvidence)}, ${pct(fg.sampledInflowValue > 0 ? fg.inflowValueWithMintEvidence / fg.sampledInflowValue : 0)}), direct transfers-in ${fg.marketsWithDirectTransferIn}`);
    }

    // H3 — decomposition
    const dec = decomposeWallet(db, addr);
    out.decomposition.push(dec);
    console.log(`  H3 decomposition (${dec.markets} resolved mkts, identityErr ${dec.identityError.toExponential(1)}):`);
    console.log(`    paired ${usd(dec.pairedPnl)} + directional ${usd(dec.directionalPnl)} = ${usd(dec.totalPnl)}`);
    console.log(`    both-sides mkts ${dec.bothSidesMkts} · single-leg mkts ${dec.singleLegMkts} (PnL ${usd(dec.singleLegPnl)} — invisible to the article's pair metric)`);
    if (dec.pairCost) {
      console.log(`    pair cost (weighted): mean $${dec.pairCost.weightedMean.toFixed(4)} · p5 $${dec.pairCost.p5.toFixed(3)} · p50 $${dec.pairCost.p50.toFixed(3)} · p95 $${dec.pairCost.p95.toFixed(3)} · ${pct(dec.pairCost.sharePairsUnder1)} of ${Math.round(dec.pairCost.pairsTotal).toLocaleString("en-US")} sets < $1`);
    }
    if (Math.abs(dec.identityError) > 1) gateFailures.push(`${label}: decomposition identity error ${dec.identityError}`);

    // H1 — statistics
    const st = walletStats(db, addr);
    out.stats.push(st);
    console.log(`  H1 stats (${st.markets} mkts):`);
    console.log(`    mean/mkt $${st.meanPnl.toFixed(4)} (95% CI $${st.meanCI95.lo.toFixed(4)}…$${st.meanCI95.hi.toFixed(4)}) → total ${usd(st.totalPnl)} (CI ${usd(st.totalCI95.lo)}…${usd(st.totalCI95.hi)})`);
    console.log(`    median $${st.median.toFixed(3)} · p5 $${st.p5.toFixed(2)} · p95 $${st.p95.toFixed(2)} · positive mkts ${pct(st.pctPositive)} (zero: ${pct(st.pctZero)})`);
    console.log(`    max drawdown ${usd(st.maxDrawdown)} (${st.maxDrawdownDay ?? "—"}) · peak capital ${usd(st.peakCapital)} (${st.peakCapitalDay ?? "—"}) · return on peak ${st.returnOnPeakCapital === null ? "—" : pct(st.returnOnPeakCapital)}`);
  }

  hr();
  if (gateFailures.length) {
    console.log("⚠ GATES FAILED (spec §8 — investigate before publishing):");
    for (const g of gateFailures) console.log("  · " + g);
  } else {
    console.log("All Phase-3 gates passed (decode ≥99%, maker fee = 0, role agreement ≥99%, identity ≤ $1).");
  }

  await mkdir("output/phase3", { recursive: true });
  for (const [name, data] of Object.entries(out)) {
    const file = `output/phase3/${name === "makerTaker" ? "maker-taker" : name === "feeRole" ? "fees" : name === "feedGap" ? "feed-gap" : name}.json`;
    await writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), wallets: data }, null, 1));
    console.log(`  ↳ wrote ${file}`);
  }
  db.close();
}

// ---------------------------------------------------------------------------
// control (Phase 5) — random control group. Builds a pool of OTHER wallets
// trading the same crypto Up/Down markets, ranks the subjects within their
// PnL distribution (the selection-bias test). Network (resumable) then offline.
// ---------------------------------------------------------------------------
async function cmdControl(args: Args): Promise<void> {
  const { runControl, controlPlan } = await import("./ingest/fetch-control.ts");
  const { analyzeControl, histogramBinsSigned } = await import("./analysis/control.ts");
  const { histogramSvg, signedLog, PALETTE } = await import("./report/charts.ts");
  const db = openDbReadOnly();

  // Control-specific defaults (300 markets, 100 wallets) unless explicitly overridden.
  const nMarkets = process.argv.includes("--samples") ? args.samples : 300;
  const nWallets = process.argv.includes("--limit") ? args.limit : 100;
  if (args.dryRun) {
    const plan = controlPlan(db, nMarkets);
    console.log("PHASE 5 — control [dry-run]\n");
    console.log(`  crypto Up/Down universe (resolved): ${plan.universe.toLocaleString("en-US")} markets`);
    console.log(`  would sample ${plan.sampledMarkets} markets (${plan.cachedMarkets} cached) → participant pool`);
    console.log(`  then draw ${nWallets} active wallets and fetch /profit + /volume each`);
    console.log(`  ≈ ${plan.sampledMarkets - plan.cachedMarkets} + ~200 requests. Writes output/phase5/. No calls made.`);
    db.close();
    return;
  }

  console.log("PHASE 5 — control group (selection-bias test)\n");
  const res = await runControl(db, {
    markets: nMarkets,
    wallets: nWallets,
    concurrency: args.concurrency,
    delayMs: args.delayMs,
    log: stamp,
  });
  db.close();

  // Subjects' own Polymarket /profit — the identical metric (from Phase 2 oracle).
  const lb = JSON.parse(await (await import("node:fs/promises")).readFile("output/phase2/leaderboard-oracle.json", "utf8"));
  const labelByAddr = new Map((await usableWallets()).map((w) => [w.address as string, w.label]));
  const subjects = Object.values(lb.wallets as Record<string, { wallet: string; lbProfit: number }>).map((e) => ({
    label: labelByAddr.get(e.wallet.toLowerCase()) ?? e.wallet.slice(0, 8),
    wallet: e.wallet.toLowerCase(),
    profit: e.lbProfit,
  }));

  const stats = analyzeControl(res.metrics, subjects);
  const usd = (v: number) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const pct = (v: number) => (100 * v).toFixed(1) + "%";

  hr();
  console.log(`pool: ${res.poolSize.toLocaleString("en-US")} distinct wallets from ${res.sampledMarkets} markets; ${res.activePool} cleared the ≥${res.minMarkets}-market floor; ${res.drawn} drawn (${stats.n} with a /profit number, ${stats.nUnknown} null).`);
  console.log(`\ncontrol PnL distribution (Polymarket all-time /profit):`);
  console.log(`  % profitable: ${pct(stats.pctProfitable)}   population net PnL: ${usd(stats.totalPnl)}`);
  console.log(`  median ${usd(stats.median)}  mean ${usd(stats.mean)}  p5 ${usd(stats.p5)}  p25 ${usd(stats.p25)}  p75 ${usd(stats.p75)}  p95 ${usd(stats.p95)}`);
  console.log(`  range [${usd(stats.min)}, ${usd(stats.max)}]   median volume ${stats.medianVolume === null ? "—" : usd(stats.medianVolume)}`);
  console.log(`\nsubjects vs the control distribution:`);
  for (const s of stats.subjects.sort((a, b) => b.profit - a.profit)) {
    console.log(`  ${s.label.padEnd(14)} profit ${usd(s.profit).padStart(12)}  →  ${pct(s.percentile)} percentile (above ${Math.round(s.percentile * stats.n)}/${stats.n} controls)`);
  }

  // chart: signed-log histogram (mass near zero, tail to the subjects), subjects marked
  const bins = histogramBinsSigned(res.metrics, 34, 100);
  const markers = stats.subjects.map((s, i) => {
    const dl = s.label.startsWith("0x") ? s.label.slice(0, 6) : s.label;
    return { value: s.profit, label: `${dl} ${usd(s.profit)} (${pct(s.percentile)})`, color: PALETTE[i % PALETTE.length] };
  });
  const ticks = [-10000, -1000, -100, 0, 100, 1000, 10000, 100000, 500000];
  const svg = histogramSvg(bins, markers, {
    title: "Control-group profitability, with the 4 audited wallets marked",
    subtitle: `${stats.n} random wallets active in the same crypto Up/Down markets · Polymarket all-time profit · signed-log axis`,
    xLabel: "all-time realized profit (USDC) — signed-log scale",
    scale: (v) => signedLog(v, 100),
    ticks,
  });

  await mkdir("output/phase5", { recursive: true });
  await mkdir("docs/charts", { recursive: true });
  await writeFile("docs/charts/control-distribution.svg", svg);
  await writeFile(
    "output/phase5/control.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), frame: { sampledMarkets: res.sampledMarkets, poolSize: res.poolSize, activePool: res.activePool, minMarkets: res.minMarkets }, stats, metrics: res.metrics }, null, 1),
  );
  console.log(`\n  ↳ wrote output/phase5/control.json + docs/charts/control-distribution.svg`);
  console.log(`Requests made: ${reqCount()}`);
}

// ---------------------------------------------------------------------------
// report (Phase 4) — assemble the final deliverable (docs/report.md + charts).
// Fully offline: reads the Phase-2/3 artifacts, never the network or the DB.
// ---------------------------------------------------------------------------
async function cmdReport(args: Args): Promise<void> {
  if (args.dryRun) {
    console.log("PHASE 4 — report [dry-run]");
    console.log("  reads: output/phase2/{summary.json,daily-pnl.csv,validation.json,leaderboard-oracle.json}");
    console.log("         output/phase3/{stats,decomposition,maker-taker,fees,feed-gap}.json");
    console.log("  writes: docs/report.md + docs/charts/*.svg  (fully offline, no DB, no network)");
    return;
  }
  console.log("PHASE 4 — generating final report\n");
  const { generateReport } = await import("./report/generate.ts");
  const res = generateReport();
  console.log(`  ↳ wrote ${res.reportPath}`);
  for (const c of res.charts) console.log(`  ↳ wrote ${c}`);
  console.log(`\nDone. ${res.charts.length} charts + report.`);
}

// ---------------------------------------------------------------------------
// volume — print the report from the store (pass --sample 0 to skip network)
// ---------------------------------------------------------------------------
async function cmdVolume(args: Args): Promise<void> {
  const wallets = await usableWallets(args.wallet);
  const db = openDb();
  const repo = new Repository(db);
  const vols = [];
  for (const w of wallets) {
    const v = collectVolume(repo, w.address as string, w.label);
    if (args.sample > 0 && v.markets > 0) v.settlementSample = await sampleSettlement(repo, w.address as string, args.sample);
    vols.push(v);
  }
  console.log(formatVolume(vols));
  db.close();
}

// ---------------------------------------------------------------------------
function help(): void {
  console.log(`Polymarket PnL forensic auditor — CLI

Usage:
  node src/cli.ts resolve [--dry-run]
  node src/cli.ts recon   [--wallet 0x..] [--tx 0x..] [--limit N] [--dry-run]
  node src/cli.ts ingest  [--wallet 0x..] [--max-pages N] [--delay MS]
                          [--fills-only|--activity-only] [--sample N] [--dry-run]
  node src/cli.ts volume  [--wallet 0x..] [--sample N]   # report from store (--sample 0 = offline)
  node src/cli.ts ingest --topup [--wallet 0x..]        # extend completed streams to now (activity first)
  node src/cli.ts rebuild-fills [--dry-run]              # offline replay of raw cache (seq-keyed PK)
  node src/cli.ts backfill-markets [--concurrency N] [--delay MS] [--dry-run]
  node src/cli.ts pnl     [--dry-run]                    # build derived tables + summaries (offline)
  node src/cli.ts validate [--wallet 0x..] [--samples N] [--delay MS]
  node src/cli.ts explain --market 0x.. [--wallet 0x..]  # one-market ledger dump (offline)
  node src/cli.ts mt-ingest [--concurrency N] [--delay MS] [--dry-run]  # taker-subset sample (H2)
  node src/cli.ts chain-sample [--concurrency N] [--delay MS] [--dry-run] # on-chain receipts
  node src/cli.ts analyze [--wallet 0x..]                # maker/taker, fees, decomposition, stats (offline)
  node src/cli.ts report  [--dry-run]                    # final docs/report.md + SVG charts (offline)
  node src/cli.ts control [--samples M] [--limit N] [--concurrency N] [--delay MS] [--dry-run]
                          # Phase 5: random control group (M markets sampled, N wallets drawn)

Environment:
  POLYGON_RPC_URL   optional read-only Polygon RPC (provider key = reliable backfill)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "resolve":
      await cmdResolve(args);
      break;
    case "recon":
      await cmdRecon(args);
      break;
    case "ingest":
      await cmdIngest(args);
      break;
    case "backfill-markets":
      await cmdBackfillMarkets(args);
      break;
    case "rebuild-fills":
      await cmdRebuildFills(args);
      break;
    case "pnl":
      await cmdPnl(args);
      break;
    case "mt-ingest":
      await cmdMtIngest(args);
      break;
    case "chain-sample":
      await cmdChainSample(args);
      break;
    case "analyze":
      await cmdAnalyze(args);
      break;
    case "validate":
      await cmdValidate(args);
      break;
    case "explain":
      await cmdExplain(args);
      break;
    case "report":
      await cmdReport(args);
      break;
    case "control":
      await cmdControl(args);
      break;
    case "volume":
      await cmdVolume(args);
      break;
    default:
      help();
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
