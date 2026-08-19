# Rivo

**An autonomous portfolio manager for DreamDEX Event Contracts.**

Give it a budget and a risk profile once. It prices every live window against that window's own
settlement reference, sizes the whole term structure as a single exposure, manages what it holds,
redeems what settles, and redeploys the proceeds — without being prompted.

Built on the official [`dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit).
Somnia × DreamDEX Event Contracts Hackathon.

---

## The honest headline

Two results, and the second one matters as much as the first.

**The forecasting model works.** Out-of-sample, over **30,751 forecasts across 6,153 settled
windows**: **AUC 0.8308, Brier 0.1695 — 32.2% skill** over always-saying-0.5.

**Trading on it, by taking liquidity, does not.** Replayed against **53,989 fills that actually
executed**, every edge band is negative, and losses grow with claimed edge. The winner's curse,
measured: selecting the leg that maximises `model − price` selects for the leg where the model's
own error is largest.

So Rivo is not "a bot that makes money". It is an autonomous portfolio manager with a validated
forecasting model, a measurement apparatus honest enough to find its own negative results, and
portfolio constraints that **demonstrably prevent ruin even when the underlying edge is negative**:

| strategy | final (from 50) | trades survived |
|---|---|---|
| **Rivo — Kelly + portfolio constraints** | **34.60** | **1,200** |
| Kelly, no portfolio constraints | 0.00 | 50 |
| Equal weight, 5% each | 0.00 | 58 |
| All-in on any edge | 0.00 | 50 |

Every unconstrained rule is bankrupt inside 60 trades. Rivo survives 1,200 and keeps 69% of
capital on an edge that is genuinely negative. Full method, every number, and the four
alternative explanations we eliminated first: **[docs/EVIDENCE.md](docs/EVIDENCE.md)**.

---

## Quickstart

```bash
npm install
npm run calibrate -- --days 30    # forecasting skill, holdout-validated
npm run scan                       # price every live leg right now
npm run allocate -- --capital 50 --profile balanced
```

No key, no wallet, no config. Every command above reads public indexers.

```bash
npm start -- --capital 50 --profile balanced   # the autopilot (dry run by default)
npm run web                                     # dashboard at localhost:3000
npm run report                                  # what it did, and why
```

---

## What it looks like when it decides

```
ALLOCATION
  market            leg    shares      @      cost    edge   kelly-asked   bound by
  BTC-240m          DOWN       7   0.174      1.25  +0.080       2.43     BTC delta budget ±2.50/1%
  ETH-240m          UP        12   0.851     10.00  +0.076      12.71     max position 20%

  deployed      11.25   (22.5%)
  cash          38.75   (77.5%)

PORTFOLIO RISK
  BTC delta      -2.500 per 1% move   budget ±2.50   100% used
  ETH delta      +1.238 per 1% move   budget ±2.50    50% used
  combined       -1.585 per 1% move   budget ±3.00    53% used
  max loss       11.25   (exact: a long binary cannot lose more than its premium)

WHY — every leg considered, and what stopped it
  BTC-240m DOWN   fair 0.254  ask 0.174  edge +0.080  BUY 7 @ 0.174   BTC delta budget ±2.50/1%
  ETH-240m UP     fair 0.927  ask 0.851  edge +0.076  BUY 12 @ 0.851  max position 20%
  BTC-15m  DOWN   fair 0.118  ask 0.059  edge +0.059  SKIP            BTC delta budget ±2.50/1%
  ...
```

`BTC-15m DOWN` has a real +0.059 edge and available depth, and is **skipped anyway** — BTC exposure
is already at budget from a better-scoring leg. A signal bot takes both. They are the same
directional view at two tenors.

And when nothing qualifies, it says so and holds cash:

```
0 of 16 legs tradeable
  BTC-15m  UP   fair 0.345  ask 0.309  edge +0.036   inside expiry headroom (195s left)
  BTC-60m  UP   fair 0.963  ask 0.945  edge +0.018   edge below floor
```

---

## Why this venue is a portfolio problem

The universe is not a market list, it is a **term structure**: `{BTC, ETH} × {15m, 1h, 4h, 1d}` —
exactly 8 windows live at any moment, ~232 settling per day, positions overlapping in time. A 1d
position spans 96 15m windows.

Measured on the venue, 2026-08-19:

| | |
|---|---|
| live windows at any moment | 8 |
| every live window's `strike` | `0` → settles against its own **opening price** |
| fees | maker = taker = settlement = **0** |
| resting side split | 26 `BUY_YES` vs 10 `SELL_YES` |
| testnet collateral | tUSDC, **6 decimals** (mainnet: USDso, 18) |

Two consequences that shape the code:

**Down-leg liquidity comes from resting `BUY_YES`**, because buying Down crosses a resting Buy-Up
(mint-a-pair). A depth model counting only `SELL_YES` underestimates the Down side — which here is
usually the deeper one.

**Complete sets make capital recovery a portfolio operation.** `mergeCompleteSet` turns offsetting
inventory back into collateral immediately, with no counterparty and no spread, instead of leaving
it locked until expiry earning nothing. It is *not* an exit — it needs both legs, so it cannot
close a directional position. Selling the held leg does that.

---

## How it decides

**Fair value.** `P(close ≥ reference) = Φ( ln(S/R) / (σ·√τ) )`, with the opening reference resolved
per window, realized volatility measured rather than assumed, and no drift term.

**Sizing.** Fractional Kelly — `f* = (p − c) / (1 − c)` is exact for a binary — with the risk
profile's multiplier as the only haircut. [We tested calibration corrections and shipped none](docs/EVIDENCE.md#2-no-calibration-correction-survives-a-holdout);
they all lost to doing nothing out of sample.

**Risk.** Three numbers, no covariance matrix. Per-asset delta (collateral lost per 1% move, so
BTC-15m UP and BTC-4h UP count as one bet), combined exposure through a *measured* BTC/ETH
correlation, and per-expiry-bucket capital. Max loss on a long binary is exactly the premium, so
capital-at-risk needs no VaR.

**Profiles.** Conservative / Balanced / Active change *which constraint binds first*, not just a
size multiplier — the same market can be a full position under one and no position under another.

---

## Architecture

```
src/
  core/        config, indexer (markets, orders, fills, oracle, price feed)
  model/       realized volatility · conditional fair value
  engine/      dual-crossing-path book · opportunity scoring · live snapshot
  portfolio/   risk profiles · delta & expiry-bucket risk · capital allocator
  calibration/ dataset builder · scoring rules · calibration maps
  backtest/    fill-grounded replay · competing sizers · diagnostics · maker replay
  runtime/     durable state · execution adapter · position manager · the cycle
  web/         dashboard server + static snapshot export
  cli/         start · web · report · calibrate · scan · allocate · backtest · diagnose · band · maker
```

The cycle:

```
SETTLE → CLAIM → DISCOVER → ANALYZE → MONITOR/RECOVER → RISK CHECK → ALLOCATE → EXECUTE
```

Settlement runs *before* allocation so capital freed by a window that just resolved is
redeployable in the same pass. Claiming runs inside the loop rather than on a timer, because it
signs with the same key that trades and two senders on one key race each other's nonce.

Execution primitives — market discovery, tick/lot quantisation in integer space, order lifecycle,
settlement and claim sweeps — are the kit's, not ours.

---

## Live trading (optional)

Dry run is the default, matching every strategy in the kit. Without a funded key Rivo stays dry
regardless of the flag, and a placeholder like `0x...` is rejected rather than accepted.

```bash
git clone https://github.com/somnia-chain/dreamdex-bot-kit ../dreamdex-bot-kit
npm --prefix ../dreamdex-bot-kit install
npm run link:kit        # makes @dreamdex-bot-kit/ec-core resolvable
npm run check:kit       # verify the exports Rivo calls still exist

cp .env.example .env    # then set a funded testnet PRIVATE_KEY and DRY_RUN=false
npm start -- --capital 50 --profile balanced
```

`ec-core` is deliberately **not** a hard dependency: it ships as raw TypeScript from a private
workspace, so requiring it would mean nobody could `npm install` this repo without the kit checked
out at an exact relative path — for code only the live path touches. It is loaded dynamically and
type-checked against a local contract (`src/runtime/ec-core-types.ts`) that `npm run check:kit`
validates against the real thing.

> The live execution path is written against `ec-core`'s documented surface rather than stubbed,
> but it has **not yet been exercised against the chain**. Canary at minimum size before trusting it.

---

## Documentation

- **[docs/EVIDENCE.md](docs/EVIDENCE.md)** — every claim, its method, and what we ruled out
- **[docs/SDK-FEEDBACK.md](docs/SDK-FEEDBACK.md)** — findings from building against the SDK and indexer
- **[DISCLAIMER.md](DISCLAIMER.md)** — read before running anything with money
- [docs/evidence/](docs/evidence/) — saved outputs and a dashboard snapshot

## License

MIT — see [LICENSE](LICENSE).
