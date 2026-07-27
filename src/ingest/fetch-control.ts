/**
 * Phase 5 — random control group. Answers the audit's #1 limitation: are the
 * four author-selected wallets representative, or cherry-picked winners?
 *
 * Sampling frame = the `markets` table itself: ~224k RESOLVED crypto Up/Down
 * markets, i.e. the exact universe the subjects trade. We sample markets, read
 * their participant lists (`/trades?market=`), and thereby draw a pool of OTHER
 * wallets active in the *same* markets. PnL is then Polymarket's own all-time
 * `/profit` per wallet — the identical metric already used (and validated to
 * cents) for the subjects, so the comparison is apples-to-apples.
 *
 * Deliberate, disclosed frame properties:
 *  - Market-sampling over-represents ACTIVE wallets (a wallet in thousands of
 *    markets is almost surely caught; a one-off punter rarely is). That is the
 *    correct comparison cohort for these high-frequency subjects, not a bug.
 *  - We keep wallets appearing in ≥ minMarkets of the sample (an activity floor)
 *    and sample uniformly from that set — so the final draw is uniform over
 *    active wallets, not trade-weighted.
 *  - Disk is tight (a bloated 26 GB subject DB); this phase re-ingests NOTHING —
 *    it caches small JSON only and leans on Polymarket's validated number.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import type { Db } from "../store/schema.ts";
import { getMarketTrades, getLeaderboardProfit, getLeaderboardVolume } from "../clients/data.ts";
import { SUBJECT_ADDRESSES } from "../config/constants.ts";

const MKT_DIR = "data/raw/control/markets";
const WALLET_DIR = "data/raw/control/wallets";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ControlOptions {
  markets?: number; // markets to sample for the pool (default 300)
  wallets?: number; // control wallets to draw (default 100)
  minMarkets?: number; // activity floor: appears in ≥ this many sampled markets (default 3)
  concurrency?: number;
  delayMs?: number;
  log?: (m: string) => void;
}

export interface WalletMetric {
  wallet: string;
  appearances: number; // sampled markets the wallet traded in
  profit: number | null; // Polymarket all-time /profit
  volume: number | null; // Polymarket all-time /volume
  name?: string | null;
}

export interface ControlResult {
  sampledMarkets: number;
  poolSize: number; // distinct non-subject wallets found
  activePool: number; // wallets clearing the activity floor
  drawn: number; // control wallets fetched
  metrics: WalletMetric[];
  minMarkets: number;
}

/** Even, deterministic stride over conditionId-sorted resolved crypto markets. */
function sampleMarketIds(db: Db, count: number): string[] {
  const total = Number(
    (db.prepare(
      `SELECT COUNT(*) c FROM markets WHERE resolved = 1 AND (slug LIKE '%-updown-%' OR slug LIKE '%-up-or-down-%')`,
    ).get() as { c: number }).c,
  );
  if (total === 0) return [];
  const stride = Math.max(1, Math.floor(total / count));
  // ROW_NUMBER over a stable order, take every `stride`-th — deterministic + spread.
  return (
    db
      .prepare(
        `SELECT conditionId FROM (
           SELECT conditionId, ROW_NUMBER() OVER (ORDER BY conditionId) rn
           FROM markets WHERE resolved = 1 AND (slug LIKE '%-updown-%' OR slug LIKE '%-up-or-down-%')
         ) WHERE (rn - 1) % ? = 0 LIMIT ?`,
      )
      .all(stride, count) as Array<{ conditionId: string }>
  ).map((r) => r.conditionId);
}

function readGz(path: string): unknown {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
}
function writeGz(path: string, data: unknown): void {
  writeFileSync(path, gzipSync(JSON.stringify(data)));
}

