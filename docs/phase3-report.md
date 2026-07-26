# Phase 3 — Analysis report (maker/taker, fees, decomposition, statistics)

**Date:** 2026-07-26 · **Scope:** the hypothesis-testing layer over the Phase-2 validated
cash-ledger PnL: H2 (maker/taker + fees + rebates), H3 (paired/directional decomposition
and the article's survivorship bias), H1 rigor (bootstrap CIs, drawdowns, capital), plus
on-chain attribution of the pre-V2 feed gap. Final synthesis/charts are Phase 4.

> PLACEHOLDER headline — filled from analyze results.

## Method summary

- **Maker/taker (H2):** the Data API honors `takerOnly=true` with a market filter
  (verified live), so the taker subset of fills was fetched for a deterministic
  stratified sample of 1,600 resolved markets (400/wallet, month strata, lexicographic
  conditionId order = fixed-seed draw). Maker share = 1 − taker share, by rows, share
  quantity and notional; CI by market-level bootstrap. Validated against on-chain roles.
- **On-chain sample:** 890 receipts (590 fee/role txs from the same market sample —
  overlap by construction — plus 300 txs from the largest pre-V2 inflow markets),
  fetched with null-result failover (public RPC fleets return `result:null` from pruned
  replicas — a lesson now encoded in `clients/onchain.ts`). `OrderFilled` decodes use
  the V1 topic (canonical hash, verified on real receipts) and the V2 topic (observed
  on-chain), both with the same 5-word layout; the `fee` word is trusted only after the
  empirical gate (amounts reconcile with local fills; maker legs must carry fee = 0).
- **Decomposition (H3):** average-cost pairing per market — `pairCost = avgPx(Up) +
  avgPx(Down)`, `pairedPnl = min(buyQty0, buyQty1) × (1 − pairCost)`, remainder is
  directional. The identity `paired + directional = cash + residValue` closes to
  ~1e-9 per wallet (property-tested and verified on the real store).
- **Statistics (H1):** seeded bootstrap (mulberry32, 10k resamples) for per-market mean
  and total CIs; daily realized equity curve → max drawdown; peak capital = maximum of
  the cumulative net cash outflow timeline at 1-second resolution (buys − sells −
  merges − redeems) — the most cash ever simultaneously at work.

## H2 — where the edge comes from

Taker share of volume (sampled markets; maker share = complement):

> PLACEHOLDER table: per wallet rows/qty/notional taker share + CI + per-era; on-chain
> role agreement; measured fees by era; rebates recap.

## H3 — pairs, directional remainders, and the article's blind spot

Confirmed so far (full tables from analyze):

- **`0xb27b…` (the merge machine):** paired PnL **+$1,335,629** vs directional
  **−$447,937** — the pairing/merging leg earns everything; the directional residue
  loses. 102.9M sets assembled at weighted-mean cost **$0.9870**, but only **64.7%**
  of sets cost < $1 (p95 $1.105): the article's "avg < $1" is true *on average* and
  hides a money-losing third of the flow.
- **`pspspsps5` (the "directional" one):** **51% of its markets (57,394) are
  single-leg-only — invisible to the article's pair metric — and they collectively
  lose $68,862.** That is the survivorship bias, measured. Its top series are
  doge-5m/hype-5m, not the BTC/ETH majors.

> PLACEHOLDER: full per-wallet decomposition table + pair-cost distribution table.

## H1 — statistical strength

> PLACEHOLDER: per-wallet mean CI, % positive markets, drawdowns, peak capital,
> return-on-peak, monthly PnL, fee-adjusted floor.

Early read (psps): mean +$1.49/market, 95% CI [$1.25, $1.73] — statistically nonzero;
median market is a small LOSS (−$1.17; only 38.5% of markets win) — the edge is a
right-tail phenomenon. Max drawdown $3,370 against a peak deployed capital of ~$2,855.

## Feed-gap attribution (pre-V2)

> PLACEHOLDER: share of sampled inflow value with mint-evidence (PositionSplit in the
> market's own fill txs), direct transfers, unresolved残.

## Gates (spec §8)

> PLACEHOLDER: decode ≥99%, maker fee = 0, role agreement ≥99%, identity ≤$1 — pass/fail
> with numbers.

## Reproduce

```bash
node src/cli.ts mt-ingest --concurrency 2 --delay 250    # taker subset (resumable)
node src/cli.ts chain-sample --concurrency 2 --delay 150 # 890 receipts (resumable)
node src/cli.ts analyze                                  # fully offline; writes output/phase3/*
npm test
```

## Limitations

- Maker/taker and fees are SAMPLE-based (1,600 markets / 890 txs, deterministic
  strata); CIs are reported, and the sampling frame is reproducible bit-for-bit.
- Decomposition uses average-cost pairing (disclosed above); FIFO pairing would shift
  attribution within markets, not totals.
- Peak-capital assumes zero starting inventory at each wallet's first observed fill
  (true by construction — the history starts at the wallet's first trade).
- The author-selected 4-wallet sample generalizes to nothing beyond itself (spec §3.6).
