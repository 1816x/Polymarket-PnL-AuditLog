# Polymarket PnL Forensic Auditor

A **read-only** forensic tool that computes the *realized, net-of-fees PnL* of specific
Polymarket wallets that trade the short-term Up/Down crypto markets (BTC/ETH/SOL/XRP,
5m/15m/1h windows).

## Why this exists

A widely-shared article profiled ~1,000 trading bots on these markets and described a
"hybrid paired + directional" strategy as popular and profitable — **but it never
reported PnL.** It described *behavior*, not *results*. This project answers the question
the article dodges, with numbers, over public data:

- **H1 — Profitability.** Do these wallets have positive, statistically-nonzero,
  sustained net realized PnL?
- **H2 — Source of edge.** If profitable, is the edge maker rebates + spread capture
  (market-making) rather than the "temporal arbitrage" the article claims? → measured by
  the **maker/taker** ratio of their fills.
- **H3 — Survivorship bias.** The article's "avg combined cost < \$1" metric ignores
  unpaired legs. → we count and value unpaired inventory at settlement.

A negative or inconclusive result is just as valid as a positive one. This is an audit,
not an advertisement — see the hard rigor rules in the spec (§8).

## Safety / scope

- **Read-only. Public data only. No wallet private key is ever used or needed** (spec §9).
  If a step ever seems to require one, that is a bug — stop.
- The only optional credential is a Polygon RPC provider URL (`POLYGON_RPC_URL`) — that is
  read-only infrastructure, not a wallet key.
- We are **not** building a bot and **not** trading.

## Status: Phase 3 (analysis) — complete

Per the spec's phased workflow (§7), work stops for review after each phase. Reports:
**[`docs/phase0-report.md`](docs/phase0-report.md)** (recon),
**[`docs/phase1-report.md`](docs/phase1-report.md)** (ingest),
**[`docs/phase2-report.md`](docs/phase2-report.md)** (PnL + validation),
**[`docs/phase3-report.md`](docs/phase3-report.md)** (hypotheses).

Phase 2 headline — **all four auditable wallets are profitable** on a validated
cash-ledger basis (full life, through 2026-07-25): trading PnL **$1.7M** plus **$589k
of measured rebates** ≈ **$2.29M total**, reproducing Polymarket's own per-market and
leaderboard accounting to cents / ±0.07–1.5%.

