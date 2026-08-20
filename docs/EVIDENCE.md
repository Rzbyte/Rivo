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

## 5. Cross-tenor coherence: real, and too small to trade

DreamDEX lists a rolling term structure — `{BTC, ETH} × {15m, 1h, 4h, 1d}` — on two underlyings.
That raises an obvious question: are the probabilities across tenors mutually consistent, and if not,
is the inconsistency tradeable *without* a directional view? That would matter, because §3 shows the
directional view is what loses money.

### The derivation, before the data

Window *i* settles 1 if `S(T_i) ≥ R_i`, where `R_i` is that window's own resolved opening price.
Different tenors compare against different levels, which kills the relation people reach for first:

> `P(1h UP) ≥ P(15m UP)` — **not valid.** Neither event contains the other, and the references move
> independently. Any monotonicity assumed across tenors is unfounded.

What *is* valid needs two windows on the **same asset sharing the same expiry instant**, with
references `R_lo < R_hi`. Then `{S(T) ≥ R_hi} ⊂ {S(T) ≥ R_lo}`, so

```
p_lo ≥ p_hi
```

and this is **model-free** — set inclusion, no volatility or drift assumption. As a trade it is
direction-neutral by construction. Buy lo-UP and hi-DOWN:

| terminal price | lo-UP | hi-DOWN | total |
|---|---|---|---|
| `≥ R_hi` | 1 | 0 | **1** |
| `[R_lo, R_hi)` | 1 | 1 | **2** |
| `< R_lo` | 0 | 1 | **1** |

Minimum payoff 1 in every state, so the package must cost ≥ 1. Its cost is
`ask(lo-UP) + ask(hi-DOWN) = 1 + (p_lo − p_hi)`, below 1 exactly when the bound breaks.

Two things deliberately **not** claimed. *Intra-market arbitrage* is structurally impossible: Up and
Down trade on one book where Down is 1 − Up, so `ask(UP) + ask(DOWN) = 1 + (ask − bid) ≥ 1` always.
And a book disagreeing with our *fair value* is a **model-consistency** violation, not arbitrage —
trading it is the directional bet §3 already measured as unprofitable. Only the bound above was ever
direction-neutral, so only it was tested.

### The result

| | |
|---|---|
| settled windows on listed cadences | 6,096 |
| same-asset same-expiry pairs | **1,834** |
| …where both legs ever traded | **83** |
| simultaneous observations (≤15s apart) | 23,431 |
| violations (`p_lo < p_hi`) | 719 — **3.07%** |
| …clearing the 0.024 round trip | 228 |
| **gross profit if every one taken** | **12.59 collateral over 30 days** |

The bound *is* violated, and the violations are real: the worst case was verified end to end — same
expiry instant (16:00:00 UTC), references $64,904.65 and $64,906.57, both settling UP, priced 0.727
and 0.865 twelve seconds apart. Two near-identical questions, fourteen cents apart.

**But it is not material.** 0.42/day at a ceiling that assumes we could have been the taker on both
legs of trades we merely observed, that taking them would not have moved the prices being measured,
and that fills 15 seconds apart are simultaneous — on a 15-minute window, 2% of its life.

Sensitivity to that last assumption, which is the one doing the most work:

| simultaneity | observations | violations | rate | clearing round trip |
|---|---|---|---|---|
| 5s | 8,281 | 238 | 2.87% | 61 |
| 15s | 23,431 | 719 | 3.07% | 228 |
| 30s | 45,979 | 1,479 | 3.22% | 552 |
| 300s | 430,511 | 20,609 | 4.79% | 13,648 |

The rate rises with tolerance, which is the signature of staleness rather than arbitrage — at 300s
most "violations" are just prices from different moments. That a residual ~2.9% survives genuine
5-second simultaneity is what makes the finding real rather than an artefact.

**The binding constraint is liquidity, not coherence.** Of 1,834 structural pairs, only **83** had
both legs trade at all. A relative-value trade needs two fills; this venue struggles to supply one.

Recorded as a property of the venue, not adopted as a strategy. It does not enter the Opportunity
Engine.

```bash
npm run coherence -- --days 30 --skew 15
```

---

## 6. Making was the open question. It is now measured, and negative

Mint a complete set for 1 collateral, sell the Up at your ask and the Down at `1 − bid`, receive
`1 + spread`, hold nothing at settlement. Zero fees mean the spread is not handed back. That is a
*structural* edge rather than a forecasting one, and it was the natural response to §3 — a maker
sits on the other side of both the spread and the winner's curse that the taker pays.

