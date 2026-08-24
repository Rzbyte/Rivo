# Rivo

**An autonomous portfolio manager for DreamDEX Event Contracts.**

Give it a budget and a risk profile once. It prices every live window against that window's own
settlement reference, sizes the whole term structure as a single exposure, manages what it holds,
redeems what settles, and redeploys the proceeds — without being prompted.

**Sign in with an email address. Fund a portfolio wallet. Set a budget. Close the tab.** Rivo keeps
managing it, server-side, with no private key to paste and no per-trade approval — because it never
holds the key at all. [How that works ↓](#the-product)

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
> Every order Rivo sends goes through the kit. `ec-core` is 1,585 lines absorbing sixteen documented
> sharp edges — `placeLimit` alone handles tick and lot quantisation in integer space, the mandatory
> order expiry, and the fact that a reverted write does not throw — and reimplementing that would
> mean relearning all of it with real money. What Rivo did instead was go deep enough into this
> venue to find four places the kit has no answer for yet: allowance handling
> ([#4](docs/SDK-FEEDBACK.md)), the granularity the venue's lot actually accepts (#5), reading
> holdings from the chain rather than the indexer (#8), and the signer flexibility the SDK has and
> `createExchange` does not expose (#15) — which is the five-line gap between "users must paste
> private keys" and a product. Each became a finding rather than a silent fork.
>
> **Rivo is the portfolio and evidence layer for DreamDEX Event Contracts.**

---

## Before capital moves

Five things have to agree, and the first four are checked before an executor is built:

```
strategy state  ·  execution mode  ·  network  ·  signer  ·  portfolio risk
```

The strategy running today is **Diffusion Taker V1**: AUC **0.8158**, which is genuinely good, and
**−6.49%** return on stake out of sample, which is why it is **REJECTED** for real capital. Both are
true. Being right about direction is not the same as being right by more than the spread you cross to
act on it, and the gate reads the second number rather than the first.

It runs under **Experimental Testnet** — testnet only, chosen explicitly, and impossible to activate
on mainnet. Full model: [docs/ARCHITECTURE.md § Execution permission](docs/ARCHITECTURE.md).

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

**673 tests** across the things that either move money or produce a published number: the
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

## The product

A person should be able to use this without ever seeing a private key, and without approving
anything at 3am. So:

1. **Sign in** with an email address, a Google account, or a wallet they already have.
2. **Get a Rivo portfolio wallet** — a Privy embedded wallet, created for them, separate from
   anything they already hold.
3. **Fund it.** Their money moves once, to an address they control.
4. **Set a budget and a risk profile.** Three profiles do most of the work; the advanced panel is
   there for the people who want it, and only ever *tightens*.
5. **Enable Experimental Testnet.** There is no separate Privy modal — these wallets run in a TEE
   where the grant is provisioned headlessly, so the Rivo screen *is* the consent surface. It grants
   Rivo the right to ask for signatures on that wallet, revocable by them at any moment. It grants
   testnet execution only: the strategy running today is economically REJECTED and the gate refuses
   it real capital on any network.
6. **Close the tab.**

From then on a worker somewhere else discovers windows, prices them, allocates across the whole
term structure, manages what it holds, redeems what settles, and redeploys the proceeds — with no
browser open and no per-trade approval.

**Rivo never holds the key.** Privy does. That is not a detail: it is the difference between a
product a stranger can use and a script you run for yourself. It works because the venue's SDK
accepts any object with a `signTransaction` method as its local-signing path, and Privy's server
SDK returns exactly that — a viem account whose signing happens inside a TEE. `npm run check:kit`
verifies that binding against the real kit rather than asserting it.
[SDK-FEEDBACK §15](docs/SDK-FEEDBACK.md) has the reading; [SECURITY.md](docs/SECURITY.md) has the
threat model, including what a full compromise of Rivo's servers would and would not get.

**What is enforced, and by what.** Stated here because overclaiming it would be the most damaging
dishonesty in the product:

| | |
|---|---|
| **on-chain** | *nothing*. The venue's operator entrypoint is compiled in and disabled — `npm run probe:operator` |
| **by custody** | Rivo cannot exfiltrate a key it never has. Revoking delegation ends its authority immediately |
| **by software** | capital ceiling, correlated delta budget, expiry buckets, tenor caps, drawdown breaker, kill switch — real, and exactly as strong as Rivo's own correctness |
| **by arithmetic** | the portfolio wallet holds only what its owner funded it with |

```bash
npx tsx scripts/dev-postgres.ts start   # a real PostgreSQL, no docker, no root
export DATABASE_URL=postgres://rivo@127.0.0.1:55432/rivo
npm run db:migrate
npm run seed:demo                        # a portfolio, without signing in
npm run worker -- --once                 # one pass against the live venue
npm run dev:web                          # the product, on :3001

npm run privy:check                      # what still needs configuring, checked for real
npm run proof -- --portfolio <id>        # the evidence, out of the database
```

Deployment — Vercel for the web tier, a container for the worker, managed PostgreSQL between them —
is in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

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

Four planes, deployed apart because they fail apart:

```
      a person                       the venue
         │                               ▲
         ▼                               │
  ┌─────────────────┐            ┌───────┴────────────┐
  │ WEB / CONTROL   │            │ EXECUTION          │
  │ Next.js, Vercel │            │ worker container   │
  │ request-scoped  │            │ many portfolios    │
  └────────┬────────┘            └───────┬────────────┘
           │                             │
           └──────────┬──────────────────┘
                      ▼
           ┌────────────────────────┐      ┌──────────────────┐
           │ DURABLE STATE          │      │ IDENTITY/SIGNING │
           │ managed PostgreSQL     │      │ Privy — holds    │
           │ the only shared truth  │      │ the keys, so     │
           └────────────────────────┘      │ Rivo does not    │
                                           └──────────────────┘
```

The worker is not a serverless function and cannot be. A trading cycle settles, claims, reconciles
and allocates on a clock that has nothing to do with anybody being logged in — and the entire
promise of the product is that it keeps going when nothing else is.

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
  signing/     Privy delegated authority — per-user signing, no key material held
  ledger/      the permanent execution record + crash recovery
  store/       the seam: file state (dev, tests, one portfolio) | PostgreSQL (production)
  db/          pool · migrations · accounts · portfolios · leases · events · the view model
  worker/      lease-based scheduler — many portfolios, one process, none shared
  web/         the original cockpit server + static snapshot export
  public/      the public pricing page — browser bundle, shares the runtime's math
  cli/         start · worker · web · report · calibrate · scan · allocate · backtest · … · agent
  *.test.ts    673 tests, colocated with what they cover
web/
  app/         Next.js — landing, the product, and the control-plane API
  components/  the dashboard, built around decisions rather than fills
  lib/         auth (one path from token to identity) · validation · chain metadata
```

**The engine did not change to make any of this possible.** `allocate`, `manage`, `reconcile` and
the cash-ledger identity are the same functions they were, with the same tests. What changed is
what sits underneath them: a `StateSink` the cycle writes into without knowing whether it is a file
or a row, and a `ChainSigner` the executor asks for authority without knowing whose it is.

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
# The commit Rivo is built and verified against — the same one the image pins.
git -C ../dreamdex-bot-kit checkout 9718fd9
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

### Keeping it alive, and being told when it is not

```bash
# where to shout when the breaker fires or cycles start failing
echo "RIVO_ALERT_WEBHOOK=https://hooks.slack.com/services/..." >> .env

cp deploy/rivo.service ~/.config/systemd/user/   # edit the paths and capital
systemctl --user enable --now rivo
loginctl enable-linger $USER                     # survive logout
```

Two things an unattended trader owes its operator, and neither was here until
they were needed twice.

**It says when it stops.** The drawdown breaker firing is the one event nobody
should learn from a log the next morning — and that is exactly how both canary
halts were found. Alerts fire on the breaker, on three consecutive cycle errors,
and on the run ending. They fire **once** per distinct condition: a halt is true
on every subsequent cycle, and an alerter that repeats it every 45 seconds is an
alerter that gets muted, which makes the next real one invisible too.

**Only one runtime per data directory.** Two were started against one directory
here, by accident, and both allocated against the same capital and sent orders
from the same wallet — the wallet drained while each process's ledger still
balanced to itself, and what surfaced was twenty-five "not enough collateral"
errors pointing at everything except the cause. A second runtime now refuses to
start, names the pid and command holding the directory, and exits non-zero. A
lock whose owner is gone is taken over rather than becoming an outage.

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
| `npm start -- --capital 50 --profile balanced` | one portfolio, files, no database — the CLI autopilot (dry run by default) |
| `npm run worker` | the execution plane: many portfolios out of PostgreSQL (`--once`, `--interval`, `--concurrency`) |
| `npm run dev:web` | the product — sign-in, funding, dashboard — on localhost:3001 |
| `npm run db:migrate` | bring a database up to date (the worker also does this on boot) |
| `npm run dev:pg` | a real PostgreSQL locally, no Docker and no root (`start`/`stop`/`reset`) |
| `npm run seed:demo` | a portfolio to look at without signing in — Shadow Mode, enforced |
| `npm run web` | the original single-portfolio cockpit at localhost:3000 (`--snapshot out.html` freezes it) |
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
| `npm run proof` | capture the live execution chain as a checkable artefact (`--portfolio <id>` for a database portfolio) |
| `npm run report -- --portfolio <id>` | the same report over PostgreSQL, with the constraint histogram |
| `npm run privy:check` | is this deployment's Privy set up? authenticates for real, lists what is missing |
| `npm run agent -- new \| status \| fund \| sweep` | the wallet Rivo signs with, and what it may lose |
| `npm run probe:operator` | can EC be traded non-custodially? measured, not assumed |
| `npm test` · `npm run typecheck` | 673 tests · strict TypeScript across engine, page and web app |
| `npm run doctor` | can Rivo trade right now — signer, gas, collateral, venue, kit |
| `npm run faucet` | mint testnet tUSDC — a direct `faucet(uint256)` call, no kit needed |
| `npm run check:kit` · `npm run link:kit` | verify / install the optional bot kit |

Every command except `link:kit` runs with no private key. All `--days` commands read public
indexers.

---

## What comes next

Three things follow directly from what is already here, and one of them is not ours to do.

**The moment `placeBinaryOrderFor` is enabled, Rivo's limits become enforceable on-chain.** This is
the one that matters and the one we cannot ship. The interface is already written and already
reports itself unavailable rather than pretending — `SessionKeyAuthority` in
[`src/runtime/signer.ts`](src/runtime/signer.ts) is the shape it will take, so adopting it is a new
authority class and a config line, not a rewrite.

What *has* changed since that was first written is custody, which is a different question and
turned out to have an answer. Rivo no longer holds anybody's key: each user's portfolio wallet is
held by Privy, Rivo holds a revocable right to ask it to sign, and the venue's SDK accepts that
signer on its normal fast path ([SDK-FEEDBACK §15](docs/SDK-FEEDBACK.md)). So a full compromise of
Rivo's servers gets an attacker the ability to place Event Contract orders from delegated wallets
until their owners revoke — not the keys, and nothing after revocation.

What is still missing is the *scope*. Rivo's trading limits are enforced by Rivo, in software. They
are real and they are tested, and they are strictly weaker than a bound the chain would hold. That
gap is one flag wide and it is not ours to close.

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
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — what the engine already was, what production
  needed from it, and the measurement that decided the shape of the answer
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — the three planes, and why the worker cannot be serverless
- **[docs/SECURITY.md](docs/SECURITY.md)** — threat model, what is enforced by what, and six known gaps
- **[docs/SDK-FEEDBACK.md](docs/SDK-FEEDBACK.md)** — findings from building against the SDK and indexer, including the
  on-chain measurement that the Event Contract operator entrypoints exist and are disabled
- **[docs/DEMO.md](docs/DEMO.md)** — the 3-minute walkthrough, shot by shot, with the commands
- **[DISCLAIMER.md](DISCLAIMER.md)** — read before running anything with money
- [docs/evidence/](docs/evidence/) — saved outputs and a dashboard snapshot

## License

MIT — see [LICENSE](LICENSE).
