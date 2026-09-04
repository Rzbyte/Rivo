# Alpha research: can Rivo tell when DreamDEX is wrong?

**Verdict: no. No economically defensible taker alpha was found, and no candidate
survives the correction for having looked twenty-three times.** The production
strategy is unchanged. Nothing in this study touched the engine, the allocator,
the ledger, the worker, the signer or the web app.

**Re-measured 2026-09-04 on 2,179 settled windows.** The study was first run on
737 windows to 2026-08-23. Its own §10 said the binding constraint was sample
size rather than model quality; the venue has since tripled its daily settlement
volume, and an indexer defect that was hiding the newest windows is fixed
([CALIBRATION.md § Which windows reach the sample](CALIBRATION.md)). §11 records
what changed. The short version: **the production rule's out-of-sample return
went from −6.49% to +2.80% and it is still REJECTED**, because +2.80% at t = 0.79
that does not survive removing its best fold is not evidence of anything.

Reproduce with `npm run alpha -- --days 90 --folds 5 --out docs/evidence/alpha-research.json`.
The full result set is [`docs/evidence/alpha-research.json`](evidence/alpha-research.json).

---

## 1. The question changed

**V1** — what this repository shipped and still runs:

> underlying → diffusion fair probability → `fair − ask` → Kelly → portfolio → trade

Its economics are in [EVIDENCE.md §3](EVIDENCE.md) and
[`backtest.json`](evidence/backtest.json), and they are bad: **−30.8% return,
51.9% max drawdown, 1,200 trades** over 30 days, with every unconstrained
variant reaching **−100%**. The forecast itself is fine. Reading the whole gap
between a good forecast and the market as tradable edge is not.

**V2** — what was researched here:

> DreamDEX price is the prior; predict only the residual `settled − price`

For a taker this target *is* the per-share P&L, so "the model was right" and "the
trade made money" are the same statement and cannot drift apart.

Both are preserved. Neither result is deleted.

## 2. Baseline reproduced first

