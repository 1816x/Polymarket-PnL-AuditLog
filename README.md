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

## Status: Phase 1 (Ingest) — complete

Per the spec's phased workflow (§7), work stops for review after each phase.
Reports: **[`docs/phase0-report.md`](docs/phase0-report.md)** (recon / go-no-go) and
**[`docs/phase1-report.md`](docs/phase1-report.md)** (ingest / volume). **No PnL is
computed yet** — that is Phase 2.

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

# Resolve the 5 subject wallets (usernames -> proxy addresses)
node src/cli.ts resolve
node src/cli.ts resolve --dry-run     # show the request plan without calling

# Recon one wallet: raw fills, activity, settlement, on-chain maker/taker for one tx
node src/cli.ts recon                                     # defaults to neversmiling
node src/cli.ts recon --wallet 0xce25…7fdc --limit 8
node src/cli.ts recon --dry-run

npm run typecheck                     # tsc --noEmit
```

Raw dumps land in `output/phase0/` (gitignored — regenerable).

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
    gamma.ts            profile resolution (username -> proxy wallet)
    data.ts             /trades (fills) + /activity (cash flows)
    clob.ts             /markets/<conditionId> — reliable settlement (winner)
    onchain.ts          Polygon OrderFilled decode — maker/taker + fee oracle
  ingest/resolve-wallets.ts   exact-match resolution w/ round-trip verification
  cli.ts                resolve | recon (Phase 0)
```

Phases 1–5 (ingest → PnL engine → analysis → report → optional control group) build on this
foundation; see the plan and the Phase 0 report.
