# Rivo — submission copy

Everything here is final text for the submission form. Numbers were read from production; re-check
them with `npm run release` before pasting if time has passed.

---

## Project title

```
Rivo
```

## Tagline

```
Event Contracts you can check before you trade them.
```

## Short description

```
Event Contracts you can check before you trade them. Rivo takes a live DreamDEX price and puts it
next to how often contracts priced like it actually settled true — 2,179 settled windows, with the
sample size attached to every claim. Other tools score the forecaster; this one scores the venue.

It also answers the second question a builder has: whether an agent's edge survives the spread. Rivo
validates agents economically rather than by accuracy, runs them in live Shadow against real markets
without sending anything, and proves the ones that qualify through real DreamDEX testnet
transactions on Somnia. Its own model is the first case study — and it is REJECTED.
```

## Long description

```
THE PROBLEM

DreamDEX may say BTC UP 15m is 67%. Nothing on the venue tells you whether contracts that quoted 67%
went on to settle true about 67% of the time — which is the only question that number raises. And a
model that forecasts well can still lose money when you cross the spread to act on it. Those are two
different measurements, and a builder deploying an agent needs both before capital moves.

CHECK — THE TEN-SECOND ANSWER

One live contract, two numbers beside each other: what the book is asking, and how often contracts
priced like it actually settled true. One sentence says which way that cuts. "Show the working"
unfolds the cohort, the price band, the settled-window count, the 95% interval and the date range —
folded rather than dropped, because a reader who wants the table has four other surfaces and a
reader who wants an answer had none. A caveat outranks a claim: a thin sample, a wide book or
missing depth becomes the headline rather than a footnote under one.

There is no buy button, and that is the design. A verdict about whether a price band has
historically paid, sitting next to a control that acts on it, is a recommendation however the copy
is worded. The refusal is structural — the page cannot import a signer, a wallet or a portfolio
route, and a test asserts it.

EVENT INTELLIGENCE

Rivo reads every live Event Contract and shows the implied probability beside how often comparable
contracts actually settled true. "Comparable" is not hand-waving: each card names the cohort that
answered, the price band the contract fell into, the number of independent settled windows, the 95%
interval and the date range. Cohorts run BTC 15m → BTC all tenors → all assets 15m → global, and fall
back only on sample size — never silently mixing assets or tenors while presenting the result as
market-specific.

CALIBRATION

Measured over 2,179 settled windows as of 2026-09-04: Brier 0.1821 against 0.2497 for always quoting
the base rate — a skill score of 27.1%. The worker recomputes it as more contracts settle, so the
live figure grows. An earlier snapshot said 35.8% over 843 windows; the sample has since more than
doubled and every one of the twenty price bands now clears the 30-window floor. DreamDEX prices carry real information. Windows are the unit rather than fills,
because forty rows from one settled contract are forty copies of one coin flip.

AGENT VALIDATION

Rivo validates agents economically, not by accuracy. Its own model, Rivo V1, has an AUC of 0.8158,
which is genuinely good, and a return on stake of +2.80% out of sample across five walk-forward
folds — with a t-statistic of 0.79, and −0.50% once its best fold is removed. The validation set is
2,179 settled windows, 2026-07-22 → 2026-09-04; the rule would have traded in 986 of them. The
strategy state is REJECTED, because the gate asks for significance and breadth rather than for a
positive number. A model can predict well and still trade badly.

That return was −6.49% when the study was first run on 737 windows. The venue has since tripled its
settlement rate and an indexer defect that was hiding the newest windows is fixed, so the same rule
now measures positive — and the verdict did not move, because it never depended on the sign. A gate
that had meant "the backtest is negative" would have opened here.

LIVE SHADOW

An agent decides against live DreamDEX contracts in a background worker and sends nothing. Shadow is
not a simplified second path: it runs the same pre-execution pipeline as real execution — decision
schema, market eligibility, strategy state, risk ceilings and DreamDEX's own lot size — and stops at
the signer. The two modes reach identical intents; the only difference is whether a signature may be
requested. Every hypothetical resolves against the venue's own settlement when the contract closes.

EXPERIMENTAL TESTNET EXECUTION

Five things must agree before capital moves: strategy state, execution mode, network, signer and
portfolio risk. Rivo V1 is REJECTED, so it runs only under an explicitly chosen Experimental Testnet
mode, on an approved testnet, and is structurally unable to activate on mainnet. Unknown chain,
unknown strategy state and unknown mode all block. Fail closed.

PROOF

One order is walked end to end with the identifier needed to verify each link independently: agent
decision, risk check, venue normalisation, order submitted, Somnia confirmed, ledger persisted,
reconciled, settled or pending. Receipts are read back from the RPC rather than inferred from the
send, which is why block numbers are in the record. A deterministic refusal — a size that rounds to
zero at DreamDEX's lot — is recorded as REFUSED before signing rather than as an execution failure,
so the failure count means genuine chain and SDK failures and nothing else.

THE SETTLEMENT FEEDBACK LOOP

market → prediction → decision → outcome → evidence

Every settled Event Contract joins the calibration dataset and the agent's validation record, so the
next answer rests on one more settled fact than the last. It runs inside the worker, not a terminal
window.
```

