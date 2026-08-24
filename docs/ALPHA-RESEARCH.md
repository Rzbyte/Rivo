# Alpha research: can Rivo tell when DreamDEX is wrong?

**Verdict: no. No economically defensible taker alpha was found, and none of the
fourteen candidates is eligible for live execution.** The production strategy is
unchanged. Nothing in this study touched the engine, the allocator, the ledger,
the worker, the signer or the web app.

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
| `npm test` (real PostgreSQL 16) | **808 passed, 0 skipped, 53 files** |
| historical backtest evidence | re-read from `backtest.json`, unmodified |
| checkpoint | git tag `alpha-baseline-v1` |

The production edge path, traced end to end:
`fairValue()` (`src/model/fairvalue.ts`) → `fair` → `edge = fair − ask`
(`src/engine/opportunity.ts:150`) → `minEdge` gate (`src/portfolio/allocator.ts:143`)
→ Kelly → constraints → executor.

## 3. The dataset, and the constraint that dominates everything

`src/research/dataset.ts`. Built from the public indexer; no key, no signer.

- **54,731 decision rows across 737 settled windows**, 2026-07-22 → 2026-08-23.
- The indexer holds **no history before 2026-07-22**. Thirty-two days is all there is.
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
| **take every executable fill (base rate)** | **−0.89%** | −1.24 | 590 | REJECTED |
| diffusion `fair − price > 0` | −5.98% | −0.58 | 479 | REJECTED |
| diffusion `fair − price ≥ 0.02` | −6.29% | −0.50 | 458 | REJECTED |
| diffusion `fair − price ≥ 0.03` *(production)* | −6.49% | −0.50 | 437 | REJECTED |
| price ≥ 0.90 (cutoff fixed in-sample) | +1.92% | +0.92 | 178 | REJECTED |
| price ≥ cutoff learned per fold | +2.75% | +0.64 | 308 | REJECTED |
| first trade in the window | +7.36% | +1.91 | 584 | REJECTED |
| residual ridge ≥ 0.005 | +0.30% | +0.03 | 461 | REJECTED |
| residual ridge ≥ 0.010 | +1.56% | +0.16 | 438 | REJECTED |
| residual ridge ≥ 0.020 | +4.25% | +0.40 | 384 | REJECTED |
| residual ridge, LCB −1σ | −1.10% | −0.10 | 161 | REJECTED |
| residual ridge, LCB −2σ | +1.23% | +0.16 | 33 | REJECTED |
| residual ridge, shrunk ×0.5 | +4.25% | +0.40 | 384 | REJECTED |

**Not one candidate reaches t = 2.** The best point estimates come from the
uncertainty-*un*adjusted residual model, and subtracting a standard error —
which is the statistically correct thing to do — makes them worse, which is what
a signal that is mostly noise looks like.

### Claimed edge against realised return

The V1 failure repeated. For `diffusion ≥ 0.02` the 0.020–0.030 bucket realised
**−17.12%** while 0.050–0.080 realised **+15.55%**; for the base rate the
0.010–0.020 bucket realised **−31.41%** and the next one **+19.87%**. There is no
monotone relationship anywhere in the table. A bigger claim does not pay better.

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

**Twenty-three conditions were scanned** on the first regime and tested on the
second. Exactly one kept its sign on both raw and excess return: *the first trade
in a window* (+7.36%, t = +1.91). It fails too:

- 78% of its profit comes from one block of 126 windows out of 731.
- Removing that block takes it from **+7.66% to +1.96%**.
- Under a 23-condition scan, the 95th percentile of the largest |t| by chance is
  **≈ 3.72**. Observed: 2.24.

It is what noise looks like when you look twenty-three times.

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

Not a better model — **more independent windows.** With 737 clusters and a
Bernoulli outcome near 0.5, the standard error on a mean residual is about
0.5/√737 ≈ 0.018, so a true edge of +0.02 per share is barely one sigma. Roughly
**5,600 settled windows** are needed to resolve an edge that size at three sigma;
this venue has produced 985 in its recorded history, and 95% of the trading
activity arrived in two days.

The defensible order of work is therefore: keep recording live decisions to
accumulate clusters, and prefer the **maker** side, where EVIDENCE.md §6 already
measures a real if negative result and where the spread is earned rather than
paid. Taker alpha on this venue is not refuted — it is **unresolvable with the
data that exists**, which is a different and more useful conclusion.

## 11. Files

Added: `src/research/dataset.ts`, `src/research/residual.ts`,
`src/research/walkforward.ts`, `src/research/strategies.ts`,
`src/research/gating.ts`, `src/research/research.test.ts`, `src/cli/alpha.ts`,
`docs/ALPHA-RESEARCH.md`, `docs/evidence/alpha-research.json`.

Changed: `scripts/privy-check.ts` and `src/signing/privy.ts` (readiness fix,
below), `src/signing/privy.test.ts`, `package.json` (`npm run alpha`).

Untouched: the engine, allocator, exposure controls, position lifecycle,
PostgreSQL layer, execution ledger, worker, scheduler, Privy signing path,
reconciliation, settlement and the web app.

## 12. Privy readiness, fixed

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
