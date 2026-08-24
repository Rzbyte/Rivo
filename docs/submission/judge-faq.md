# Judge FAQ

Short answers, each checkable against the repository. File and line references are given where the
answer is a design decision rather than an opinion.

---

### 1 · How is Rivo different from the DreamDEX Bot Kit?

The kit is how you place an order. Rivo is how you find out whether you should have.

Rivo depends on the kit and calls it — `createExchange`, `activeMarkets`, `marketOnchain`,
`isTradable`, `placeLimit`. What it adds sits above execution: measuring whether the venue's
probabilities are calibrated, measuring whether an agent has economic edge, and refusing to deploy one
that does not. A kit user with a strategy still has no way to answer "is this worth its spread". That
is the layer.

It also fills two gaps found by using the kit in anger: the event-contract path carries no ERC-20
approval (the spot path does), and the venue's real lot granularity is coarser than the config claims
— 9.749193… reverts where 3.71 fills. Both are documented in `docs/SDK-FEEDBACK.md`.

### 2 · How is Rivo different from Algo Arena?

Algo Arena is a place to compete. Rivo is a place to be tested before you compete.

There is no leaderboard, no ranking, no prize and no social layer here, deliberately. An agent
connects, gets scored against live markets and settled outcomes, and receives a verdict — including
`REJECTED`. The output is evidence a builder can act on, not a position in a table.

### 3 · Why does probability calibration matter?

Because a price on a binary contract is a forecast, and a forecast that is never scored is an opinion.

If contracts quoted at 67% settle true 67% of the time, the book is honest and your edge has to come
from somewhere other than disagreeing with it. If they settle true 39% of the time, that band is
systematically mispriced and the number tells you where. Neither fact is visible on the venue, and
both are computable from settlements the venue already has.

Measured over 834 settled windows: Brier 0.1614 against 0.2497 for always quoting the base rate — a
skill score of 35.4%. The middle of the book is mostly honest; parts of it are not.

### 4 · Why is Rivo V1 REJECTED?

Because it forecasts well and trades badly, and the gate reads the second thing.

AUC 0.8158 — it separates up from down. Return on stake −6.49% out of sample, across five
walk-forward folds over 737 settled windows, replayed against fills that actually executed. Every
edge band is negative and the losses grow with the claimed edge, which is the winner's curse measured:
selecting the leg that maximises `model − price` selects for the leg where the model's own error is
largest.

`src/research/gating.ts` holds the state as data, and `mayExecuteLive()` returns true only for
`VALIDATED`. Nothing about the accuracy can override it.

### 5 · Does Rivo claim profitability?

No, and it is built so that it cannot claim it by accident.

The strategy is REJECTED. The Shadow ledger's columns are named `hypothetical_size`,
`hypothetical_entry`, `hypothetical_pnl` so a query has to opt into presenting them as results. The
portfolio backtest is a ruin claim rather than a profit claim: Rivo ends **down 30.8%** and survives
1,200 trades where every alternative sizing rule reaches zero in under sixty.

What Rivo claims is that the measurements are correct, including the ones that are unflattering.

### 6 · What does Live Shadow actually do?

A background worker asks every registered agent about every live Event Contract leg, on a schedule,
and records what each one would have done — then resolves that record against the venue's own
settlement when the contract closes.

It is not a browser simulation and does not need a page open. `/api/shadow` reports the worker
heartbeat beside the counts so you can see it is alive rather than take the word for it.

### 7 · Does Shadow send transactions?

No. Structurally, not by policy.

Shadow and real execution share one pre-execution pipeline — `src/runtime/pipeline.ts` — covering
decision schema, market eligibility, strategy state, risk ceilings and DreamDEX's lot size. The fork
is a single field, `maySign`, set from the execution mode. No signer is reachable from the Shadow
path at all.

`src/runtime/pipeline.test.ts` asserts the two modes produce byte-identical intents apart from that
field. This matters more than it sounds: before the pipeline was shared, Shadow skipped every
constraint, so an agent looked best exactly where the limits would have stopped it.

