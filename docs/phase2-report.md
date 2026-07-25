# Phase 2 — PnL engine report

**Date:** 2026-07-25 · **Scope:** market-metadata backfill (224,717 markets), the
cash-ledger PnL engine over the full ingested history, fixture tests, and external
validation against Polymarket's own numbers. Fees/maker-taker attribution and statistical
testing are **Phase 3**; every figure here is a *cash-ledger* figure (see "What these
numbers are"). Snapshot cutoff: 2026-07-25 ~01:40 UTC.

## Headline

**All four auditable wallets are profitable, and the result is validated against
Polymarket's own accounting.** Realized trading PnL (cash basis) plus measured rebates,
over each wallet's full life:

| Wallet | Active | Markets | Buy volume | Trading PnL (cash) | Rebates (measured) | **Total** | ≈/day |
|---|---|---:|---:|---:|---:|---:|---:|
| `pspspsps5` | 2025-12-03 → 07-25 (235d) | 112,564 | $4.11M | $168,056 | $11,365 | **$179,421** | $763 |
| `0xb27b…5b82` | 2026-03-03 → 07-25 (144d) | 52,760 | $104.57M | $887,692 | $408,258 | **$1,295,950** | $9,000 |
| `0xce25…7fdc` | 2026-04-30 → 07-25 (86d) | 69,620 | $18.98M | $496,148 | $119,570 | **$615,719** | $7,159 |
| `neversmiling` | 2026-04-01 → 07-25 (115d) | 69,365 | $8.14M | $153,130 | $50,273 | **$203,403** | $1,769 |
| **Total** | | 304,309 wallet-mkts | **$135.81M** | **$1,705,026** | **$589,466** | **$2,294,493** | |

Two accounting caveats bound (not reverse) this result:

1. **Pre-V2 feed gap (quantified below):** $141,456 of the trading PnL is settlement
   proceeds of shares whose acquisition the public trade feed never recorded (all but
   ~$150 of it before the Apr-28 CLOB-V2 migration). Treating those positions as
   excluded — which is exactly what Polymarket's own profit metric does — trading PnL is
   **$1,563,571**. True trading PnL lies in **[$1.56M, $1.71M]**; totals incl. rebates in
   **[$2.15M, $2.29M]**. Every wallet is solidly profitable at either bound.
2. **Fees:** no fee estimates are included (Phase 3 measures them on-chain). The
   reconciliation below leaves at most ~1.5% of room for invisible fees on one wallet and
   ~0.3% on the others.

**Preliminary hypothesis reads** (formal tests in Phase 3): **H1** — all four wallets show
sustained positive realized PnL over 3–8 months; pending fee resolution and significance
testing. **H2** — rebates are *measured* at 31.5% of `0xb27b…`'s total income ($408k of
$1.30M): a material, non-speculative part of the edge. **H3** — the engine now carries
per-market paired/directional decomposition for Phase 3; note the *worst* return on buy
volume belongs to the biggest paired merger (`0xb27b…`, 0.85%) and the best to the
directional wallet (`pspspsps5`, 4.09%).

## What these numbers are (and are not)

Per (wallet × market), realized **cash PnL** = `Σ REDEEM.usdcSize + Σ MERGE.usdcSize +
sell proceeds − buy cost` — every term is cash that visibly moved in the public feeds
(19,925,095 fills; 683,802 activity rows). Unredeemed shares in resolved markets are
valued at settlement price (`residValue`; $531.63 across all four wallets — these bots
leave nothing on the table). Rebates are wallet-level rows (none carries a market id) and
are **never** mixed into market PnL (spec §8 rule 3). Open/unresolved markets are excluded
from the headline: 19 markets, $2,381 net cash at risk at snapshot.

## The data-loss bug this phase found and fixed

The Phase-1 fills PRIMARY KEY `(wallet, tx, asset, side, size, price, ts)` silently
collapsed **legitimate duplicate fills** — one taker order crossing several same-size
maker quotes in one transaction yields identical rows (a busy 5-minute market showed 226
such rows). Separately, Phase-1 fetched fills *before* activity per wallet, so trades
executed during the ~2h ingest run were missed while their settlements were captured.

