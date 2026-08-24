# Calibration methodology

**The claim:** when DreamDEX quoted a probability, how often did the thing actually happen?

**The result, measured 2026-08-24:** DreamDEX prices carry real information. Brier **0.1604**
against **0.2497** for always quoting the base rate — a skill score of **35.8%** over **843 settled
windows**. The middle of the book is mostly honest (65–70% settled 64.5%); parts of it are not
(30–35% settled 41.7%, 50–55% settled 41.5%).

Reproduce: `npm run calibration -- --days 90`. Artefact:
[`evidence/calibration-report.json`](evidence/calibration-report.json).

---

## What one observation is

**One settled Event Contract**, sampled at a moment a trade actually happened.

That definition is doing three jobs, and each one is a way this could have been wrong.

### The probability is the executable one

A fill proves one direction was takeable at that price. It does not prove the other was: a resting
`SELL_YES` means somebody could buy UP; buying DOWN at `1 − p` needs a different resting order.

So the observation uses the **executable side only**. Calibrating on a midpoint measures a price
nobody could trade — a fine academic exercise and a misleading product.

### The probability is read before the outcome exists

Every field is taken at the decision instant. Bars are usable only once closed; fills only once they
have happened. A probability read after the fact is not a probability.

### Windows are the unit, not fills

**This is the one that makes or breaks the claim.** Every fill inside one settled window shares one
outcome. Forty rows from a window that resolved UP are forty copies of one coin flip, and counting
them as forty observations shrinks every interval by roughly √(rows/windows) — here about 8×.

So the published table is **one observation per settled window**, and the pick is deterministic in
the window id: independent of price, of position within the window, and of outcome. Keeping the
earliest fill would be simpler and wrong — the first trade in a window is the most anomalous
observation in this venue's history, so "keep the first" silently loads every bucket with it.

The correlated table is printed **beside** the real one, never instead of it. Hiding it is how a
calibration claim gets its confidence from correlation.

## Buckets

Five points wide, all the way across: `0–5, 5–10, … 95–100`.

Uniform rather than wider at the tails, because every bucket then reads as one checkable sentence —
"contracts priced 65 to 70 per cent settled true this often" — and a reader comparing two buckets is
comparing equal widths. Left-inclusive, right-exclusive, except the last, which is closed so a
probability of exactly 1 does not fall off the end.

## Uncertainty

95% intervals from a bootstrap that **resamples settled windows with replacement**, not rows — so
the uncertainty reflects the thing that actually varies. Deterministic seed, so a published report
reproduces exactly.

## Sample floor

A bucket with fewer than **30 settled windows** is marked `thin`, greyed in the UI, and shows no gap.
It stays visible: a bucket that vanishes reads as no data, and a bucket labelled thin reads as what
it is.

## Outcome mapping

From the venue's own finalised markets. `winningOutcome = 0` means UP paid. **Voided markets are
excluded entirely** — there is no outcome, and recording 0 would say the leg lost.

## What this does not claim

- **It is not a forecast.** It describes contracts that have already settled.
- **A gap is not a mispricing.** The spread may exceed it, the depth may not be there, and the
  comparable set may be thin. Market assessments are descriptive — never BUY or SELL.
- **35.8% skill is not profit.** Rivo's own strategy had good discrimination and lost money out of
  sample; see [ALPHA-RESEARCH.md](ALPHA-RESEARCH.md).