### 8 · Is the DreamDEX proof a real transaction?

Yes. Somnia Shannon testnet, chain 50312.

```
run       5b35e672-963b-4af1-9076-539708692ec1  ·  experimental_testnet
market    BTC UP · 1d
size      10.94 shares at 0.922 — rounded down to a lot the venue accepts
tx        0x48cbabda4ad7a9f0f9196949278a0ec5fb09097d16a7a893ce592b66a18e8b91
receipt   CONFIRMED, block 469486171
```

The receipt was read back from the RPC rather than inferred from a successful send, which is why the
block number is in the record. The full artefact is `docs/evidence/final-proof.json`, and the run has
106 confirmed executions across 92 positions.

### 9 · Why is settlement PENDING?

Because that contract has not closed yet, and saying so is the point.

`CONFIRMED` means the chain accepted the order. `SETTLED` means the contract expired and the position
resolved. They are different facts and the Proof page never merges them. When that window closes the
same reconciler that closes real positions will write the outcome, and the label will change.

Asserting a settlement early would be the single most damaging thing this project could do to itself.

### 10 · Can external agents use Rivo?

Yes, over HTTP, with no code uploaded and nothing of yours running here.

Rivo POSTs one Event Contract's context to your endpoint and expects a typed decision back. It never
trusts the answer: the URL is checked against private, loopback and link-local ranges, the hostname is
resolved and the resolved address re-checked, redirects are refused rather than followed, the call
times out at four seconds, and every number you return is clamped to limits Rivo set. A malformed
response is a `SKIP`, not an error.

Your endpoint and your auth header are never returned to a browser — `/api/agents` selects neither.

### 11 · What is uniquely enabled by Event Contracts?

Settlement. These contracts expire and the world answers.

That is what makes the venue's own price a scoreable forecast, and what makes an agent's decision
scoreable in money rather than in direction. On a perpetual there is no moment at which the market was
right or wrong; here there is one, on a schedule, several times an hour, across eight windows.

Both of Rivo's core measurements — calibration and economic validation — are downstream of that single
property and would not exist without it.

### 12 · Why would this increase DreamDEX usage?

Because the expensive step in deploying an agent is the one between "my backtest looks good" and "I
am willing to fund this", and nothing currently closes it.

Rivo makes that step cheap: connect an endpoint, get validated against settled outcomes, shadow
against live markets, and deploy to Experimental Testnet with the evidence attached. Builders who
would otherwise not deploy at all get a path; builders whose agent fails find out before funding it
rather than after.

Every settled contract then makes the calibration dataset larger, which makes the next validation
sharper. The loop compounds for the venue.

### 13 · What is working, and what is future work?

**Working, in production, verifiable from the live URL:**

- Live Event Contract intelligence across all eight windows, with cohort, band, sample size, interval
  and date range on every card
- Calibration over 834 settled windows, recomputed automatically by the worker
- Rivo V1 economic validation with the full walk-forward study readable in the UI
- External HTTP agent registration, hardened as above
- Autonomous Shadow in a background worker, with heartbeat, resolving against real settlements
- Shared pre-execution pipeline across Shadow and testnet execution
- Experimental Testnet execution with 106 confirmed transactions, receipts, ledger and reconciliation
- Append-only decision and execution logs, run-scoped evidence, fail-closed strategy gate

**Future work, deliberately not built for this submission:**

- Per-agent calibration cohorts (an agent scored against the bands it actually trades)
- Settlement-time claim automation for the last open positions rather than at the next sweep
- Backfilling `block_number` onto historical executions — receipts are read live today
- A hosted worker on the deployment platform rather than an operator-run process
- Mainnet is deliberately unreachable and stays that way until a strategy is `VALIDATED`

**Known and stated rather than hidden:** the execution gate's limits are enforced in software, not
on-chain. This venue offers no on-chain way to scope what a signer may do with Event Contracts, and
`DISCLAIMER.md` says so rather than implying otherwise.