| check | result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build:public` | pass |
| `npm test` (real PostgreSQL 16) | **929 passed, 0 skipped, 65 files** |
| historical backtest evidence | re-read from `backtest.json`, unmodified |
| checkpoint | git tag `alpha-baseline-v1` |

The production edge path, traced end to end:
`fairValue()` (`src/model/fairvalue.ts`) → `fair` → `edge = fair − ask`
(`src/engine/opportunity.ts:150`) → `minEdge` gate (`src/portfolio/allocator.ts:143`)
→ Kelly → constraints → executor.

## 3. The dataset, and the constraint that dominates everything

`src/research/dataset.ts`. Built from the public indexer; no key, no signer.

- **61,356 decision rows across 2,179 settled windows**, 2026-07-22 → 2026-09-04.
  (First run: 54,731 rows across 737 windows, to 2026-08-23. See §11.)
- The indexer holds **no history before 2026-07-22**. Forty-four days is all there is.
- **Windows are the unit of evidence, not fills.** Every fill inside a window
  shares one settlement. Forty rows from one window are one coin flip.

Three findings about the data mattered more than any model:

1. **95% of all rows fall on two days** (22–23 July: 27,202 and 24,593 rows;
   most later days are double digits). Equal-time folds therefore put almost
   everything in the training block and scored candidates on 4.5% of the sample.
   The shipped splitter is window-balanced for this reason; `--blocks time`
   reproduces the degenerate version.
2. **The base rate flips sign between regimes.** Taking every executable fill
   returns **−2.04%** before 25 July and **+4.92%** after. A candidate scoring
   +3% in the second period has beaten nothing.
3. **Only one side of a fill is provably takeable.** A resting `SELL_YES` proves
   you could buy UP; it does not prove you could buy DOWN at `1 − p`. The
   previous backtest priced both legs off every fill. Restricting to the
   executable side changes the average price paid from 0.500 to 0.481 and is the
   single largest correction in the study.

## 4. Leakage controls

| risk | control |
|---|---|
| future price data | bars usable only from `t + 60`; the bar in progress is never read |
| settlement leakage | training restricted to windows whose **expiry** precedes the fold's first decision — not merely whose decision time precedes it |
| overlapping windows | cluster bootstrap on `marketId` for every standard error |
| outcome in features | asserted by test: two rows differing only in `won` produce identical feature vectors |
| threshold tuning | `favourite-learned` re-derives its cutoff inside each training fold; the fixed-cutoff twin is labelled in-sample in its own name |
| standardisation leakage | feature means and SDs fitted on the training fold only |

## 5. Features and targets

Sixteen features, all as of the decision instant: price and distance from 0.5,
the diffusion gap, log time to expiry, phase, moneyness, `z`, remaining sigma,
1/5/15-minute underlying returns, a short/long volatility ratio, the change in
this leg's price since the previous fill, log fill count so far, leg and asset.

Target: `won − price`. Predicting `won` directly and differencing was tried and
discarded — it reintroduces exactly the V1 failure mode.

## 6. Results

Walk-forward, five window-balanced blocks, expanding window, `t` from a
window-clustered bootstrap.

| strategy | ROS | t | windows | verdict |
|---|---|---|---|---|
| market-only (trust the price) | +0.00% | — | 0 | baseline |
| **take every executable fill (base rate)** | **−1.42%** | −0.84 | 1744 | REJECTED |
| diffusion `fair − price > 0` | +1.34% | +0.49 | 1236 | REJECTED |
| diffusion `fair − price ≥ 0.02` | +3.14% | +0.95 | 1070 | REJECTED |
| diffusion `fair − price ≥ 0.03` *(production)* | +2.80% | +0.79 | 986 | REJECTED |
| price ≥ 0.90 (cutoff fixed in-sample) | −0.88% | −0.45 | 312 | REJECTED |
| price ≥ cutoff learned per fold | −1.75% | −0.68 | 672 | REJECTED |
| first trade in the window | +5.64% | +2.31 | 1604 | **passes the floor — see §7** |
| residual ridge ≥ 0.005 | −0.40% | −0.17 | 1381 | REJECTED |
| residual ridge ≥ 0.010 | −0.84% | −0.34 | 1283 | REJECTED |
| residual ridge ≥ 0.020 | −0.42% | −0.15 | 1035 | REJECTED |
| residual ridge, LCB −1σ | +2.56% | +0.49 | 216 | REJECTED |
| residual ridge, LCB −2σ | −63.73% | −2.23 | 3 | REJECTED |
| residual ridge, shrunk ×0.5 | −0.42% | −0.15 | 1035 | REJECTED |

**The production row is positive now, and nothing about the verdict moved.** The
gate's objection was never the sign. `judge()` asks for t ≥ 2 on a
window-clustered bootstrap and for the result to survive removal of its best
fold; +2.80% arrives with t = 0.79, and removing the best of the five folds takes
it to **−0.50%**. The same two objections were the operative ones at −6.49%.

**One row now clears the automated floor**, and it is the one this study already
spent §7 refusing. `first trade in the window` returns +5.64% at t = 2.31 over
1,604 windows, so `judge()` — which knows nothing about how many conditions were
scanned to find it — returns VALIDATED. Under the correction for a 23-condition
scan the bar is |t| ≈ 3.72, and 2.31 is not close to it. The floor is a
necessary condition and not a sufficient one; `gating.ts` promotes nothing
automatically, and nothing was promoted.


**Not one candidate reaches t = 2.** The best point estimates come from the
uncertainty-*un*adjusted residual model, and subtracting a standard error —
which is the statistically correct thing to do — makes them worse, which is what
a signal that is mostly noise looks like.

### Claimed edge against realised return

The V1 failure repeated, and it survived tripling the sample. For
`diffusion ≥ 0.02` the 0.020–0.030 bucket realises **+5.72%**, the next one
**−4.87%**, and 0.050–0.080 **+15.14%**; for the base rate, 0.000–0.010 realises
**+36.29%** and 0.050–0.080 **−2.19%**. There is no monotone relationship
anywhere in either table. A bigger claim does not pay better, which is the whole
mechanism a taker would need in order to size on the claim.

(First run, 737 windows: `diffusion ≥ 0.02` realised −17.12% in 0.020–0.030 and
+15.55% in 0.050–0.080. Every individual bucket moved. The absence of a gradient
did not.)

## 7. What did look real, and why it still fails

**Favourite–longshot bias is present and statistically strong.** Over the whole
sample, executable legs priced below 0.20 lose −0.019 to −0.064 per share
(t = −4.5, −4.1, −2.4) and legs above 0.90 gain +0.048 and +0.012 (t = +3.4,
+2.2). Buying favourites returned **+2.53% ROS at a 98.5% win rate** across 314
windows, positive in all four temporal quarters, both assets and every tenor, and
it survives removing its three best windows. Only 80 rows sit inside the
production expiry-headroom block, so it is reachable.

It fails anyway, for a reason that is not visible in the aggregate: **measured
against the base rate of its own period it flips.** +4.60% excess before 25 July,
**−3.22%** after. The aggregate is positive only because the two regimes are
pooled.

The re-run is the out-of-sample test of that sentence, and it holds. With three
more weeks of settlements the two favourite rules go negative outright:
`price ≥ 0.90` from **+1.92% to −0.88%**, and `price ≥ cutoff learned per fold`
from **+2.75% to −1.75%**. The regime-dependence was the finding; the positive
aggregate was the artefact of pooling.

**Twenty-three conditions were scanned** on the first regime and tested on the
second. Exactly one kept its sign on both raw and excess return: *the first trade
in a window*. On 737 windows it returned +7.36% at t = +1.91; on 2,179 it returns
**+5.64% at t = +2.31**, which clears `judge()`'s floor of 2. It fails anyway:

- Under a 23-condition scan, the 95th percentile of the largest |t| by chance is
  **≈ 3.72**. Observed: 2.24 on the first run, 2.31 on the second. The extra
  sample bought 0.07 of a t, and the bar it has to clear is 3.72.
- On the first run, 78% of its profit came from one block of 126 windows out of
  731, and removing that block took it from +7.66% to +1.96%. On the re-run,
  removing the best of five folds takes **+5.64% to +4.37%** — better behaved,
  and still not the question. The question is how many conditions were looked at
  before this one was kept.
- The first trade in a window is the most anomalous observation in the sample.
  §8 records what happened the last time this study let that observation in
  through the back door.

It is what noise looks like when you look twenty-three times, and looking at
three times as much data does not unlook.

## 8. A methodological error found in this study's own machinery

The first version of the decorrelated view kept the **earliest** qualifying fill
per window. The first trade in a window is the most anomalous observation in the
sample, so "keep the first" silently loaded every strategy with that anomaly and
reported it as decorrelation — the diffusion strategy appeared to earn **+17.22%
out of sample**, contradicting the repository's own −30.8%. The pick is now
deterministic in the window id and independent of position, price and outcome.
The contradiction disappeared. It is recorded here because it was very nearly
published.

## 9. The gate — and it is now wired

**Update.** When this study was written the gate existed and nothing consulted it. `mayExecuteLive()`
was called by the research CLI and by nothing on the execution path, so the verdict below was a
document rather than a control. That is fixed: the worker now computes
`strategy state · execution mode · network · signer` before an executor is built, and a REJECTED
strategy cannot receive real capital on any network. See
[ARCHITECTURE.md § Execution permission](ARCHITECTURE.md) and `src/runtime/permission.ts`.

The incumbent runs under **Experimental Testnet**, which is testnet-only and chosen explicitly.

## 9. The gate

`src/research/gating.ts`. States: `UNVALIDATED` → `SHADOW_ONLY` → `VALIDATED` |
`REJECTED`. Only `VALIDATED` may sign; the default for anything new is
`SHADOW_ONLY`. The criteria are **evaluated in code**, not asserted in prose:
ROS ≥ 2%, ≥ 200 settled windows, t ≥ 2, ≥ 3 of 4 folds non-negative, drawdown
≤ 25% of stake, must survive removal of its best fold, and must beat the base
rate. Sixteen tests cover it, including the case a candidate here actually failed.

No candidate reached `SHADOW_ONLY`, so no shadow integration was made. Shipping
shadow plumbing for a signal already known to be noise would add live surface
area for nothing.

## 10. Strongest next direction

Not a better model — **more independent windows**, and this is the one
recommendation the re-run gets to grade.

With 737 clusters and a Bernoulli outcome near 0.5, the standard error on a mean
residual is about 0.5/√737 ≈ 0.018, so a true edge of +0.02 per share was barely
one sigma. Roughly **5,600 settled windows** are needed to resolve an edge that
size at three sigma. At the time of writing this venue had produced 985 in its
recorded history.

**Twelve days later it has produced 2,179.** The standard error is now
0.5/√2179 ≈ 0.011, and the production rule's t moved from −0.50 to +0.79 — which
is what it looks like when an unresolved quantity gets measured better rather
than when a strategy starts working. At the venue's current rate of roughly 830
finalized windows a day, of which about a third trade, 5,600 clusters is weeks
away rather than years. That is the first number in this study that has moved in
a direction worth waiting on.

The defensible order of work is therefore unchanged: keep recording live
decisions to accumulate clusters, and prefer the **maker** side, where
EVIDENCE.md §6 already measures a real if negative result and where the spread is
earned rather than paid. Taker alpha on this venue is not refuted — it is
**unresolvable with the data that exists**, which is a different and more useful
conclusion, and the amount of data that exists is now growing fast enough for
that to be a temporary state.

## 11. What the re-run changed

Run 2026-09-04 against 2,179 settled windows; the original ran 2026-08-23 against
737. Same code, same walk-forward, same acceptance floor.

| | first run · 737 windows | re-run · 2,179 windows |
|---|---|---|
| dataset | 54,731 rows, 2026-07-22 → 08-23 | 61,356 rows, 2026-07-22 → 09-04 |
| production rule ROS | −6.49% | **+2.80%** |
| production rule t | −0.50 | **+0.79** |
| production rule, best fold removed | — | **−0.50%** |
| production rule state | REJECTED | **REJECTED** |
| base rate (take every fill) | −0.89% | −1.42% |
| favourites, price ≥ 0.90 | +1.92% | −0.88% |
| first trade in the window | +7.36%, t 1.91 | +5.64%, t 2.31 |
| candidates clearing the automated floor | 0 | 1 (`first trade in the window`) |

**Why the sample nearly tripled.** Two reasons, and only one of them is the
venue's. DreamDEX went from ~250 finalized windows a day in early August to ~830
by the end of it. And the indexer read that feeds this study was paging
`expiry: asc` under a 20,000-row ceiling: once the venue crossed that ceiling —
which it did around 2026-08-30 — every settlement after it fell off the end of
the query, silently, with the returned rows still real and ordered. The study was
therefore measuring a sample that had stopped advancing. Fixed in
`src/core/indexer.ts`, held by `src/core/indexer.test.ts`, described in
[CALIBRATION.md](CALIBRATION.md).

**What did not change.** The verdict, the state of the production strategy, and
the reason for both. `judge()` was never reading the sign of the return: at
−6.49% it objected to t = −0.50 and to a result that did not survive its best
fold, and at +2.80% it objects to t = +0.79 and to a result that does not survive
its best fold. A gate that had encoded "the backtest is negative" would have
opened here, on evidence that got better rather than on evidence that got good.
That distinction is the reason this record is a computed verdict rather than a
sentence somebody wrote down.

## 12. Files

Added: `src/research/dataset.ts`, `src/research/residual.ts`,
`src/research/walkforward.ts`, `src/research/strategies.ts`,
`src/research/gating.ts`, `src/research/research.test.ts`, `src/cli/alpha.ts`,
`docs/ALPHA-RESEARCH.md`, `docs/evidence/alpha-research.json`.

Changed: `scripts/privy-check.ts` and `src/signing/privy.ts` (readiness fix,
below), `src/signing/privy.test.ts`, `package.json` (`npm run alpha`).

Untouched: the engine, allocator, exposure controls, position lifecycle,
PostgreSQL layer, execution ledger, worker, scheduler, Privy signing path,
reconciliation, settlement and the web app.

## 13. Privy readiness, fixed

`preflight()` has called `PRIVY_AUTHORIZATION_KEY` **required** for TEE wallets
for some time. `npm run privy:check` disagreed with it:

```ts
// A missing authorization key is a recommendation, not a failure.
const blocking = p.problems.filter((x) => !x.startsWith("PRIVY_AUTHORIZATION_KEY"));
```

A deployment missing that key passed its own readiness check, started a worker,
accepted a user's grant of Autopilot, and then failed every approval it
attempted. That ran here for an hour and forty minutes and produced **586
rejected signatures**, all surfacing as ordinary trade failures.

There is now no severity tier. `serverSigningReady()` returns true only when
`problems` is empty, and a test asserts that removing **any** required variable
blocks readiness — so a problem added to `preflight()` later is blocking by
default rather than by somebody remembering to make it so.
