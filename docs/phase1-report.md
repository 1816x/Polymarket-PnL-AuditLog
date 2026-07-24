# Phase 1 — Ingest report

**Date:** 2026-07-24 · **Scope:** full, resumable download of all fills + non-trade
activity for the 4 auditable wallets, decoupled from analysis (spec §2). Reports
volume only — **no PnL is computed yet** (that is Phase 2).

## Headline

**~19.9 million fills** across the 4 wallets were downloaded to a resumable on-disk
cache and indexed. Two findings already bear directly on the hypotheses:

- **The bots essentially do not sell.** 131 SELL fills out of **19,897,878** total
  (0.0007%); three of the four wallets have **exactly zero** sells. The article's
  "they only buy" claim is **confirmed** — positions are unwound via **REDEEM**
  (settlement) and **MERGE** (combining Up+Down sets back to $1), not selling.
- **Large *measured* maker rebates** (~**585,000 USDC** total across the 4 wallets,
  from `MAKER_REBATE`/`TAKER_REBATE`/`REWARD` activity rows). This is measured, not
  estimated, and is a strong early signal for **H2** (edge = market-making rebates,
  not "temporal arbitrage"). Attribution/sign is confirmed in Phase 3.

## Volume by wallet

| Wallet | Fills | Distinct markets | Date range | Sells | Fills/mkt | Merges | Redeems | Measured rebates (USDC) | Settled (sample) |
|---|---:|---:|---|---:|---:|---:|---:|---:|:--:|
| `0xb27b…5b82` | **15,203,458** | 52,671 | 2026-03-03 → 07-24 | 131 | **288.6** | 342,461 | 123,988 | 407,230 | 150/150 |
| `neversmiling` | 1,729,942 | 69,079 | 2026-04-01 → 07-24 | 0 | 25.0 | 9,627 | 60,111 | 49,834 | 150/150 |
| `pspspsps5` | 1,394,695 | 112,297 | 2025-12-03 → 07-24 | 0 | 12.4 | 0 | 75,936 | 11,154 | 150/150 |
| `0xce25…7fdc` | 1,569,783 | 69,557 | 2026-04-30 → 07-24 | 0 | 22.6 | 14 | 69,921 | 116,745 | 150/150 |
| **TOTAL** | **19,897,878** | 224,284 *(global distinct)* | 2025-12-03 → 2026-07-24 | 131 | — | 352,102 | 329,956 | ~584,963 | 600/600 |

(Per-wallet distinct markets sum to 303,604; the **global** distinct count is 224,284
— the wallets trade many of the same short-window markets.)

## Behaviour already separates the wallets (matches the article's profiles)

- **`0xb27b…` — high-frequency market-maker.** 288.6 fills *per market* and 342k
  MERGE events: it quotes both sides intensively and continually merges completed
  Up+Down sets back to USDC. Textbook MM, and it collects by far the largest rebates
  (407k USDC).
- **`pspspsps5` — directional.** 12.4 fills/market, **zero merges**, longest history
  (from Dec 2025); buys and holds to settlement, then redeems. Matches "predominantly
  directional."
- **`neversmiling` / `0xce25…` — both-sides buyers** with moderate merging, consistent
  with their "buys both sides / closes near neutral" profiles.

## Data integrity

- **All 8 ingest streams completed** (fills + activity × 4 wallets), each terminating
  on a short page — i.e. full available history was reached, back to each wallet's
  first trade.
- **Dedup + resume verified**: boundary pages show `+9998/+9991` (duplicates at the
  cursor second correctly ignored); the run resumed cleanly from the Phase-0
  calibration checkpoint without re-fetching.
- **100% of the 600 sampled markets are resolved** — these short-window markets
  resolve within minutes, so binary settlement ($1/$0) will be available for
  essentially every market, making realized PnL exactly computable.
- Ingest cost: **~2h15m, 3,983 requests**, fully resumable throughout. Cache =
  **942 MB** gzipped raw pages (append-only source of truth) + a 15 GB derived
  SQLite index.

## What this means for Phase 2 (PnL engine)

The data shape mostly matches the spec, with these must-handle items now confirmed
by real data:

1. **MERGE is load-bearing, not incidental.** 352k merges (342k on `0xb27b…` alone).
   Merging an Up+Down pair returns $1 and unwinds cost basis — the position/cost model
   must account for MERGE (and SPLIT/CONVERSION), not just buys and redeems.
2. **Sells exist (barely) and must be handled** — 131 of them (spec §3.2: verify, then
   handle; done).
3. **Rebates are sizable and measured**, but the rows are Polymarket's *daily
   redistribution*, not per-fill — Phase 3 must attribute them correctly and separate
   measured from any estimated component (spec §8 rule 3).
4. **Scale is ~100× the spec's per-wallet estimate.** 20M fills → Phase 2 will
   aggregate into a compact per-(wallet × market) positions table (~10⁶ rows) rather
   than compute over raw fills repeatedly; the 15 GB raw-fills index need not grow.
5. **Disk headroom is ~15 GB** — Phase 2 stays read-mostly and builds the small
   aggregate; the gzipped raw cache remains the reproducible source of truth.

## Reproduce

```bash
node src/cli.ts ingest --dry-run        # show resume state / plan
node src/cli.ts ingest                  # full resumable ingest (idempotent)
node src/cli.ts volume --sample 0       # print volume report from the store (offline)
```