export async function runControl(db: Db, opts: ControlOptions = {}): Promise<ControlResult> {
  const nMarkets = opts.markets ?? 300;
  const nWallets = opts.wallets ?? 100;
  const minMarkets = opts.minMarkets ?? 3;
  const concurrency = opts.concurrency ?? 3;
  const delayMs = opts.delayMs ?? 120;
  const log = opts.log ?? (() => {});
  mkdirSync(MKT_DIR, { recursive: true });
  mkdirSync(WALLET_DIR, { recursive: true });

  // ---- Pass A: build the participant pool from sampled markets ----
  const marketIds = sampleMarketIds(db, nMarkets);
  const appearances = new Map<string, number>();
  let mi = 0;
  let doneM = 0;
  const t0 = Date.now();
  const poolWorker = async (): Promise<void> => {
    for (;;) {
      const i = mi++;
      if (i >= marketIds.length) return;
      const cid = marketIds[i];
      const path = `${MKT_DIR}/${cid}.json.gz`;
      let wallets: string[];
      if (existsSync(path)) {
        wallets = readGz(path) as string[];
      } else {
        const trades = await getMarketTrades(cid, 500);
        wallets = [...new Set(trades.map((t) => t.proxyWallet.toLowerCase()))];
        writeGz(path, wallets);
        if (delayMs > 0) await sleep(delayMs);
      }
      for (const w of wallets) {
        if (SUBJECT_ADDRESSES.has(w)) continue;
        appearances.set(w, (appearances.get(w) ?? 0) + 1);
      }
      doneM++;
      if (doneM % 50 === 0 || doneM === marketIds.length) {
        const rate = doneM / Math.max((Date.now() - t0) / 1000, 0.001);
        log(`pool ${doneM}/${marketIds.length} markets · ${appearances.size} distinct wallets · ${rate.toFixed(1)} mkt/s`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, poolWorker));

  // ---- Draw the control sample: activity floor, then uniform (by wallet hash order) ----
  const active = [...appearances.entries()].filter(([, c]) => c >= minMarkets);
  // Deterministic uniform draw: sort by wallet string (uniform hex) and take first N.
  active.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const drawn = active.slice(0, nWallets);
  log(`pool complete: ${appearances.size} wallets, ${active.length} clear the ≥${minMarkets}-market floor; drawing ${drawn.length}`);

  // ---- Pass B: Polymarket /profit + /volume per drawn wallet ----
  const metrics: WalletMetric[] = [];
  let wi = 0;
  let doneW = 0;
  const metricWorker = async (): Promise<void> => {
    for (;;) {
      const i = wi++;
      if (i >= drawn.length) return;
      const [wallet, appearancesN] = drawn[i];
      const path = `${WALLET_DIR}/${wallet}.json.gz`;
      let m: { profit: number | null; volume: number | null };
      if (existsSync(path)) {
        m = readGz(path) as { profit: number | null; volume: number | null };
      } else {
        const profit = await getLeaderboardProfit(wallet).catch(() => null);
        const volume = await getLeaderboardVolume(wallet).catch(() => null);
        m = { profit, volume };
        writeGz(path, m);
        if (delayMs > 0) await sleep(delayMs);
      }
      metrics.push({ wallet, appearances: appearancesN, profit: m.profit, volume: m.volume });
      doneW++;
      if (doneW % 25 === 0 || doneW === drawn.length) log(`metrics ${doneW}/${drawn.length} wallets`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, metricWorker));

  metrics.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  return {
    sampledMarkets: marketIds.length,
    poolSize: appearances.size,
    activePool: active.length,
    drawn: drawn.length,
    metrics,
    minMarkets,
  };
}

/** Dry-run: how many markets a control run would sample (no network). */
export function controlPlan(db: Db, markets = 300): { universe: number; sampledMarkets: number; cachedMarkets: number } {
  const universe = Number(
    (db.prepare(
      `SELECT COUNT(*) c FROM markets WHERE resolved = 1 AND (slug LIKE '%-updown-%' OR slug LIKE '%-up-or-down-%')`,
    ).get() as { c: number }).c,
  );
  const ids = sampleMarketIds(db, markets);
  let cached = 0;
  for (const cid of ids) if (existsSync(`${MKT_DIR}/${cid}.json.gz`)) cached++;
  return { universe, sampledMarkets: ids.length, cachedMarkets: cached };
}
