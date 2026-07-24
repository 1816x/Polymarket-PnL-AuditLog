# Phase 0 — Reconnaissance report

**Date:** 2026-07-24 · **Scope:** verify every external assumption against live sources
before writing the engine (spec §7). Everything below was confirmed against
`docs.polymarket.com`, PolygonScan, and **live API / on-chain calls**, and is reproducible
with the `resolve` and `recon` CLI commands.

## Verdict: GO for Phase 1, with three assumptions corrected

The read-only premise **holds end-to-end** — no auth, no wallet key anywhere in the
pipeline. The data has (mostly) the shape the spec assumed; the deviations are understood
and handled. Three things the spec got wrong or under-specified are corrected below and are
the reason Phase 0 exists.

---

## 1. Wallet resolution (spec §1)

`resolve` maps usernames → proxy wallets via Gamma `/public-search` with an **exact,
case-sensitive `name` filter** (the endpoint is fuzzy; taking `profiles[0]` would mis-map),
then round-trips through `/public-profile`.

| # | Subject | Result |
|---|---|---|
| 1 | `0xb27bc932…b5b82` (address) | given |
| 2 | **`BadFallen`** (username) | ❌ **no exact match** (fuzzy neighbors: JadaAllen, halfallen, madallen, RedFallen); leaderboard fallback also empty → **EXCLUDED and documented** (spec §1) |
| 3 | `neversmiling` | ✅ `0xfcdc071df7080c214196bb0b3b751e5417f9d8e3` |
| 4 | `pspspsps5` | ✅ `0xb0f85baa97990910a3e8ac2b4a58a322f01ecef5` |
| 5 | `0xce25e214…7fdc` (address) | given |

**4 of 5 wallets are auditable.** Auditing 4 with certainty beats 5 with one mis-identified.

---

## 2. Confirmed data path (no auth, no keys)

| Purpose | Endpoint | Notes |
|---|---|---|
| Resolve | Gamma `GET /public-search?q=&search_profiles=true` | fuzzy → exact-match filter required |
| Fills (any wallet) | Data `GET /trades?user=&takerOnly=false` | fields: `side, size, price, timestamp, conditionId, asset, outcomeIndex, transactionHash`. Floats carry precision noise (`0.529999984`). No maker/taker, no fee field. |
| Cash flows | Data `GET /activity?user=` | `TRADE / REDEEM / …` with `usdcSize`. **`REDEEM.usdcSize` is inconsistent** (observed both `0` and `1.36`) → settlement is computed from outcome × net position, never trusted from this row. |
| Settlement | **CLOB `GET /markets/<conditionId>`** | reliable: `closed` + per-token `winner` boolean + `price` 0/1. |
| Maker/taker + fee | Polygon `OrderFilled` logs | on-chain reconstruction (see §4). |

**Settlement source changed from the plan.** Gamma `/markets?condition_ids=` returned `[]`
intermittently for freshly-resolved short-term markets (0/5 on retry) — unusable as the
primary. The **CLOB `/markets/<conditionId>`** endpoint is reliable and gives an explicit
winner. Example (live): `XRP Up or Down — 2:00–2:05 PM ET` → **Down won** (`price 1,
winner true`). The authoritative tiebreaker remains on-chain `payoutNumerators` for the
reconciliation sample.

**5-min crypto markets resolve via Chainlink, not UMA** — confirmed empirically: the market
record carries `resolutionSource: https://data.chain.link/streams/xrp-usd` and
`umaResolutionStatus: null`. So settlement must **not** be gated on `umaResolutionStatus`.

---

## 3. Correction #1 — the CLOB V2 cutover (Apr 28 2026 ~11:00 UTC)

Not in the spec. It bifurcates the whole stack and the tool is now date-partitioned
(`eraFor(ts)` in `config/constants.ts`). All addresses verified on-chain or via PolygonScan;
**pUSD verified live** in Phase 0 (`symbol()` == `"pUSD"`):

| | Pre-cutover (v1) | Post-cutover (v2) |
|---|---|---|
| CTF Exchange | `0x4bFb41d5…8982E` | `0xE1111800…B996B` ✓ seen on-chain |
| Collateral | USDC.e `0x2791…4174` (`symbol=USDC`) | pUSD `0xC011a7E1…82DFB` (`symbol=pUSD`, verified) |
| Data backend | v1 Goldsky subgraphs | v1 subgraphs deprecated → raw logs / v2 datasets |

CTF (ConditionalTokens) `0x4D97DCd9…76045` is unchanged. **The subject wallets trade now
(post-V2)**, so V2 is the primary path.

---

## 4. Correction #2 — maker/taker is on-chain only (the core of H2)

