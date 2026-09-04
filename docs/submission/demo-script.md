# Rivo — three-minute demo script

**Recorded against production:** https://rivo-autopilot.vercel.app

Spoken content runs ~2:40, leaving room for navigation. Numbers below were the live production
values at the time of writing; **re-read them from the screen when you record** — the worker keeps
computing and they will have moved. `npm run release` prints the current set.

Have these tabs open before you start, in order:

```
1  /markets      2  /calibration      3  /agents      4  /proof      5  /evidence
```

---

## Scene 1 — The market · 0:00–0:20

**Screen:** `/markets`, one live BTC or ETH card.

> "This is a live DreamDEX Event Contract. BTC, fifteen minutes, and the venue says the probability
> is this number.
>
> That number is a price. Nothing on the venue tells you whether it is *calibrated* — whether
> contracts quoted at sixty-seven percent actually settle true about sixty-seven percent of the time."

Point at one card. Do not scroll the list.

---

## Scene 2 — Calibration · 0:20–0:50

**Screen:** the same card, then `/calibration`.

Show the card's own provenance line first — it is the whole argument in one row:

```
Cohort BTC 15m
Price band 20–25% · 41 settled windows · 95% CI 4.9%–26.8%
Measured 2026-07-22 → 2026-08-24
```

*(That is the shape of the row, with the values it carried on 2026-08-24. Every field moves — the
window count grows and the end date advances — so read the row on the screen and say what it says.
Rehearsed 2026-08-24: a BTC UP 15m card at 0.339 answered from* `all assets, 15m` *— 39 windows,
CI 23.1%–53.8%, fallback shown. Pick a card whose own cohort answered if one is available: a
`fellBack` card is honest but takes a sentence to explain.)*

> "Rivo answers it against contracts that have already settled. This band was quoted at twenty-two
> percent on average and settled true fourteen-point-six percent of the time, over forty-one
> independent windows, with the interval shown.
>
> Every number carries the cohort it came from, the sample size, and the dates. When the specific
> cohort is too thin, it widens and says so."

Then `/calibration` for the headline:

```
2,179 settled windows · Brier 0.1821 against 0.2497 for the base rate · 27.1% skill
```

*(Re-measured 2026-09-04. The worker recomputes every few hours and the window count only grows —
it was 843 windows and 35.8% skill on 2026-08-24. Read the live figure off the screen; say the
number that is on it.)*

> "Across the whole venue: twenty-seven percent better than always quoting the base rate. DreamDEX
> prices carry real information — and parts of the book are systematically off."

**Do not** open the methodology disclosure unless asked.

---

## Scene 3 — Agent validation · 0:50–1:20

**Screen:** `/agents`.

> "Now the second question. Rivo's own model is the first case study."

Point at the two stats side by side:

```
Forecast quality    AUC 0.8158
Economic quality    +2.80% return on stake, out of sample · t = 0.79
Verdict             REJECTED
```

> "It separates up from down well. Trading it — crossing the spread to act on it — returns under
> three percent across five walk-forward folds, with a t-statistic of nought point seven nine. That
> is not a profit. It is a number that cannot be told apart from zero, and removing the best of the
> five folds takes it negative.
>
> **A model can predict well and still trade badly.** Being right about direction is not the same as
> being right by more than the spread you cross. Rivo's gate reads the second number, not the first,
> and it refuses its own model."

*(Worth saying if a judge asks, and worth not hiding: this number was −6.49% when the study was
written on 737 settled windows. On 2,179 it is +2.80%. The verdict did not move, because the gate
tests significance and breadth rather than the sign — a gate that meant "the backtest is negative"
would have opened here.)*

Open **"Why the gate refused it"** for two seconds. Close it.

---

## Scene 4 — Live Shadow · 1:20–1:50

**Screen:** stay on `/agents`, scroll to Live Shadow.

> "Before an agent can spend anything, it runs in Shadow — deciding against live DreamDEX contracts,
> in a background worker, sending nothing."

Point at the heartbeat:

```
Runtime RUNNING · 1 worker · last decision seconds ago
```

> "That is a real worker, not this browser. Six hundred thousand decisions, and nearly all of them
> already resolved against the venue's own settlement."

*(Read from production 2026-09-05: 613,397 decisions, 595,057 settled, 1 live worker. It was 8,132
on 2026-08-24 — the ledger has grown 75× in twelve days, so say the order of magnitude on the screen
rather than the one written here.)*

Open **"What the pre-execution pipeline decided"**:

> "And this is the part that makes Shadow worth anything. It runs the *same* pre-execution pipeline
> as real execution — market eligibility, the strategy gate, risk ceilings, and DreamDEX's own lot
> size. Same function, same inputs. The only difference is that no signer is reachable from this
> path.
>
> Every row here is HYPOTHETICAL. No transaction was sent for any of them."

**Then scroll up to "Try your agent now" and paste an endpoint, live on camera.**

> "And you can do this yourself right now, with no account. Rivo takes the deepest live window, asks
> your endpoint, and runs the answer through that same pipeline. Nothing stored, nothing signed."

Even a URL that answers nothing useful makes the point — the verdict comes back naming the stage that
refused it and why. If no leg has an offer, the endpoint says so; do not read that as a failure on
camera, it is the product being correct about a thin book.

---

