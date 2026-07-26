# Phase 3 — Analysis report (maker/taker, fees, decomposition, statistics)

**Date:** 2026-07-26 · **Scope:** the hypothesis-testing layer over Phase-2's validated
cash-ledger PnL: H2 (maker/taker + fees + rebates), H3 (paired/directional decomposition,
the article's survivorship bias), H1 rigor (bootstrap CIs, drawdowns, capital), and
on-chain attribution of the pre-V2 feed gap. Final synthesis + charts are Phase 4.
Samples and bootstraps are deterministic (fixed strata + seeded PRNG) — a re-run
reproduces every number bit-for-bit.

## Headline

**H1 — yes, and statistically so.** Every wallet's per-market mean PnL has a 95%
bootstrap CI entirely above zero. **H2 — "the edge" is not one thing:** two wallets are
maker-dominant, one is taker-dominant, one is balanced; measured trading fees are ZERO,
so rebates ($589k measured) are pure subsidy on top of spread/selection profits.
**H3 — the article's "avg pair cost < $1" metric survives on averages but conceals
losing tails and ignores up to half of some wallets' markets.**

| | `pspspsps5` | `0xb27b…5b82` | `0xce25…7fdc` | `neversmiling` |
|---|---:|---:|---:|---:|
| Taker share (notional, CI95) | 17.4% (8–28%) | **11.7%** (9–15%) | **82.2%** (79–85%) | 45.2% (40–51%) |
| Mean PnL/market (CI95) | $1.49 (1.25–1.72) | $16.83 (14.66–19.03) | $7.13 (6.64–7.65) | $2.21 (1.94–2.48) |
| Markets positive | 38.5% | 62.3% | 54.7% | 47.5% |
| Median market | **−$1.17** | +$12.13 | +$1.95 | **−$0.75** |
| Paired PnL | +$211,842 | **+$1,335,629** | +$682,324 | +$218,464 |
| Directional PnL | −$43,786 | **−$447,937** | −$186,176 | −$65,334 |
| Single-leg markets (PnL) | **57,394 (−$68,862)** | 196 (−$410) | 5,229 (−$4,814) | 14,317 (+$21,139) |
| Pairs < $1 (weighted) | 62.2% | 64.7% | 60.6% | 60.2% |
| Max drawdown | $3,370 | $22,646 | **$529** | $884 |
| Peak capital deployed | $2,855 | **$1,747** | $9,240 | $2,511 |
| Trading PnL / peak capital | ~59× | ~508× | ~54× | ~61× |

## H2 — where the edge comes from

**Roles.** Taker subsets were fetched for 1,600 deterministically sampled markets
(400/wallet; the API's `takerOnly=true` honors a market filter — verified live) and the
classification was validated against on-chain `OrderFilled` topics: **380/380 sampled
transactions agree (100%)**, zero mixed-role transactions. The four wallets split
cleanly: `0xb27b…` (11.7% taker) and `pspspsps5` (17.4%, and **0.0% post-V2**) rest
orders; `0xce25…` takes liquidity (82.2%); `neversmiling` is balanced and visibly
changed style at the V2 migration (taker 25.3% pre → 60.4% post).

**Fees: measured zero.** Across 890 receipts, no sampled leg shows collected fees:
post-V2 the `OrderFilled` fee word is 0 outright (0 fee legs in 146/146 decoded ce25
txs and every other post-V2 leg). V1 legs *emit* a nonzero fee word (~10% of the output
amount — a fee-rate-bps allowance) **that was never settled**: share conservation
closes to ~0 on the API amounts and the Phase-2 cash ledger reconciles with
Polymarket's own accounting to cents — a collected fee of that magnitude would break
both. `config/constants.ts`'s provisional 7.2% schedule (secondary reporting) is
corrected to the measured 0. Consequence: **the Phase-2 cash figures ARE net trading
PnL**; the fee-adjusted "floor" equals the headline.

**Rebates are subsidy, not recycled fees.** With fees at zero, the measured $589,466 of
MAKER_REBATE/TAKER_REBATE/REWARD income is straight liquidity-program subsidy: 31.5% of
`0xb27b…`'s total income ($408k, maker program) and 19.4% of `0xce25…`'s ($120k —
*taker*-side rewards; its taker-dominance makes it the program's textbook client).

**H2 verdict (pending Phase-4 synthesis):** the article's "temporal arbitrage" frame
fits none of them. `0xb27b…` and `pspspsps5` earn as market makers (paired-leg profits
+ rebates); `0xce25…` earns as an aggressive taker whose selection is good enough to
survive crossing the spread — plus taker rewards; `neversmiling` blends both.

## H3 — pairs, directional remainders, and the article's blind spot

Average-cost pairing (`pairCost = avgPx(Up) + avgPx(Down)`, pairedPnl = sets × (1 −
pairCost); identity `paired + directional = total` closes to ≤4e-9 per wallet):

- **The paired leg earns everything; the directional remainder loses, everywhere.**
  Totals: paired **+$2.45M**, directional **−$743k** across the four wallets. Even the
  "directional" `pspspsps5` makes its money on the paired portion.
- **The "avg < $1" claim: true on average, misleading in distribution.** Weighted mean
  pair cost is $0.87–0.99 per wallet, but only **60–65% of assembled sets cost < $1**
  (p95: $1.10–1.20). A third of the flow completes pairs at a guaranteed loss —
  the price of unwinding one-sided inventory without selling (these wallets don't sell).
- **The survivorship bias, measured:** single-leg-only markets — invisible to any pair
  metric — are 51% of `pspspsps5`'s markets with **−$68,862** PnL, and +$21,139 across
  14,317 markets for `neversmiling`. An analysis that samples only completed pairs
  overstates `pspspsps5`'s edge and misses a quarter of the wallets' market count.
- Top series by PnL: `btc-5m` dominates for `0xb27b…` ($669k) and `0xce25…`;
  `pspspsps5`'s top earners are `doge-5m`/`hype-5m` — beyond the article's
  BTC/ETH/SOL/XRP universe.

## H1 — statistical strength

- **CIs exclude zero for all four wallets** (table above; seeded bootstrap, 10k
  resamples, per-market resampling of 52k–112k markets each).
- **The edge is a right-tail phenomenon for half of them:** `pspspsps5` and
  `neversmiling` LOSE the median market (38.5% / 47.5% positive) and profit on skew;
  `0xb27b…` and `0xce25…` win most markets outright.
- **Drawdowns are absurdly small relative to profits** — the largest observed daily-curve
  drawdown is $22,646 (`0xb27b…`, 2026-07-04) against $888k of trading profit; `0xce25…`
  never drew down more than $529 while making $496k.
- **Capital efficiency is the real story:** peak simultaneous cash deployment (1-second
  resolution over the full life) is $1.7k–$9.2k per wallet. These are not
  capital-intensive operations; they are high-velocity recycling machines — 5-minute
  cycles, all-in turnover of $135.8M on bankrolls of a few thousand dollars.

## Feed-gap attribution (pre-V2) — closed

All 80 sampled pre-V2 inflow markets (the largest by inflow value on both affected
wallets) contain CTF `PositionSplit` events inside their own fill transactions —
**mint-type matches, 100% of sampled value; zero direct token transfers found.** The
Phase-2 finding stands confirmed on-chain: Polymarket's V1 trade feed omitted mint-match
legs; the wallets bought those shares normally (the V2 feed reports such legs, and the
artifact vanishes at the cutover).

## Gates (spec §8)

| Gate | Result |
|---|---|
| Role agreement API vs chain | **380/380 (100%)** — pass |
| Post-V2 amount decode | **100%** every wallet — pass |
| Post-V2 maker-leg fee = 0 | **0 violations** — pass |
| Decomposition identity ≤ $1 | ≤ 4e-9 — pass |
| V1-era decode | documentary: fee word unsettled (~10% allowance), 2/583 txs emit ~3% gross-vs-net amounts; excluded from gating, published numbers unaffected (all PnL comes from the API cash ledger, independently validated in Phase 2) |

## Reproduce

```bash
node src/cli.ts mt-ingest --concurrency 2 --delay 250     # taker subsets (resumable)
node src/cli.ts chain-sample --concurrency 2 --delay 150  # 890 receipts (resumable)
node src/cli.ts analyze                                   # offline; writes output/phase3/*.json
npm test                                                  # 18 tests incl. decomposition identity
```

## Limitations

- Maker/taker and fee results are sample-based (1,600 markets / 890 receipts,
  deterministic strata; CIs reported). Fee coverage is per-leg on sampled txs — a fee
  charged outside `OrderFilled` (none is known) would not appear; the cent-level
  Phase-2 reconciliation against Polymarket's own accounting independently bounds any
  such channel.
- Average-cost pairing is an attribution choice (disclosed); totals are invariant.
- Pre-V2 taker shares inherit the V1 feed's mint-leg omission (mint legs are
  maker-side, so pre-V2 maker shares are if anything *understated*).
- Peak-capital assumes no starting inventory (true by construction: histories begin at
  each wallet's first fill) and measures net cash, not margin/collateral requirements.
- Four author-selected wallets generalize to nothing beyond themselves (spec §3.6).

**Phase 3 checkpoint: STOP.** Next per spec §7 — Phase 4: the final report
(`output/report.md` with verdict-first framing, per-wallet tables, SVG charts, CSV
exports) synthesizing Phases 0–3. Optional Phase 5: a random control group.