The engine surfaced it immediately: markets where more shares were merged/redeemed than
ever bought, worth ~$173.5k at settlement — and the value did **not** net out across the
4 wallets, killing the "intra-cluster transfer" explanation. Direct API refetches proved
both causes (a March market bit-identical to the API after the fix; July-24 markets with
0 stored fills but hundreds live).

**Fix:** the PK now carries `seq` (occurrence index of an identical tuple within one API
page — window-overlap refetches still dedup, true multiplicity survives); the fills table
was rebuilt **offline from the append-only raw cache** (+3,052 rows); a top-up ingest
extended all streams to a fresh cutoff, **activity before fills** per wallet so the
snapshot boundary is self-consistent (a market closing between the two cutoffs has
complete fills and its pending redeem is priced by `residValue`, never phantom cash).
This is what spec §2's append-only raw cache is for: the repair replayed local files.

## The remaining "inflows" are a pre-V2 gap in Polymarket's own feed

After the fix, share inflows collapsed to ~zero on the two mostly-post-V2 wallets
(`pspspsps5` $28, `0xce25…` $92) but persisted on `0xb27b…` ($127,973 over 13,257
markets) and `neversmiling` ($13,363 over 5,049). The time distribution is decisive —
`0xb27b…` by month: Mar $77,370 · Apr $50,518 · **May $50 · Jun $34**; `neversmiling`:
$13,302 pre-cutover vs $61 after. The inflows stop at the **Apr-28 CLOB-V2 migration**.

Conclusion: the pre-V2 `/trades` feed under-reports some fill legs (both wallets run
both-sides maker flow; the pattern is consistent with mint-type match legs, resolvable
on-chain in Phase 3). It is a *feed* artifact, not a wallet behavior: the same gap exists
in Polymarket's own accounting, which is why excluding those proceeds reconciles us to
their profit figure almost exactly (next section).

## Validation

Six independent checks, unit level → Polymarket's own accounting:

1. **Fixture tests** (14, `npm test`, in-memory DB): pair win, MERGE unwind, directional
   loss with zero-usdc redeem, sells, unclaimed winning shares, `oi=999` placeholder
   resolution via the token map, orphan redeems, open-market exclusion, 50/50 refunds,
   duplicate-fill preservation, idempotent rebuild, and a pseudo-random-ledger property
   test that the ledger closes exactly. *(Runner is node:test, not the spec's vitest —
   same minimal-dependency precedent as node:sqlite over better-sqlite3.)*
2. **Ledger closure on the real store:** Σ market-level cash PnL reproduces the identity
   computed directly from the base tables to ≤ 4×10⁻⁹ dollars per wallet.
3. **Winner cross-validation:** metadata winners vs paying-redeem winners agree on all
   **239,109** wallet-markets where both exist — **0 disagreements**. (Gamma vs the 600
   CLOB-sourced Phase-1 rows: also 0.)
4. **Per-market reconciliation vs Polymarket's own realizedPnl** — 50 sampled markets per
   wallet (top-|PnL| half + evenly-spaced half), against `/closed-positions` **plus**
   `/positions` (Polymarket splits a market across both when a leftover leg exists;
   summing both matched a −$555.06 merge-remainder market to the cent). |Δ| per market:
   | Wallet | median | p90 | max |
   |---|---:|---:|---:|
   | `pspspsps5` | $0.0095 | $0.039 | $0.12 |
   | `0xce25…` | $0.0174 | $0.163 | $0.66 |
   | `neversmiling` | $0.0012 | $1.80 | $19.42 |
   | `0xb27b…` | $1.06 | $29.48 | $369.77 |
   Splitting the 200 samples by era: **post-V2 median $0.0122**; pre-V2 median $1.72 —
   the tails are exactly the pre-V2 feed-gap markets.