No replay could settle it. Crediting yourself with a fill means claiming a place in a queue that no
longer exists, and our own fill-replay could only ever credit fills where the model sat *below* the
market — the maker's own winner's curse, and precisely the adverse subset. So we rested real quotes
on testnet, centred on Rivo's own fair value rather than the book mid, and read back what the chain
said happened.

### Result

| | |
|---|---|
| orders posted | 16 |
| …that rested | **16** |
| …rejected | 0 |
| fills against our quotes | 5 (25 shares) |
| **paired shares** | **0.00** |
| captured spread | **−0.0067** per share |
| adverse selection | **−0.2537** per share |
| **net** | **−0.2604** per share |

The plumbing is sound — every order rested, none was rejected. Two things matter beyond the sign.

**Not one fill was paired.** Every quote that was lifted was lifted on one side only, so the "mint a
pair, sell both legs, keep the spread" story never happened once. Fills arrive one side at a time,
and the side that fills is the side that was about to be wrong.

**Captured spread is negative** despite quoting at fair ± 0.02. The fills landed at prices worse
than the fair value they were quoted against: the quote went stale and was picked off. Adverse
selection is showing up *inside* the capture term, not merely beside it.

Captured spread and adverse selection are reported apart on purpose. A maker profits only when the
first exceeds the second (Glosten & Milgrom, 1985), and one blended P&L number hides which side of
that inequality a run is on — the only thing worth knowing.

### What this does and does not establish

Five fills is a small sample, and settlement P&L on the 25 one-sided shares is not in these figures.
This is **first evidence, not a verdict.** But the direction matches theory, matches §3, and nothing
in it supports the claim that complete sets plus two-sided quoting is free spread. We will not make
that claim.

The run also exposed its own bug worth recording: **40 complete sets were minted to support 16
orders** — roughly 400 collateral spent acquiring inventory already held — because the indexer lags
the chain and a set minted moments earlier still reads as zero. Fixed by remembering what was minted
within a session.

One thing did work exactly as designed. The filled bids left the book net long, and the portfolio
delta budget then blocked further bidding. The risk engine stopped the maker accumulating exposure
it had not chosen — which is §4's claim, observed live rather than in replay.

```bash
npm run maker:live -- --capital 50 --cycles 60 --live --mint
npm run maker -- --days 30    # the replay, and its methodological limit
```

## 7. Live behaviour

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

### Reconciliation: the chain is the authority

Until this landed, `state.open` was the only record of a position — fine until the first time the
process dies between an order filling on-chain and that fill being written down. After that Rivo
believes it holds nothing and buys a second copy of everything it owns, with real money, in a
market where it may not be able to sell either copy back.

Holdings now come from the indexer's `OutcomeBalance` table, which needs no SDK and no key. Run
against a real venue account, the read finds what a state-file-only bot is blind to:

```
akun 0xe151139cfcb1a89bda2fef0733004a13a34e8acb
  ...4648:UP     2490.00
  ...4648:DOWN   2491.00
```

Equal holdings of both legs of one window — minted complete sets sitting unmerged, which is
precisely the trapped capital the RECOVER action exists to release. Other accounts show balances
on **Finalized** windows: unclaimed payouts, the "winnings are claimed, not received" hazard
visible in the wild.

The correction is deliberately asymmetric, and the asymmetry is the interesting part:

| situation | action | why |
|---|---|---|
| chain holds less, position < 2 min old | **kept** | the indexer lags the chain by seconds; deleting a just-filled position is the more expensive mistake |
| chain holds less, position older | dropped or scaled | lag cannot explain it any more |
| chain holds **more** | trusted immediately | extra shares cannot be lag |
| chain holds a leg Rivo has no record of | adopted, **flagged estimated** | nothing on-chain records what was paid; marked at fair value, which opens it at zero unrealised P&L rather than inventing a gain |
| the window is not live | reported, never adopted | a position with no expiry can never be managed or settled |

Dry runs skip reconciliation entirely — simulated positions have no on-chain counterpart, so
checking them against a chain that never heard of them would delete the portfolio. `address()`
returning null is that signal, and the dry runtime was verified to leave its positions alone.

State is also written the moment a fill is recorded rather than once per cycle, which mostly
prevents the gap that reconciliation exists to repair.

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
