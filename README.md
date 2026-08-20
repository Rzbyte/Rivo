# Rivo

**An autonomous portfolio manager for DreamDEX Event Contracts.**

Give it a budget and a risk profile once. It prices every live window against that window's own
settlement reference, sizes the whole term structure as a single exposure, manages what it holds,
redeems what settles, and redeploys the proceeds — without being prompted.

Built on the official [`dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit).
Somnia × DreamDEX Event Contracts Hackathon.

> **What is the kit's, and what is Rivo's.** Fair probability from an underlying, market discovery,
> edge gating, settlement and claim primitives, and the Event Contract bot scaffolding all already
> exist in the kit — `ec-oracle-follow` and `ec-core` in particular. Rivo credits and extends them
> rather than claiming them. What Rivo adds is the layer above: a calibration and evidence harness
> for Event Contracts, cross-market capital allocation, portfolio-wide risk, post-entry position
> management, autonomous lifecycle orchestration, on-chain state reconciliation, explainability, and
> a consumer-facing product.
>
> **Rivo is the portfolio and evidence layer for DreamDEX Event Contracts.**

---

## The honest headline

Two results, and the second one matters as much as the first.

**The forecasting model works.** Out-of-sample, over **30,771 forecasts across 6,157 settled
windows**: **AUC 0.8305, Brier 0.1696 — 32.2% skill** over always-saying-0.5.

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

## Tests

```bash
npm test
```

**99 tests** across the seven things that either move money or produce a published number: the
dual-crossing-path book, the fair-value model and volatility estimator, the scoring rules behind
every figure in [EVIDENCE.md](docs/EVIDENCE.md), the capital allocator, the position manager, settlement, and
on-chain reconciliation.

Written after two bugs reached a live run, so both are pinned as regressions — the allocator
sizing each cycle's order against remaining budget instead of a target for the whole leg, and a
conviction stop that re-fired on the same information every cycle (3.06 → 1.53 → 0.76 → 0.38,
paying a spread each time).

The suite then found a third bug on its own: `fitPlatt` diverged on a confidently-wrong model —
plain Newton-Raphson overshoots, the IRLS weights collapse to their floor, and a finite gradient
becomes an astronomical step. Measured at `a = 8.7e7` where the correct answer is `0.088`. Fixed
with a ridge and a backtracking line search. Re-running the calibration study with the corrected
fit moved Platt's parameters by 0.0005 and changed no conclusion, which is recorded in EVIDENCE.md
because the check mattered more than the outcome.

The scoring rules are checked against cases whose answers are known by construction rather than by
having been run once — AUC 1 for a perfect ranking, 0.5 for a constant one, Brier 0.25 for a coin
flip — so the headline numbers rest on more than a single execution.

Three of the fixtures were wrong before the code was, and each failure demonstrated the code
working: a book helper offering only `SELL_YES` left a DOWN leg with no asks at all, a comment
claiming "40% of 3600s = 1440s" ignored that `headroomSec` caps at 300s, and an assertion demanded
ten decimal places from an approximation documented to 1.5e-7.

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
  research/    cross-tenor coherence — the derivation and its test
  runtime/     durable state · execution adapter · position manager · reconciliation · the cycle
  web/         dashboard server + static snapshot export
  cli/         start · web · report · calibrate · scan · allocate · backtest · diagnose · band · maker · concentration
  *.test.ts    99 tests, colocated with what they cover
```

The cycle:

```
DISCOVER → RECONCILE → SETTLE/CLAIM → MONITOR/RECOVER → RISK CHECK → ALLOCATE → EXECUTE
```

**Reconciliation makes the chain the authority on what is held**, and runs before anything reasons
from it — settling, managing and allocating against a portfolio Rivo merely *believes* it has
would be wrong in the same direction all at once. Holdings come from the indexer's
`OutcomeBalance`, so this needs no SDK and no key beyond knowing the address.

It is deliberately asymmetric. A shortfall inside a two-minute grace window is left alone, because
the indexer lags the chain by seconds and deleting a just-filled position is the more expensive
mistake; a surplus is trusted immediately, because extra shares cannot be lag. A holding the chain
has and Rivo does not is adopted at the model's fair value and **flagged as estimated** — nothing
on-chain records what was paid. Dry runs skip all of it: simulated positions have no on-chain
counterpart, so checking them against a chain that never heard of them would delete the portfolio.

State is also written the moment a fill is recorded rather than once per cycle. That gap — order
lands, process dies, fill never written — is exactly how a bot forgets a position it owns and buys
a second copy. Saving immediately mostly prevents it; reconciliation repairs it when it happens
anyway.

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
npm run doctor          # checks signer, gas, collateral, venue and kit in one pass
npm start -- --capital 5 --profile conservative
```

`ec-core` is deliberately **not** a hard dependency: it ships as raw TypeScript from a private
workspace, so requiring it would mean nobody could `npm install` this repo without the kit checked
out at an exact relative path — for code only the live path touches. It is loaded dynamically and
type-checked against a local contract (`src/runtime/ec-core-types.ts`) that `npm run check:kit`
validates against the real thing.

> The live execution path is written against `ec-core`'s documented surface rather than stubbed,
> but it has **not yet been exercised against the chain**. Canary at minimum size before trusting it.

---

## Commands

| | |
|---|---|
| `npm start -- --capital 50 --profile balanced` | the autopilot (dry run by default) |
| `npm run web` | dashboard at localhost:3000 (`--snapshot out.html` freezes it to one file) |
| `npm run report` | what it did, and why |
| `npm run scan` | price every live leg right now |
| `npm run allocate -- --capital 50` | one allocation pass, with the binding constraint per leg |
| `npm run calibrate -- --days 30` | forecasting skill, holdout-validated (`--traded-only`, `--out`) |
| `npm run backtest -- --days 30` | Rivo's sizing against five alternatives on identical forecasts |
| `npm run band -- --days 30` | edge-floor/ceiling sweep |
| `npm run diagnose -- --days 30` | why taking liquidity loses |
| `npm run concentration -- --days 30` | whether losses are a trade-weighting artefact |
| `npm run maker -- --days 30` | the maker replay, and its methodological limit |
| `npm run coherence -- --days 30` | cross-tenor arbitrage bound — derived, tested, rejected on size |
| `npm test` · `npm run typecheck` | 99 tests · strict TypeScript, no emit |
| `npm run doctor` | can Rivo trade right now — signer, gas, collateral, venue, kit |
| `npm run check:kit` · `npm run link:kit` | verify / install the optional bot kit |

Every command except `link:kit` runs with no private key. All `--days` commands read public
indexers.

---

## Documentation

- **[docs/EVIDENCE.md](docs/EVIDENCE.md)** — every claim, its method, and what we ruled out
- **[docs/SDK-FEEDBACK.md](docs/SDK-FEEDBACK.md)** — findings from building against the SDK and indexer
- **[DISCLAIMER.md](DISCLAIMER.md)** — read before running anything with money
- [docs/evidence/](docs/evidence/) — saved outputs and a dashboard snapshot

## License

MIT — see [LICENSE](LICENSE).
