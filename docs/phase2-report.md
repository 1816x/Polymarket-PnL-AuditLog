# Phase 2 — PnL engine report

**Date:** 2026-07-25 · **Scope:** market-metadata backfill (224k markets), the cash-ledger
PnL engine over the Phase-1 store, fixture tests, and external validation against
Polymarket's own numbers. Fees/maker-taker attribution and statistical testing are
**Phase 3**; every headline here is a *cash-ledger* figure (see "What these numbers are").

## Headline

> PLACEHOLDER — filled after the corrected build: per-wallet realized cash PnL + rebates,
> reconciliation vs Polymarket's own profit figures.

## What these numbers are (and are not)

Per (wallet × market), realized **cash PnL** = `Σ REDEEM.usdcSize + Σ MERGE.usdcSize +
sell proceeds − buy cost` — every number is cash that visibly moved in the public feeds.
Unredeemed shares in resolved markets are valued at settlement price (`residValue`).
Three deliberate exclusions:

1. **Rebates are a separate line, never inside market PnL.** All 600 rebate/reward rows are
   wallet-level (none carries a market id). They are *measured* income, reported separately
   (spec §8 rule 3).
2. **No fee estimates.** Taker fees exist on these markets in some periods, but they appear
   in **neither** `/trades` nor `/activity`, and the on-chain fee decode is Phase 3 work.
   If invisible fees exist, our cash PnL is an **upper bound** on trading PnL; the
   reconciliation below bounds how much room there is (spoiler: little).
3. **Unresolved/open markets are excluded** from the headline and counted separately.

## The data-loss bug this phase found and fixed

The Phase-1 fills PRIMARY KEY `(wallet, tx, asset, side, size, price, ts)` silently
collapsed **legitimate duplicate fills** — one taker order crossing several same-size
maker quotes in one transaction produces identical rows, common in busy 5-minute markets.
Compounding it, Phase-1 fetched fills *before* activity per wallet, so trades executed
during the ~2h ingest run were missed while their settlements were captured.

The symptom was unmistakable once the engine ran: **18,685 markets where more shares were
merged/redeemed than were ever bought** (settlement value ≈ $173.5k "appearing from
nowhere" = would-be phantom profit), and it did **not** net out across the 4 wallets — so
it was not intra-cluster transfers. Direct refetch of sample markets proved both causes:
a March market with identical DB/API time ranges but 226 rows lost purely to duplicate
collapse, and July-24 markets with 0 DB fills but hundreds of API fills.

**Fix:** (a) the fills PK now carries `seq`, the occurrence index of an identical tuple
within one API page — window-overlap refetches still dedup, true multiplicity survives;
(b) the whole fills table was rebuilt **offline from the append-only raw cache** (which
had preserved every page); (c) a top-up ingest extended all 8 streams to a fresh cutoff,
**activity before fills** per wallet, which makes the snapshot boundary self-consistent
(a market closing between the two cutoffs has complete fills and its pending redeem is
priced by `residValue` — no phantom cash).

> PLACEHOLDER — recovered-row counts per wallet + post-fix inflow census.

This is exactly why the spec insists on an append-only raw cache as the source of truth
(§2): the bug was fixed by replaying local files, not by re-downloading 19.9M rows.

## Validation

Five independent checks, from unit level to Polymarket's own accounting:

1. **Fixture tests** (14, `npm test`, in-memory DB): pair win, MERGE unwind, directional
   loss with zero-usdc redeem, sells, unclaimed winning shares, `oi=999` placeholder
   resolution via the token map, orphan redeems, open-market exclusion, 50/50 refunds,
   duplicate-fill preservation, idempotent rebuild, and a pseudo-random-ledger property
   test that the ledger closes exactly against the base tables.
   *(Runner is node:test, not the spec's vitest — same minimal-dependency precedent as
   node:sqlite over better-sqlite3.)*
2. **Ledger closure** on the real store: Σ market-level cash PnL reproduces the identity
   computed directly from the base tables to ~1e-9 dollars per wallet (float noise).
3. **Winner cross-validation:** metadata winners (Gamma, with the CLOB fallback) vs
   redeem-inferred winners agree on **every** market where both exist
   (> PLACEHOLDER n) — 0 disagreements.
4. **Per-market reconciliation vs Polymarket's own `realizedPnl`** (`/closed-positions`):
   > PLACEHOLDER — delta distribution.
5. **Wallet-level reconciliation vs Polymarket's leaderboard profit**
   (`lb-api.polymarket.com/profit`, window=all):
   > PLACEHOLDER — table ours-vs-theirs, gap explanation.

Plus 10 hand-checked markets (appendix below / `output/phase2/handchecks/`).

## Market-metadata backfill

All **224,305** conditionIds ever touched by these wallets now have settlement metadata +
an outcome-token map: 224,304 from batched Gamma (`/markets?condition_ids=…&closed=true`,
40 ids/request, 5,608 requests, ~6 min) + 1 via the CLOB per-id fallback. 0 unresolved
gaps; **0 fifty/fifty refunds** exist in this universe. The Phase-0 "Gamma is flaky for
condition_ids" finding is now explained: the endpoint **excludes closed markets by
default** — a resolved market vanishes from the default listing. `closed=true` fixes it;
coverage went from ~0% to 100.0%.

## Data-quality census (post-fix)

> PLACEHOLDER — orphan markets/cash, remaining inflow value, oi=999 tail, open markets,
> no-metadata tail, unredeemed residual value.

## Reproduce

```bash
node src/cli.ts backfill-markets            # 224k markets: gamma batches + clob fallback
node src/cli.ts rebuild-fills               # offline: replay raw cache into seq-keyed table
node src/cli.ts ingest --topup              # extend streams to now (activity first!)
node src/cli.ts pnl                         # build derived tables + print summaries
node src/cli.ts validate --samples 50       # reconcile vs Polymarket's own numbers
node src/cli.ts explain --market 0x… --wallet 0x…
npm test
```

## Appendix: hand-checked markets

> PLACEHOLDER — 10 markets, one line each: what was checked, expected vs computed.