The spec said maker/taker "lives in the CLOB API." It does **not** for third parties: the
clean `trader_side` field is on the auth-gated CLOB `/data/trades`, which returns **only
your own** wallet. For arbitrary wallets the role must be reconstructed from Polygon
`OrderFilled` logs. **This is validated** by `recon`:

`OrderFilled` topics are unambiguous — `topic[2]=maker`, `topic[3]=taker`. The aggressor
(taker) is the common counterparty across the tx's per-maker legs; the aggregate "netting"
leg (`taker == exchange`) is skipped to avoid double counting.

Real, reconciled examples (share amounts match the Data API **exactly**):

- **neversmiling as MAKER** — `BUY 1.06 @ 0.36`: on-chain maker leg, shares 1.06 ✓, **fee 0**.
- **neversmiling as TAKER** — `BUY 11.30357`: 2 taker legs (9.82 + 1.48357), aggregate
  shares 11.30 ✓ vs Data API `11.30357`.
- **wallet #5 (`0xce25…`) as TAKER** — `BUY 16.99`: 2 taker legs (6.99 + 10) ✓, one leg
  carried a nonzero fee (0.00209).

So the **same wallet acts as both maker and taker** across fills (consistent with the
article's "changes sides" description) — exactly why a measured ratio is needed for H2.

**Two decoding lessons baked into the design:**

1. **On-chain is a role + fee oracle only.** The on-chain implied price is the *complement*
   of the Data API price (a taker BUY at 0.94 shows as 0.06 on-chain, because the taker
   order matches makers on the opposite outcome / via minting). Economic **price, side, and
   size come from `/trades`**; on-chain supplies **role and fee** keyed by `(txHash, wallet)`.
2. **Fee attribution is provisional.** Makers pay 0 (validated on maker legs). The *taker's*
   tx-level fee sits on the aggregate leg (observed `fee = 14.04` on one), not always on the
   per-maker legs — so exact taker-fee extraction, and its consistency with the
   `shares × 0.07 × p × (1−p)` formula, is **deferred to Phase 3** and must use the verified
   V2 `OrderFilled` ABI. The 3 indexed topics (role) are certain; the data-word layout
   (`[0]=makerAssetId … [4]=fee`) is observation, not spec.

**The cheap "takerOnly set-diff" shortcut is not adopted.** Comparing
`/trades?takerOnly=true` vs `false` was inconclusive here (the two queries return different
paged windows, confounding the comparison). On-chain reconstruction is the ground truth and
is the chosen method.

---

## 5. Fee model (spec §3.3)

- Formula **confirmed** against the official fees page: `fee = shares × feeRate × price ×
  (1 − price)`, **crypto `feeRate = 0.07`**, peaks at p = 0.50 — exactly where this strategy
  lives. **Makers never pay.**
- Rate is **time-varying** → `cryptoFeeRate(ts)` reads a timestamp-keyed schedule (crypto
  intro ~Jan 2026; category expansion Mar 30 2026; crypto 0.072→0.07 ~Jul 2026). ⚠️ **These
  dates are from secondary reporting and are marked PROVISIONAL in code** — they must be
  pinned to primary Polymarket announcements before the pre/post-fees cut is published,
  because the boundary date directly determines that headline result.
- Rebates = **estimate-only** (daily off-chain redistribution) → PnL will be reported as a
  floor (no rebates) and a ceiling (estimated), with measured `REWARD`/`MAKER_REBATE`
  activity rows kept in a separately-marked column.

---

## 6. Environment notes

- **Public Polygon RPCs are increasingly gated** (polygon-rpc.com → 403, ankr → key
  required). Several still work (`publicnode`, `drpc`, `onfinality`, `tenderly`, `1rpc`) and
  are the defaults with failover; a `POLYGON_RPC_URL` provider key is recommended for the
  heavy historical log backfill in Phase 3.
- Node ≥ 22 runs the TypeScript directly (native type-stripping) — no build step.

---

## 7. Open items carried into later phases

1. Pin the exact fee **effective dates** to primary sources (Phase 2/3).
2. Confirm the **V2 `OrderFilled` ABI** (verified contract) → exact fee/amount fields (Phase 3).
3. Characterize taker-fee attribution across the aggregate/per-leg structure on many fills (Phase 3).
4. Handle **negRisk / complement** mechanics in cost-basis (Phase 2).
5. **Verify whether the bots sell** — do not assume buy-only (spec §3.2); the model must handle sells (Phase 2).
6. Pre-cutover (v1) history path, if any subject traded before Apr 28 2026 (Phase 1).

## How to reproduce

```bash
npm install
node src/cli.ts resolve            # wallet resolution table (+ BadFallen exclusion)
node src/cli.ts recon              # neversmiling: fills, activity, settlement, maker/taker
node src/cli.ts recon --wallet 0xce25e214d5cfe4f459cf67f08df581885aae7fdc
```
