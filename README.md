# Rivo

**Understand the market. Validate the agent. Prove it on DreamDEX.**

**Event intelligence and agent validation for DreamDEX Event Contracts.** Rivo turns DreamDEX Event
Contract probabilities into measurable intelligence, validates whether autonomous agents have
economic edge, and lets builders prove them through live shadow testing and verifiable DreamDEX
testnet execution.

**Live: [rivo-autopilot.vercel.app](https://rivo-autopilot.vercel.app/)** — five sections, four of
which open with no wallet and no account.

---

## 1 · The problem

DreamDEX may say BTC UP 15m is **67%**. Nothing on the venue tells you whether contracts that quoted
67% went on to settle true about 67% of the time — which is the only question that number raises.

And a model that forecasts well can still lose money when you cross the spread to act on it. Those
are two different measurements, and a builder deploying an agent needs both before capital moves.

Rivo answers the first against contracts that have already settled, with the sample size attached to
every claim. It answers the second by validating agents economically rather than by accuracy — and
it found its own model wanting, published the evidence, and built a gate that enforces it.

> **A model can predict well and still trade badly.**


## 2 · Markets

Every live DreamDEX Event Contract, with implied probability, bid, ask, spread, depth and time to
expiry — beside how often *comparable* contracts actually settled true. Each card names the cohort
that answered and says when it had to widen, because "historical realized 61%" is worthless unless a
reader can find out what 61% is the realized rate **of**.

Assessments are deterministic and descriptive: `WELL CALIBRATED`, `OVERCONFIDENT`, `UNDERCONFIDENT`,
`LARGE DISAGREEMENT`, `LOW LIQUIDITY`, `HIGH SPREAD`, `INSUFFICIENT SAMPLE`. Never BUY or SELL — a
caveat about the data outranks a claim about the price.

## 3 · Calibration — is 67% actually 67%?

Measured against **843 settled windows** as of 2026-08-24: Brier **0.1604** against
**0.2497** for always quoting the base rate, a skill score of **35.8%**.
DreamDEX prices carry real information, and the middle of the book is mostly honest (65–70% settled
64.5%). Parts of it are not (50–55% settled 41.5%).

Those are the figures in [`docs/evidence/calibration-report.json`](docs/evidence/calibration-report.json),
and they are a snapshot on purpose — the worker recomputes this every few hours as more contracts
settle, so [the live page](https://rivo-autopilot.vercel.app/calibration) reports a larger sample than
this file does. A README that quietly tracked a moving number would be the one document nobody could
check against anything.

Windows are the unit, not fills — forty rows from one settled contract are forty copies of one coin
flip. Intervals come from resampling windows. Cohorts run BTC 15m → BTC all tenors → all assets 15m →
global, falling back only on sample size. [Methodology](docs/CALIBRATION.md).

## 4 · Agents — does the model deserve capital?
Rivo's own model is the first case study and it **failed**: AUC **0.8158**, and **−6.49%** return on
stake out of sample. Both are true, which is the point.

> **A model can predict well and still trade badly.**

Connect your own over HTTP. Rivo never runs your code and never trusts your answer — the endpoint is
vetted against private and link-local ranges, resolved and re-checked, redirects refused, and every
number you return is clamped to limits Rivo set.

## 5 · Live Shadow

An agent decides against live DreamDEX contracts on a schedule, in a background worker, and sends
nothing. It runs **the same pre-execution pipeline as real execution** — market eligibility, the
strategy gate, risk ceilings and the venue's lot rule — and stops at the signer:

```
agent decision → schema → eligibility → policy → risk → venue normalisation → intent
                                                                                ├── SHADOW      hypothetical, no signer, no transaction
                                                                                └── TESTNET     signer → DreamDEX SDK → transaction
```

That shared path is the point. Shadow used to ask an agent and write the answer down, which meant it
could record a hypothetical trade real Rivo would have refused — an agent looked best exactly where
the constraints would have stopped it. `src/runtime/pipeline.ts` is now the only route to a signer,
and `src/runtime/pipeline.test.ts` asserts the two modes reach byte-identical intents except for one
field: whether a signature may be requested.

Every hypothetical resolves against the venue's own settlement when the contract closes. Columns are
named `hypothetical_*` throughout, so a query has to opt into the lie.

## 6 · Experimental Testnet

Five things must agree before capital moves, and the first four are checked before an executor is
built:

```
strategy state  ·  execution mode  ·  network  ·  signer  ·  portfolio risk
```

The strategy running today is **Diffusion Taker V1**: AUC **0.8158**, which is genuinely good, and
**−6.49%** return on stake out of sample, which is why it is **REJECTED** for real capital. Both are
true. The gate reads the second number rather than the first.

It runs under **Experimental Testnet** — testnet only, chosen explicitly, and impossible to activate
on mainnet. Unknown chain, unknown strategy state and unknown mode all block. Fail closed. Full
model: [docs/ARCHITECTURE.md § Execution permission](docs/ARCHITECTURE.md).

## 7 · Proof

Only on an approved testnet does a decision become a real DreamDEX transaction — with the hash, the
receipt and the reconciliation all inspectable. One run is walked end to end, stage by stage:

```
AGENT DECISION → RISK CHECK → VENUE NORMALISATION → ORDER SUBMITTED
              → SOMNIA CONFIRMED → LEDGER PERSISTED → RECONCILED → SETTLED / PENDING
```

Counted separately and never merged: `HYPOTHETICAL`, `SKIPPED`, `REFUSED`, `SUBMITTED`, `CONFIRMED`,
`REVERTED`, `RECONCILED`, `SETTLED`, `CLAIMED`, `PENDING`.

**One order, checkable by hand** — [`docs/evidence/final-proof.json`](docs/evidence/final-proof.json),
produced by `npm run final-proof`:

| | |
|---|---|
| market | BTC DOWN · 1d |
| strategy state | `REJECTED` — running only because Experimental Testnet was chosen explicitly |
| normalised size | 0.65 shares at 0.438, cost 0.2847 — rounded down to a lot DreamDEX accepts |
| transaction | [`0xea3946bd…72ce`](https://shannon-explorer.somnia.network/tx/0xea3946bddff3cb5777bcb549b154f1bf136358ae836f37d003cc13c15db572ce) |
| receipt | `CONFIRMED`, block 468724348 — read back from the RPC, not inferred from the send |
| settlement | `PENDING` — the contract is still open, and saying so is the point |

`src/cli/finalproof.test.ts` refuses an artefact that claims a settlement which has not happened, a
confirmation with no block number, or a size that is not on a lot boundary.

A deterministic refusal is not a failure. A size that rounds to zero at DreamDEX's lot is
`REFUSED / NORMALIZED_SIZE_ZERO` before anything is signed, rather than an execution attempt that
reverts — so `failed` counts genuine chain and SDK failures and nothing else.

Evidence belongs to exactly one run. A deployment's counts contain only that deployment's rows;
decisions an agent made outside any deployment are shown as **GLOBAL AGENT EVIDENCE** and never
merged in. `src/intel/scope.test.ts` constructs two agents and two runs and demands they stay apart.

## 8 · Evidence — five questions, and two answers are no

Every study behind the four sections above, read from the JSON artefact each one wrote. Does it run
on-chain? Does the model know anything? Does the portfolio layer matter? **Would providing liquidity
work instead — no**, measured live with zero shares paired off against real adverse selection. **Is
there a model-free arbitrage across tenors — no**, real and violated 719 times, and a median of two
shares deep.

Anyone can publish the result that flattered them. Publishing the refusals with the arithmetic
attached is the only cheap way to tell the difference, and this page needs no database to do it — so
it keeps answering when everything else on this deployment cannot.

### The loop that closes it

```
market → prediction → decision → outcome → evidence
```

Every settled Event Contract joins the calibration dataset and the agent's record, so the next answer
rests on one more settled fact than the last. It runs inside the worker, not a terminal window.

## 9 · The honest headline

Two results, and the second one matters as much as the first.

**The forecasting model works.** On **9,232 held-out forecasts** — drawn from a study of 30,771
forecasts across 6,157 settled windows — **AUC 0.8305, Brier 0.1696, 32.2% skill** over
always-saying-0.5. The held-out split is the one that counts, and 9,232 is its size; the larger
number is the study, not the test.

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

So Rivo is not "a bot that makes money". It is an intelligence and validation product with a measured
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

## 10 · Architecture

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
  *.test.ts    903 tests, colocated with what they cover
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

## 11 · Run locally

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
| `npm test` · `npm run typecheck` | 903 tests · strict TypeScript across engine, page and web app |
| `npm run doctor` | can Rivo trade right now — signer, gas, collateral, venue, kit |
| `npm run faucet` | mint testnet tUSDC — a direct `faucet(uint256)` call, no kit needed |
| `npm run check:kit` · `npm run link:kit` | verify / install the optional bot kit |

Every command except `link:kit` runs with no private key. All `--days` commands read public
indexers.

---

## 12 · Deployment

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

## The browser bundle

```bash
npm run build:public     # static files in public/, no backend
npx serve public
```

The pricing engine also runs with **no Node, no backend and no wallet** — it imports the *same*
fair-value code the trading runtime uses rather than a copy, and both Somnia indexers send
permissive CORS headers, so a browser can reach the venue directly. `src/public/boot.test.ts` boots
the shipped bundle in a DOM, so that property is tested rather than claimed.

It is a portability proof, not a second product. It was once published at its own address and served
as a second Rivo with its own identity; that address is retired, because two surfaces disagreeing
about what one product is helped nobody. Every study that lived only there — the live maker run and
the cross-tenor coherence bound — is on [/evidence](https://rivo-autopilot.vercel.app/evidence).

**Rivo is one deployment: [rivo-autopilot.vercel.app](https://rivo-autopilot.vercel.app/).**

## 13 · Reproducing every number

Every number in this document was produced by a command in this repository and written to
`docs/evidence/` as JSON. Nothing here is typed in by hand, and the tests refuse to let the
documented figures drift from the artefacts they claim to quote.

### Tests

```bash
npm test
```

**903 tests** across the things that either move money or produce a published number: the
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
- **[docs/submission/](docs/submission/)** — the 3-minute demo script rehearsed against production, the final submission copy, and thirteen judge questions each answered against this repository
- **[DISCLAIMER.md](DISCLAIMER.md)** — read before running anything with money
- [docs/evidence/](docs/evidence/) — saved outputs and a dashboard snapshot

## License

MIT — see [LICENSE](LICENSE).