## DreamDEX integration

```
EVENT CONTRACT DATA
Live markets, order books and implied probabilities for all eight windows the venue lists —
{BTC, ETH} × {15m, 1h, 4h, 1d}, sixteen legs — read from the Somnia Markets indexer.

HISTORICAL FILL AND SETTLEMENT DATA
Calibration is computed from contracts that have already settled: 2,179 settled windows as of
2026-09-04, drawn from six weeks of the venue's own fills and oracle answers. Retired 60s and 300s series are excluded because
they are not the product.

SDK EXECUTION
Orders go through @dreamdex-bot-kit/ec-core: createExchange, activeMarkets, marketOnchain,
isTradable, sellableSize, placeLimit. Rivo adds the ERC-20 approval the event-contract path does not
carry, and rounds every size down to a lot the venue actually accepts — measured, because the config
tick is not what reverts.

TESTNET TRANSACTIONS
Real orders on Somnia Shannon, chain 50312. The demo run holds 16 executions carrying a transaction
hash, every one of them confirmed, across 92 positions. A further 90 ledger rows are marked confirmed
without a hash — claims, exits, merges and reconciliation adoptions that resolved against chain state
rather than being sent as orders by Rivo. /proof counts only the 16, because "confirmed" and "reached
the chain as our transaction" are different claims and merging them would inflate the better one.

SETTLEMENT PROVENANCE
Rivo links each settled window to the Prophecy Oracle question that resolved it — the literal
question ("What is the price of BTC in USDC at unix time N?"), the subcommittee that answered, the
declared price, and the oracle's OWN transaction hash. That is a second on-chain record, independent
of Rivo's, and it is why the proof does not stop at "the venue says UP".

The oracle also publishes `numericDecimals`, which the markets path does not carry — the missing
field that forces Rivo to infer a price magnitude by matching against a known value. Documented as
SDK feedback: the field exists, it just does not travel.

SOMNIA EVIDENCE
Every hash resolves on shannon-explorer.somnia.network. Receipt status, block number and gas used are
read back from api.infra.testnet.somnia.network rather than assumed from a successful send.
```

## Innovation

```
Rivo exploits something specific to Event Contracts: they settle, and settlement is ground truth.

AND IT POINTS THAT AT THE VENUE, NOT AT THE USER.

Scoring a forecaster against outcomes is a known idea and other entries do it well. Scoring the
MARKET is the different one: taking DreamDEX's own quoted probability as the forecast under test,
across every contract it has already settled, bucketed into twenty price bands with a cohort and a
sample size on each. The answer — Brier 0.1821 against 0.2497 for the base rate, a skill score of
27.1% over 2,179 settled windows — is a fact about the venue that the venue does not publish, and it
is measured on real settlements rather than on a simulation.

A perpetuals dashboard cannot tell you whether its numbers were right. A binary contract that expires
can — the market said 67%, and the world then said yes or no. That makes two things possible that are
not possible elsewhere:

1. PROBABILITY CALIBRATION AS A PRODUCT. The venue's own price becomes a testable forecast, scored
   against outcomes, with cohorts and sample sizes attached to every claim.

2. ECONOMIC AGENT VALIDATION. An agent can be scored on what its decisions were worth after the
   spread, not on how often it was directionally right — because every decision has a settled answer.

The second is the part that makes this not another bot. Rivo's headline result is a REFUSAL of its
own model, published with the arithmetic: AUC 0.8158, +2.80% return on stake at t = 0.79, and a
REJECTED verdict anyway. The apparatus was tested the hard way — the number it was refusing turned
positive when the sample tripled, and the refusal held, because it was reading significance rather
than sign. The measurement apparatus is the product, and an apparatus honest enough to keep
rejecting its own strategy after the number moved in its favour is the only kind worth trusting with
somebody else's.
```

