# Evidence

Everything Rivo claims, with the method that produced it and the command that reproduces it.
No private key is needed for any of this — it all runs against public indexers.

The results that went against us are here too, at the same prominence. That is the point of the
document: a trading system's credibility comes from what its own measurements were allowed to
overturn.

---

## 1. The fair-value model has real forecasting skill

Every window asks *"does X close at or above its opening price?"*. That is 50/50 only at
inception; once the window is running the honest probability conditions on how far spot sits from
the reference and how long is left to move back:

```
P(close ≥ reference) = Φ( ln(S/R) / (σ·√τ) )
```

- `S` — underlying spot, from the oracle price feed at ~1s resolution
- `R` — the window's resolved opening price (`MarketReferenceLink` → `OracleAnswer`)
- `σ` — realized per-minute log-return volatility, measured over a 240-minute trailing window
- `τ` — minutes remaining

Driftless by choice: over minutes to hours the drift term sits far below the noise, and assuming
one would encode a directional view the model has no basis for.

### Method

Replay every settled window on the venue. Price each at **10%, 25%, 50%, 75% and 90%** through its
life and pair the forecast with what settlement actually decided.

Three things guard against flattering ourselves:

- **No lookahead.** A candle stamped `bucketStart = t` closes at `t + 60`, so the bar containing
  the sample instant carries up to a minute of the future. We use the last bar to have *fully
  closed*. This matters most exactly where it is easiest to cheat — a 15m window at 90% has 90
  seconds left, and that minute is most of the remaining uncertainty.