5. **Wallet-level reconciliation vs Polymarket's leaderboard profit**
   (`lb-api.polymarket.com/profit?window=all`, fetched 2026-07-25):
   | Wallet | Ours (feed-visible trading) | Polymarket | Δ |
   |---|---:|---:|---:|
   | `pspspsps5` | $168,029 | $168,450 | −0.25% |
   | `0xb27b…5b82` | $759,719 | $770,972 | −1.46% |
   | `0xce25…7fdc` | $496,056 | $495,709 | +0.07% |
   | `neversmiling` | $139,767 | $140,333 | −0.40% |
   Polymarket's profit metric evidently excludes rebates (gaps would otherwise be
   rebate-sized) and reads the same trade feed. Two implications: our engine reproduces
   their number from raw public data, and there is little room left for large invisible
   taker fees (ours would sit *above* theirs by the fee amount; it doesn't).
6. **10 hand-checked markets** (`output/phase2/handchecks/`, regenerable via `explain`):
   biggest win/loss, the heaviest-merge market, a pre-V2 feed-gap market, a pure
   directional loss (180 buys averaging down to $0.02 — cash −$1,372.10 vs Polymarket
   −$1,371.98), a merge-with-remainder market matching Polymarket to the cent once
   closed+open rows are summed, the recovered trailing-edge market (71 fills incl.
   preserved same-second duplicates), and a market with sells.

## Data-quality census (post-fix)

| Metric | Value |
|---|---|
| Fills / activity rows | 19,925,095 / 683,802 |
| Distinct markets (global) | 224,717 — 100% with metadata + token map |
| Winner sources disagreeing | 0 (of 239,109 dual-source wallet-markets) |
| 50/50 refund markets | 0 in this universe |
| `oi=999` placeholder fills | 7 (outcome resolved via token map) |
| Orphan-activity markets | 2 ($25.06) |
| Open/unresolved at snapshot | 19 markets, −$2,381 net cash |
| Unredeemed winning-share value | $531.63 (priced into totals) |
| Pre-V2 feed-gap proceeds | $141,456 (bounded, both treatments reported) |
| Ledger-closure error | ≤ 4×10⁻⁹ $ per wallet |

## Limitations (unsoftened)

- **Fees are not yet measured.** Cash-ledger PnL is gross of any CLOB fee that never
  appears in the public feeds. The reconciliation bounds the exposure (≤ ~1.5% on
  `0xb27b…`, ≤ ~0.3% elsewhere; and rebates — $589k — are *income* actually received),
  but Phase 3's on-chain `OrderFilled` work is what settles it.
- **The pre-V2 trade feed is provably incomplete** ($141k of unexplained-acquisition
  proceeds). We report both treatments; on-chain reconstruction can attribute it exactly.
- **These four wallets were chosen by the article's author** — nothing here generalizes
  to "the ~1,000 bots" (spec §3.6). A control group is Phase 5 (optional).
- **No statistical significance yet** — per-market PnL distributions, bootstrap CIs and
  drawdowns are Phase 3; "sustained" above is descriptive (monthly cash by resolution day
  is in `output/phase2/daily-pnl.csv`).
- Polymarket's leaderboard profit is itself derived from the same public data and is used
  as a *consistency* oracle, not ground truth.

## Reproduce

```bash
node src/cli.ts backfill-markets            # 224k markets: gamma batches + clob fallback
node src/cli.ts rebuild-fills               # offline: replay raw cache into seq-keyed table
node src/cli.ts ingest --topup              # extend streams to now (activity first!)
node src/cli.ts pnl                         # build derived tables + summaries + artifacts
node src/cli.ts validate --samples 50       # reconcile vs Polymarket's own numbers
node src/cli.ts explain --market 0x… --wallet 0x…
npm test
```

Artifacts (gitignored, regenerable): `output/phase2/{summary.json, daily-pnl.csv,
extreme-markets.csv, validation.json, leaderboard-oracle.json, handchecks/}`.

**Phase 2 checkpoint: STOP.** Next per spec §7 — Phase 3: on-chain maker/taker + fees
(`OrderFilled`), rebate attribution, paired/directional decomposition (H3), and the
statistical layer (bootstrap CIs, equity curves, drawdowns).
