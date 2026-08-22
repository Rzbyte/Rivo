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

**What that result is, and is not.** It is a verdict on **one strategy** — crossing the spread to
take whichever leg maximises `model − price` — and not on Event Contracts or on this venue. The
reason it loses is a selection effect rather than anything about DreamDEX: maximising a noisy
estimate selects for the cases where the estimate is most wrong. That is the winner's curse, and it
would appear on any market with a book worth crossing. This book, measured, is doing its job — it
is systematically path-anchored, which is what a book that prices rather than guesses looks like,
and it is the correlated bias that makes a portfolio layer worth building at all. What the result
rules out is a family of naive taker strategies, which is a useful thing to know **before** funding
one. Making — the structural alternative — was measured separately, with real quotes on-chain
rather than a replay, and its own limits stated: [EVIDENCE §6](docs/EVIDENCE.md).

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

## What we measured about this venue

Rivo is the only thing here that had to *measure* DreamDEX rather than assume it, and four of those
measurements are findings about the venue itself rather than about Rivo. Every one is reproducible
against public endpoints, most without a key.

**The non-custodial entrypoint is deployed and switched off.** The BinaryPool running right now
contains `placeBinaryOrderFor` and `cancelOrderFor`. Both revert with one selector — `0x3fb0ba2e` —
from every caller we could try, the owner acting for itself included, while each parameter mistake
returns a selector of its own. Compiled in, disabled. **Enabling it is the single change that would
let any Event Contract bot on this venue be non-custodial**, which is the difference between a
product and a script. One minute, no key, no gas:

```bash
npm run probe:operator
```

**`OutcomeBalance` is wrong about what a wallet owns, in both directions, and does not converge.**
Two of five rows on one wallet, checked against the outcome-token contract: two settled positions
whose tokens were burned still had rows hours later. A bot reading that table sees assets that do
not exist — and the opposite case, a fill not yet indexed, is the one that already cost ~400
collateral in re-minted maker inventory.

**The oracle's `numericValue` scale is inconsistent and undeclared.** Opening references at 1e2,
settlement answers at 1e4, no field saying which. Read one at the other's scale and every
probability comes out at the boundary, looking perfectly plausible.

**A fresh wallet's first Event Contract order always reverts.** `ec-core` has no allowance handling
where the spot path does, and the error names nothing: `placeBinaryOrder reverted: for an unknown
reason`. A developer following the documentation exactly cannot place their first order.

**Fourteen findings in total, each with its method and a way to check it:
[docs/SDK-FEEDBACK.md](docs/SDK-FEEDBACK.md).** Written for the people who maintain this venue, not
as a complaint — the kit is genuinely good, and `ec-core` absorbs sixteen sharp edges we would
otherwise have hit ourselves.

---

## Tests

```bash
npm test
```

**299 tests** across the things that either move money or produce a published number: the
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

## The public page

```bash
npm run build:public     # static files in public/, no backend
npx serve public
```

**Live: https://rzbyte.github.io/Rivo/** — deployed from `main` by GitHub Actions on
every push, so what is published is always what is in the repo.

Live fair value for every DreamDEX Event Contract, with the calibration evidence
behind it. **No wallet, no sign-in, nothing to install** — both Somnia indexers send
permissive CORS headers, so the page runs entirely in the browser against the same
public endpoints the runtime uses, and deploys as static files anywhere.

It imports the *same* pricing code the trading runtime uses rather than a copy. That
matters: the number on the page is the number Rivo would trade on, and the calibration
shown beneath it is the measured accuracy of that exact function over 30,771 forecasts.

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
  web/         cockpit server + static snapshot export
  public/      the public pricing page — browser bundle, shares the runtime's math
  cli/         start · web · report · calibrate · scan · allocate · backtest · diagnose · band · maker · concentration · agent
  *.test.ts    299 tests, colocated with what they cover
```

The cycle:

```
DISCOVER → RECONCILE → SETTLE/CLAIM → MONITOR/RECOVER → RISK CHECK → ALLOCATE → EXECUTE
```

**Reconciliation makes the chain the authority on what is held**, and runs before anything reasons
from it — settling, managing and allocating against a portfolio Rivo merely *believes* it has
would be wrong in the same direction all at once. Holdings are read from the pool's own ERC-6909
outcome token rather than from the indexer, because the indexer was measurably wrong in both
directions: two of five rows on one wallet, including two settled positions whose tokens had been
burned and whose rows never went away. A read that fails returns null and never zero — a zero here
authorises deleting a position.

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

npm run agent -- new                            # a wallet that holds only its float
npm run agent -- fund --collateral 25 --gas 1   # from your own key, once
npm run doctor                                  # which key signs, and what it can lose
npm start -- --capital 25 --profile conservative --live
```

### The key it signs with

An autonomous process has to hold a key that can act for its account, and on this venue there is
no way around that: the on-chain scoping that would fix it — `placeBinaryOrderFor`,
`cancelOrderFor` — **is present in the deployed contract and switched off**. Both revert
`0x3fb0ba2e` for every caller, the owner acting for itself included, while each parameter error
carries its own selector. `npm run probe:operator` reproduces the whole differential in a minute,
with no key and no gas.