## Technical implementation

```
Rivo is one deployment with two planes.

The WEB PLANE (Next.js on Vercel) is request-scoped and holds no trading loop. It serves Markets,
Calibration, Agents, Proof and Evidence. Four of the five need no wallet and no account.

The EXECUTION PLANE is a worker process. It manages deployments on a fenced PostgreSQL lease, and —
guarded by a single advisory lock so exactly one worker in a fleet does it — runs the Shadow pass,
settlement resolution and calibration refresh. A product whose claim is "every settled contract
becomes new evidence" cannot depend on a terminal window staying open.

THE SHARED PRE-EXECUTION PIPELINE is the core of it. One pure function decides schema, eligibility,
policy, risk and venue normalisation for both Shadow and real execution; the fork is a single field
saying whether a signature may be requested. Tests assert the two modes produce byte-identical intents
apart from that field, because a Shadow record of a trade the real path would have refused is not weak
evidence — it is evidence pointing the wrong way.

EVIDENCE INTEGRITY is enforced rather than promised. Decision and execution logs are append-only at
the database level. Evidence is scoped to one run: a deployment's counts contain only that deployment's
rows, and decisions an agent made outside any deployment are shown separately as global agent evidence,
never merged. Shadow columns are named hypothetical_* throughout so a query has to opt into the lie.

SIGNING is non-custodial. Portfolio wallets are Privy TEE wallets; Rivo holds a revocable right to
request signatures and never holds key material. What that right cannot be scoped to on-chain is
stated plainly rather than claimed.

945 tests, strict TypeScript across engine, browser bundle and web app, integration tests against a
real PostgreSQL, and a CI job that fails if the database tests silently stop running.
```

## Ecosystem impact

```
Rivo closes a loop that currently has a gap in it.

  BUILDER writes an agent
    → VALIDATE against settled outcomes, economically, before any capital
    → SHADOW against live DreamDEX markets, autonomously, sending nothing
    → DEPLOY the ones that qualify to Experimental Testnet
    → DREAMDEX ACTIVITY from agents that have been tested rather than hoped for
    → MORE SETTLEMENT EVIDENCE, which improves the calibration every later agent is measured against

The gap today is between "my backtest looks good" and "I am willing to fund this". Nothing on the
venue closes it, so the honest options are to deploy on faith or not deploy at all. Rivo makes the
step in between cheap, and the first move needs no account at all: POST a URL to /api/try-agent and
Rivo runs one decision against one live DreamDEX window, judged by the same pipeline real execution
uses. Then connect the endpoint properly, get scored against live markets and real settlements,
and see a verdict that reads the economics rather than the accuracy.

The loop compounds for the venue rather than for Rivo. Every settled contract makes the calibration
dataset better, which makes the next validation sharper, which makes the agents that pass it more
likely to be worth their spread.

AND ONE CONTRIBUTION IS ALREADY DELIVERED.

Building this deep against the venue surfaced eleven defects in the SDK, the indexer and the
contracts, each written up with a reproduction for the people who maintain them
(docs/SDK-FEEDBACK.md). Three that cost a builder real time:

  * The oracle's `numericValue` scale is inconsistent and undeclared — opening references arrive at
    1e2 and settlement answers at 1e4, with no field saying which. Read it wrong and every
    probability is 100x off, silently.
  * `ec-core` has no allowance handling, so a fresh wallet's first order always reverts. Nothing in
    the kit or the SDK does the approval, and the failure does not name itself.
  * Down-leg liquidity comes from resting BUY_YES orders — buying Up and buying Down mints a pair —
    so a depth model that counts only SELL_YES under-fills the DOWN side, and the docs do not say so.

A twelfth was found on 2026-09-05 and is Rivo's own: the indexer read paged ascending under a
20,000-row ceiling, so once the venue crossed it the newest settlements silently fell out of every
query. It cost 40% of the available evidence for five days without an error. Fixed, tested, and
written up — because the same product that publishes its model's failure does not get to quietly fix
its own data bug.

That is ecosystem impact that has already happened, rather than adoption that is promised.
```

## Links

```
GitHub       https://github.com/Rzbyte/Rivo
Live demo    https://x-rivo.vercel.app
Demo video   [placeholder — paste the URL after upload]
```

## Team

```
Rzbyte
```