## Scene 5 — Proof on DreamDEX · 1:50–2:25

**Screen:** `/proof`.

> "And when a strategy is explicitly deployed to Experimental Testnet, the same pipeline ends at a
> real signer."

Walk the timeline once, top to bottom, without stopping:

```
AGENT DECISION      PASSED
RISK CHECK          PASSED
VENUE NORMALISATION NORMALISED   10.94 shares — a size DreamDEX accepts
ORDER SUBMITTED     SUBMITTED
SOMNIA CONFIRMED    CONFIRMED    block 469486171
LEDGER PERSISTED    RECORDED
RECONCILED          RECONCILED
ORACLE ANSWERED     RESOLVED     question #44395, 3 members threshold 2, settled at 77,730.00
SETTLEMENT          SETTLED      UP — this leg paid out
```

The oracle line is the one to pause on for three seconds:

> "And this is where the settlement came from. Not our database — the Prophecy Oracle question this
> window resolves on, the committee that answered it, and their own transaction hash. That is a
> second on-chain record, independent of anything we wrote."

> "A real Somnia transaction, and the receipt was read back from the chain rather than assumed from
> the send — that is why there is a block number.
>
> And the last line is the loop closing. That contract has since expired, the venue finalised it UP,
> and this leg paid out. Settlement is read from the venue rather than from our own table — which
> matters, because this deployment is stopped and its own record still says open. The page shows both
> and says which one is the authority."

Open the explorer link for **three seconds only**. Do not narrate the explorer.

---

## Scene 6 — The loop · 2:25–2:50

**Screen:** `/proof`, the loop diagram. Or `/evidence`.

```
market → prediction → decision → outcome → evidence
```

> "That settlement does not just close a position. It joins the calibration dataset and the agent's
> record — so the next answer rests on one more settled fact than the last one did."

If time allows, one line on `/evidence`:

> "Five studies sit behind all of this, and two of them came back negative. Market making lost to
> adverse selection. The cross-tenor arbitrage is real and two shares deep. Both are published with
> the arithmetic attached."

**Close:**

> "Every settled Event Contract creates new evidence, and every agent has to prove itself before
> deployment.
>
> Understand the market. Validate the agent. Prove it on DreamDEX."

---

## What not to say

- Do not lead with PostgreSQL, Privy, migrations, test counts or worker internals. They are the
  reason it works; they are not the product.
- Do not claim profitability. Rivo's own strategy is REJECTED and that is the point being made.
- Do not call anything "AI-powered". The model is a diffusion-based forecaster with a published AUC.
- Do not linger on the block explorer.

## Rehearsed end to end · 2026-08-24, figures re-checked 2026-09-05

All six scenes answered on production when this was rehearsed on 2026-08-24, and every page and API
still answered 200 on 2026-09-05. `RIVO_DEMO_PORTFOLIO_ID` is set, so `/proof` publishes run
`5b35e672`.

Two rows moved since the rehearsal and are corrected below — calibration and the Shadow ledger. The
rest are as rehearsed: scenes 1, 5 and 6 read off live cards and a stored run, so re-read them from
the screen on the day rather than trusting this table.

| Scene | What it showed |
|---|---|
| 1 · Market | BTC DOWN 15m @ 0.043 · `WELL CALIBRATED` · cohort **BTC 15m**, band 0–5%, 30 windows, CI 0.0–10.0%, no fallback |
| 2 · Calibration | 843 windows · Brier 0.1604 vs 0.2497 · **35.8% skill** — now **2,179 windows · 0.1821 vs 0.2497 · 27.1% skill** (2026-09-04) |
| 3 · Agents | Rivo V1 · AUC **0.8158** · ROS **−6.49%** · `REJECTED` · 5 folds — re-measured 2026-09-04 on 2,179 windows: ROS **+2.80%**, t **0.79**, still `REJECTED` |
| 4 · Shadow | RUNNING · 1 worker · 8,399 decisions · 5,807 settled · pipeline 472 SKIP / 58 EXECUTE — now **613,397 decisions · 595,057 settled** (2026-09-05) |
| 5 · Proof | run `5b35e672` · **16 confirmed** · 144 attempts · 38 failed · 6 open / 86 closed lots · **shadow 0** |
| 6 · Evidence | onChain 16 · ledgerRows 106 · CONFIRMED block 469486171 · **settlement SETTLED, UP, paid out** |

Two things worth pointing at if a judge is paying attention:

- **Scene 1 answered from its own cohort.** `fellBack: false` means BTC 15m had enough settled windows
  on its own — no widening needed, so the number is about this market rather than about a wider set.
- **Scene 5 shows `shadow 0` for the run.** That is correct and it is the evidence-scoping working:
  this is an execution deployment and it recorded no shadow decisions. The agent's 396 unscoped and
  8,399 total sit in their own labelled block and are never added in.

## If something is not answering

| Symptom | Say | Fallback |
|---|---|---|
| `/proof` shows an empty state | nothing — skip to `/evidence` | `RIVO_DEMO_PORTFOLIO_ID` has been unset; `/evidence` carries the same order with no database at all |
| Calibration shows a stale banner | "this is the stored snapshot; the live figure is larger" | it is labelled, so the label is the answer |
| A market card shows INSUFFICIENT SAMPLE | "and that is the correct answer for a thin cohort" | pick another card |