So the lever is not the permission, it is the balance. `npm run agent` creates a wallet that holds
only what you moved into it — no other assets, no allowance against your own wallet — so the worst
case is a number you chose rather than everything that wallet has ever held, and `npm run agent --
sweep` takes it back. Rivo prefers it over a raw key in `.env` whenever one exists.

That is a real bound and a narrow one. It does not make a hot key safe; it makes the loss small.
The distinction is stated in the product rather than glossed, in
[`src/runtime/signer.ts`](src/runtime/signer.ts) and in what `doctor` prints.

### Self-hosting

```bash
npm run agent -- new
echo "RIVO_CONTROL_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose up -d          # cockpit on http://localhost:3000
```

The image bakes in nothing secret and is identical for everyone. The agent wallet is mounted
read-only, state lives on a volume so a restart resumes the portfolio rather than re-buying it,
and the container runs as a non-root user. `docker compose --profile headless up -d` runs the
autopilot without the UI; the two are mutually exclusive on purpose, because two processes writing
one state file is how a bot forgets what it owns.

`ec-core` is deliberately **not** a hard dependency: it ships as raw TypeScript from a private
workspace, so requiring it would mean nobody could `npm install` this repo without the kit checked
out at an exact relative path — for code only the live path touches. It is loaded dynamically and
type-checked against a local contract (`src/runtime/ec-core-types.ts`) that `npm run check:kit`
validates against the real thing.

> The live path has been exercised against the chain: **1,005 cycles, 208 positions opened, 68
> settled**, ending with the drawdown breaker firing at 35.3% and halting new entries by itself.
> Transaction hashes and every stage in [docs/EVIDENCE.md](docs/EVIDENCE.md#the-live-canary-every-stage-with-something-to-check).
> Still canary at minimum size before trusting it with anything you mind losing.

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
| `npm run maker:live -- --live --mint` | two-sided quoting on testnet — measured, and negative |
| `npm run coherence -- --days 30` | cross-tenor arbitrage bound — derived, tested, rejected on size |
| `npm run build:public` | build the public page — static, no backend |
| `npm run proof` | capture the live execution chain as a checkable artefact |
| `npm run agent -- new \| status \| fund \| sweep` | the wallet Rivo signs with, and what it may lose |
| `npm run probe:operator` | can EC be traded non-custodially? measured, not assumed |
| `npm test` · `npm run typecheck` | 299 tests · strict TypeScript, no emit |
| `npm run doctor` | can Rivo trade right now — signer, gas, collateral, venue, kit |
| `npm run check:kit` · `npm run link:kit` | verify / install the optional bot kit |

Every command except `link:kit` runs with no private key. All `--days` commands read public
indexers.

---

## What comes next

Three things follow directly from what is already here, and one of them is not ours to do.

**The moment `placeBinaryOrderFor` is enabled, Rivo becomes non-custodial.** This is the one that
matters and the one we cannot ship. The interface is already written and already reports itself
unavailable rather than pretending — `SessionKeyAuthority` in
[`src/runtime/signer.ts`](src/runtime/signer.ts) is the shape it will take, so adopting it is a new
authority class and a config line, not a rewrite. Today an unattended Rivo must hold a hot key, so
it holds one that owns nothing but a float the operator chose. That is the honest answer, not a
good one.

**The user we are actually built for is the person who just made a bot.** `dreamBot Builder` makes
an Event Contract bot a few clicks away, which means this venue is about to have many of them. Our
own measurement says what happens next: unconstrained sizing on a plausible signal is bankrupt
inside 60 trades, across 53,989 real fills. Rivo is the layer that keeps one of those bots alive
long enough to find out whether its signal was real. It does not promise profit — it refuses the
trades that end the experiment early, and names the limit each time.

**Making is the open question, and it is the only direction not yet disproven.** Taking liquidity is
measured and negative at every threshold. The maker replay is negative too, but with a
methodological limit we state rather than hide: a replay cannot know whether our quote would have
been hit. `npm run maker:live` puts real two-sided quotes on the venue to find out, and that
measurement — not a strategy claim — is where we would spend the next month.

Where we would spend the next month is measurement, not surface area. The venue is young and its
microstructure is barely documented — the reference oracle's scale, the direction depth actually
comes from, what a maker's queue really looks like — and every one of those is something the next
builder currently has to rediscover at their own expense. We would rather answer three more of them
than add three more features to Rivo. That is the work we would like to keep doing here.

## Documentation

- **[docs/EVIDENCE.md](docs/EVIDENCE.md)** — every claim, its method, and what we ruled out
- **[docs/SDK-FEEDBACK.md](docs/SDK-FEEDBACK.md)** — findings from building against the SDK and indexer, including the
  on-chain measurement that the Event Contract operator entrypoints exist and are disabled
- **[docs/DEMO.md](docs/DEMO.md)** — the 3-minute walkthrough, shot by shot, with the commands
- **[DISCLAIMER.md](DISCLAIMER.md)** — read before running anything with money
- [docs/evidence/](docs/evidence/) — saved outputs and a dashboard snapshot

## License

MIT — see [LICENSE](LICENSE).