- **Reference scale anchored at the open.** The oracle's decimal scale is undeclared and
  inconsistent (see [SDK-FEEDBACK #1](SDK-FEEDBACK.md#1-the-oracles-numericvalue-scale-is-inconsistent-and-undeclared)).
  We resolve it against spot at the window's open, which *is* the reference by construction.
- **Retired series excluded, and reported.** 55% of raw settled windows are 56–60s test series the
  venue no longer lists, where a diffusion model is structurally wrong. They are excluded by name
  and counted in the output rather than dropped quietly.

### Result

| | |
|---|---|
| forecasts scored | **30,771** across **6,157** settled windows |
| period | 2026-07-22 → 2026-08-19 |
| cadences | 900 / 3600 / 14400 / 86400s |
| realized UP rate | 50.05% (at-inception prior 50.23%) |
| **AUC (holdout)** | **0.8305** |   (n = 9,232)
| **Brier (holdout)** | **0.1696** — 32.2% skill over always-0.5 |

Restricted to windows that actually traded — the ones Rivo could act on — it is better still:
**AUC 0.8870**.

Skill rises through each window's life, which is the physically expected shape and a useful
sanity check that the model is doing real work rather than fitting noise:

| phase | n | AUC | Brier |
|---|---|---|---|
| 10% | 6,157 | 0.6030 | 0.2492 |
| 25% | 6,155 | 0.6971 | 0.2254 |
| 50% | 6,155 | 0.8102 | 0.1814 |
| 75% | 6,153 | 0.8936 | 0.1349 |
| 90% | 6,151 | 0.9357 | 0.1016 |

```bash
npm run calibrate -- --days 30
npm run calibrate -- --days 30 --traded-only
```

---

## 2. No calibration correction survives a holdout

In-sample, the reliability curve looked systematically off — gaps of +0.06 to +0.10 through the
middle bins, over-confident on the DOWN side and near-exact on the UP side. The obvious move is to
fit a correction. We fitted three, then scored them on windows they had never seen (first 70% of
windows to fit, last 30% to score):

| correction | holdout Brier | skill vs always-0.5 |
|---|---|---|
| **none (model as-is)** | **0.1696** | **32.16%** |
| linear shrink (`k = 0.872`) | 0.1718 | 31.27% |
| Platt, global (`a = 0.656, b = 0.324`) | 0.1795 | 28.19% |
| Platt, per phase | 0.1805 | 27.82% |

**Every fitted correction loses to doing nothing.** The in-sample structure was this period's
noise, not a stable bias.

> A test written after the fact found that the Platt fit could diverge — plain Newton-Raphson
> overshoots badly on a model that is confidently wrong, and the IRLS weights then collapse to
> their floor and take the step to infinity (measured: `a` reaching 8.7e7 on synthetic data). It is
> fixed with a ridge and a backtracking line search. **It did not affect this table**: re-running
> the study with the corrected fit moved Platt's parameters by 0.0005 (`a` 0.6551 → 0.6556) and
> left every ordering intact, because real data with thousands of distinct probabilities is
> well-conditioned enough that Newton converged anyway. Recorded because the check mattered more
> than the outcome.

The `test` suite pins the scoring rules themselves against cases whose answers are known by
construction — AUC 1 for a perfect ranking, 0.5 for a constant one, Brier 0.25 for a coin flip —
so the numbers above rest on something more than having run them once.

This overturned a design assumption. The plan called for calibration-shrunk Kelly on the reasoning
that Kelly on an uncalibrated probability is a ruin machine — true in general, and not true here.
Rivo sizes from the raw model probability with the risk profile's fractional-Kelly multiplier as
the only haircut. The harness earned its place by **removing** a parameter that would otherwise
have been fitted to noise.

---

## 3. Taking liquidity does not work, at any threshold

### Method

Replay against **53,989 fills that actually executed**, never a synthetic book. A printed fill is
proof a counterparty existed at that price, for at least that size — which removes the need to
model depth that may never have been there. Rivo is only ever allowed to take the other side of a
trade that really happened.

### Result

P&L per unit staked, by edge band (rows = floor, columns = ceiling):

| floor \ ceil | 0.05 | 0.08 | 0.12 | 0.20 | 0.35 | 1.00 |
|---|---|---|---|---|---|---|
| **0.00** | −5.0% | −7.5% | −9.5% | −10.3% | −9.6% | −9.7% |
| **0.02** | −8.8% | −11.8% | −13.8% | −14.1% | −12.7% | −12.8% |
| **0.03** | −11.6% | −14.1% | −15.8% | −15.6% | −13.9% | −14.0% |
| **0.05** | | −16.4% | −17.8% | −17.0% | −14.6% | −14.7% |
| **0.08** | | | −19.4% | −17.3% | −13.8% | −14.0% |
| **0.12** | | | | −15.2% | −9.9% | −10.5% |

Every cell is negative, and **losses grow with claimed edge** — −28% per unit staked where the
model disagreed with the market by more than 0.40.

That shape is the diagnosis. Real edge gets *more* reliable as it grows; this gets less. Selecting
the leg that maximises `(model − price)` selects for the leg where the model's own error is most
positive — the winner's curse. `ec-oracle-follow` ships an `OF_MAX_DISAGREEMENT` ceiling for
exactly this reason and its README explains why; our first cut had a floor and no ceiling.

### What we ruled out first

A negative result is only worth believing if the cheaper explanations were eliminated:

| hypothesis | test | outcome |
|---|---|---|
| stale spot manufacturing fake edge | hit rate bucketed at 10-second lag resolution | **flat** — 0–10s loses 9.2%, 45–60s loses 9.2%. No gradient. |
| `fillPrice` inverted for one maker side | `quoteQuantity / quantity` vs `fillPrice` | matches exactly on both `BUY_YES` and `SELL_YES` rows |
| traded windows are a harder population | calibration restricted to traded windows | they score **better** — AUC 0.887 vs 0.816 |
| a few heavily-traded windows dominating | per-window vote vs per-fill vote | 46.0% vs 43.5% — not a weighting artefact |

One framing error of our own is worth recording. We initially read a 20% hit rate as
"anti-predictive". It is not: buying a leg at 0.20 that is worth 0.30 *should* lose four times in
five and still profit. Return on stake is the metric; hit rate on binaries is close to meaningless
on its own.

```bash
npm run band     -- --days 30    # the sweep
npm run diagnose -- --days 30    # the elimination
```

---

## 4. The portfolio constraints demonstrably prevent ruin

Same forecasts, same order, different sizing. Starting capital 50.

| strategy | final | return | max DD | trades | hit % |
|---|---|---|---|---|---|
| **Rivo (Kelly + portfolio constraints)** | **34.60** | −30.8% | 51.9% | 1,200 | 46.5 |
| Kelly, no portfolio constraints | 0.00 | −100% | 36.8% | 50 | 20.0 |
| Full Kelly, no constraints | 0.00 | −100% | 36.0% | 50 | 20.0 |
| Equal weight (5% each) | 0.00 | −100% | 39.4% | 58 | 19.0 |
| Any positive edge (5% each) | 0.00 | −100% | 30.3% | 55 | 20.0 |
| All-in on any edge | 0.00 | −100% | 36.0% | 50 | 20.0 |

Every unconstrained rule is **bankrupt inside 60 trades**. The constrained one survives **1,200**
and retains **69% of capital on an edge that is genuinely negative** (−2.37% return on stake,
against −61% for unconstrained Kelly).

These figures improved materially once the allocator was fixed to treat Kelly and the position cap
as targets for the whole leg rather than allowances for one more order — see §6. Before that fix
the same comparison read 19.18 and 997 trades. Both versions tell the same story; the fixed one
tells it more clearly, and it is the code that ships.

This is the one claim a negative core does not undermine, and it is measured rather than argued.
The mechanism is visible in the live allocator too: on a venue whose top candidates are routinely
the same directional view at two tenors, unconstrained Kelly sizes each in isolation and takes the
same bet twice.

```bash
npm run backtest -- --days 30 --capital 50
```

---

## 5. Making is unproven — and this replay cannot settle it

Mint a complete set for 1 collateral, sell the Up at your ask and the Down at `1 − bid`, receive
`1 + spread`, hold nothing at settlement. Zero fees mean the spread is not handed back. That is a
structural edge rather than a forecasting one, and it is the natural response to §3.

The replay is negative — best case −0.82%, at a tight spread under a tight disagreement ceiling —
but **it is a lower bound, not an estimate**, for a specific and unavoidable reason:

Rivo can only be credited with a fill when its quote would have beaten the one that actually
printed. That conditions every recorded fill on the model sitting *below* the market, which is the
maker's own winner's curse and is precisely the adverse subset. The offsetting fills a real
two-sided maker would collect on the other leg are invisible here, because they are trades that
never happened. Only ~39% of volume paired even at the best setting, where a genuine two-sided
maker in a working book pairs most of its flow.

One signal does carry through: **the disagreement ceiling helps monotonically** (−0.82% at 0.05
versus −3.55% unbounded), the same result §3 produced from the opposite side of the book.

Settling this needs quotes actually resting on the venue. That is a testnet run, not a replay.

```bash
npm run maker -- --days 30
```

---

## 6. Live behaviour

The runtime has been verified end to end in dry mode against the live venue.

- **Settlement** — seeded four positions in already-settled windows, two winners and two losers.
  Winners paid 10.00 each, losers 0, cash reconciled exactly.
- **Restart recovery** — killed mid-run and restarted. Resumed at cycle 3 with 4 positions open
  and did *not* re-buy.
- **Budgets bind precisely** — a live pass filled to BTC delta **+2.500** against a ±2.50 budget
  and combined **+2.987** against ±3.00, then stopped.
- **Holding cash is a decision** — a pass taken 2026-08-19 21:44 UTC priced 16 legs and took none.
  Edges had compressed to +0.005…+0.036 and the only leg clearing the floor was inside the expiry
  headroom, where the venue can lock a market between the book snapshot and the send.

### Two bugs the runtime found in its own allocator

Both surfaced by running it, not by reading it. Recorded because the fixes are the interesting part.

**Positions accumulated in fragments.** The allocator sized each cycle's order against remaining
budget rather than a target for the whole leg, so a 20% per-position cap applied per *order* —
fifty cycles could stack many times that in one leg, each fragment having paid a spread to open.
It now answers the question it claims to (*"what portfolio should exist right now?"*): Kelly and
the position cap are targets for the leg, minus what is already held, with a minimum trade size so
it stops nibbling.

**The conviction stop re-fired forever.** It measured decline against `fairAtEntry`, which never
moved — so one 0.078 drop in the model halved the same position every cycle: 3.06 → 1.53 → 0.76 →
0.38, paying the spread each time. That is exactly the churn the hysteresis band exists to
prevent. Fixed with a per-leg cooldown and by re-baselining `fairAtEntry` after every action.

---

## Reproducing all of it

```bash
npm install
npm run calibrate -- --days 30                  # §1, §2
npm run calibrate -- --days 30 --traded-only     # §1
npm run band      -- --days 30                   # §3
npm run diagnose  -- --days 30                   # §3
npm run backtest  -- --days 30 --capital 50      # §4
npm run maker     -- --days 30                   # §5
npm run scan                                      # live pricing
npm run allocate  -- --capital 50 --profile balanced
```

Saved outputs from the runs quoted above are in [`evidence/`](evidence/).

Every figure quoted above comes from the saved artefacts in [`evidence/`](evidence/) —
`calibration.json` carries the holdout, the per-phase and the per-cadence breakdowns, so anything
in this document can be checked without re-running anything.

Numbers drift as the venue accumulates windows and as other participants' bots change the books;
across the runs behind this document the forecast count moved from 30,671 to 30,751 and the
holdout AUC from 0.8302 to 0.8308. The methods do not drift, and neither does the direction of any
conclusion here.