Phase 3 headline — the result is **statistically solid and mechanically explained**:
every wallet's per-market mean PnL CI excludes zero; measured trading fees are **0**
(so the cash figures are net); the four wallets split into two makers (89%/83% maker),
a taker (82%), and a hybrid; the **paired leg earns everything (+$2.45M) while
directional remainders lose (−$743k)**; only 60–65% of assembled pairs cost < $1 (the
article's "avg < $1" hides the losing tail), and single-leg markets the article's
metric can't see are up to 51% of a wallet's activity. Peak deployed capital:
**$1.7k–$9.2k per wallet** — high-velocity recycling, not capital intensity. The pre-V2
"phantom inflow" is closed: 80/80 sampled markets show V1-feed-omitted **mint-match
legs** on-chain. Remaining: Phase 4 (final synthesis report + charts).

Phase 0 (reconnaissance) headline:

- The read-only premise **holds** — the whole pipeline needs no auth and no keys.
- 4 of 5 subject wallets resolve cleanly; **`BadFallen` does not resolve** and is excluded
  and documented (spec §1) rather than guessed.
- Two spec assumptions proved **false** and are handled: (1) maker/taker is **not** in any
  public per-wallet API — it is reconstructed from on-chain `OrderFilled` events; (2) a
  **CLOB V2 migration (Apr 28 2026)** bifurcates contracts/collateral/data, so the tool is
  date-partitioned. Maker/taker reconstruction is validated on real fills (both roles).

Phase 1 (ingest) headline — **~19.9M fills** downloaded to a resumable cache:

- **The bots essentially don't sell** — 131 sells in 19.9M fills; positions unwind via
  REDEEM + MERGE. The article's buy-only claim is confirmed (spec §3.2).
- **~585k USDC of *measured* maker rebates** — a strong early signal for H2.
- Behaviour separates the wallets: `0xb27b…` is a high-frequency market-maker (288
  fills/market, 342k merges); `pspspsps5` is directional (0 merges). 100% of sampled
  markets resolved.

## Install & run

Requires **Node ≥ 22** (uses native TypeScript type-stripping and native `fetch` — no build
step, no `tsx`).

```bash
npm install

# Phase 0 — resolve subjects + recon raw data shapes
node src/cli.ts resolve                                   # usernames -> proxy addresses
node src/cli.ts recon --wallet 0xce25…7fdc --limit 8      # raw fills/activity/settlement/on-chain

# Phase 1 — full resumable ingest (fills + non-trade activity, append-only raw cache)
node src/cli.ts ingest --dry-run                          # show resume state / plan
node src/cli.ts ingest                                    # idempotent; resumes after interruption
node src/cli.ts ingest --topup                            # extend completed streams to now
node src/cli.ts volume --sample 0                         # volume report from the store (offline)

# Phase 2 — market metadata, PnL engine, validation
node src/cli.ts backfill-markets                          # settlement + token map for every market
node src/cli.ts rebuild-fills                             # offline raw-cache replay (seq-keyed PK)
node src/cli.ts pnl                                       # build positions/settlements/market_pnl + summaries (offline)
node src/cli.ts validate --samples 50                     # reconcile vs Polymarket's own realizedPnl
node src/cli.ts explain --market 0x… --wallet 0x…         # one-market ledger dump for hand-checking

npm test                              # fixture tests (node --test, in-memory DB)
npm run typecheck                     # tsc --noEmit
```

Every command supports `--dry-run` (prints the request plan without calling). All analysis
commands are fully offline. Generated dumps land in `output/` (gitignored — regenerable).

## Architecture

Fetch and analysis are **fully decoupled**: everything is downloaded to an append-only
on-disk cache first, then analysis runs offline over local files (reproducibility). Clients
never compute; analysis never fetches.

```
src/
  config/constants.ts   endpoints, verified contract addresses (V1/V2), fee schedule,
                        the V2 cutover, subject wallets
  clients/              thin, zod-validated wrappers (no business logic):
    http.ts             fetch + JSON-RPC, retry/backoff+jitter, request counter
    gamma.ts            profile resolution + batched market metadata (closed=true!)
    data.ts             /trades, /activity, /closed-positions, /positions, /value
    clob.ts             /markets/<conditionId> — per-id settlement fallback
    onchain.ts          Polygon OrderFilled decode — maker/taker + fee oracle
  ingest/
    resolve-wallets.ts  exact-match resolution w/ round-trip verification
    paginate.ts         end-cursor time pagination + top-up; never offset paging
    cache.ts            append-only gzipped raw page cache (source of truth)
    fetch-fills.ts / fetch-activity.ts / fetch-markets.ts / rebuild-fills.ts
  store/
    schema.ts           SQLite DDL (node:sqlite; fills PK carries seq — see below)
    repository.ts       typed reads/writes, idempotent inserts, checkpoints
  analysis/
    pnl.ts              Phase 2 engine: positions/settlements/market_pnl + summaries
  cli.ts                resolve | recon | ingest | backfill-markets | rebuild-fills |
                        pnl | validate | explain | volume
tests/pnl.test.ts       fixture ledgers with known PnL (node --test, in-memory DB)
```

**Accounting model (Phase 2):** per (wallet × market), realized **cash-ledger** PnL =
`Σ REDEEM.usdcSize + Σ MERGE.usdcSize + sells − buys`; unredeemed shares are valued at
settlement price; rebates are wallet-level (their rows carry no market) and always reported
as a separate line; no estimated quantity ever mixes into a measured column (spec §8).

**Hard-won data lessons** (each cost real debugging, all covered by tests): Gamma's
`/markets` hides closed markets unless `closed=true` is passed; `/trades` can contain
LEGITIMATE duplicate rows (one taker order crossing several same-size quotes in one tx) so
the fills PK carries an occurrence counter `seq`; top-ups must fetch activity BEFORE fills
or settlement cash appears without its fills (phantom inflows).

Phases 3–5 (fees/maker-taker/stats → report → optional control group) build on this; see
`docs/phase*-report.md` for the per-phase checkpoints.
