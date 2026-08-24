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

> "Rivo answers it against contracts that have already settled. This band was quoted at twenty-two
> percent on average and settled true fourteen-point-six percent of the time, over forty-one
> independent windows, with the interval shown.
>
> Every number carries the cohort it came from, the sample size, and the dates. When the specific
> cohort is too thin, it widens and says so."

Then `/calibration` for the headline:

```
834 settled windows · Brier 0.1614 against 0.2497 for the base rate · 35.4% skill
```

> "Across the whole venue: thirty-five percent better than always quoting the base rate. DreamDEX
> prices carry real information — and parts of the book are systematically off."

**Do not** open the methodology disclosure unless asked.

---

## Scene 3 — Agent validation · 0:50–1:20

**Screen:** `/agents`.

> "Now the second question. Rivo's own model is the first case study."

Point at the two stats side by side:

```
Forecast quality    AUC 0.8158
Economic quality    −6.49% return on stake, out of sample
Verdict             REJECTED
```

> "It separates up from down well. Trading it — crossing the spread to act on it — lost money out of
> sample across five walk-forward folds.
>
> **A model can predict well and still trade badly.** Being right about direction is not the same as
> being right by more than the spread you cross. Rivo's gate reads the second number, not the first,
> and it refuses its own model."

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

> "That is a real worker, not this browser. Eight thousand decisions, five thousand of them already
> resolved against the venue's own settlement."

Open **"What the pre-execution pipeline decided"**:

> "And this is the part that makes Shadow worth anything. It runs the *same* pre-execution pipeline
> as real execution — market eligibility, the strategy gate, risk ceilings, and DreamDEX's own lot
> size. Same function, same inputs. The only difference is that no signer is reachable from this
> path.
>
> Every row here is HYPOTHETICAL. No transaction was sent for any of them."

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
SETTLEMENT          PENDING
```

> "A real Somnia transaction, and the receipt was read back from the chain rather than assumed from
> the send — that is why there is a block number.
>
> Settlement says PENDING because that contract is still open. It will say SETTLED when it closes,
> and not before."

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

## If something is not answering

| Symptom | Say | Fallback |
|---|---|---|
| `/proof` shows an empty state | nothing — skip to `/evidence` | `docs/evidence/final-proof.json` has the same run |
| Calibration shows a stale banner | "this is the stored snapshot; the live figure is larger" | it is labelled, so the label is the answer |
| A market card shows INSUFFICIENT SAMPLE | "and that is the correct answer for a thin cohort" | pick another card |
