# Demo script — three minutes

**The line the whole thing builds to:** *Understand the market. Validate the agent. Prove it on DreamDEX.*

Record against the deployed product. Nothing in the first two minutes needs a wallet, and that is
worth showing rather than saying — a judge watching a product that works before it asks for anything
has already learned the most important thing about it.

## Before you record

```bash
npm run calibration -- --days 90 --store   # so /calibration has a report to serve
npm run shadow -- --interval 90            # leave running; the shadow feed needs decisions
```

Check the four surfaces answer: `/markets`, `/calibration`, `/agents`, `/proof`.

**There is no Privy modal.** These wallets run in a TEE where the grant is provisioned headlessly, so
the Rivo screen *is* the consent. Do not record a pause waiting for a window that never opens — an
earlier version of this script told you to, and it is the easiest way to make a working product look
broken.

---

## 0:00–0:20 · The question

**On screen:** `/markets`, on a live contract with a real price.

> "DreamDEX says this event is 67%. Every prediction market shows you a number like that. None of
> them tells you whether 67% is actually 67%."

Let the countdown tick on camera. It is a live venue and it should look like one.

## 0:20–0:50 · The answer

**On screen:** `/calibration`.

> "So we measured it. Seven hundred and thirty-seven settled Event Contracts, one observation each.
> When DreamDEX quoted 65 to 70 per cent, the thing happened 64.5 per cent of the time — that price
> is honest. When it quoted 50 to 55, it happened 39 per cent of the time. That one is not."

Point at the **windows** column.

> "Every row carries its sample size, and buckets under thirty windows are greyed out and make no
> claim. The intervals come from resampling settled windows, not snapshots — forty fills inside one
> contract are forty copies of one coin flip."

> "Overall: Brier 0.165 against 0.250 for just quoting the base rate. DreamDEX prices carry real
> information. That is a finding, and it is measured rather than asserted."

## 0:50–1:15 · The second problem

**On screen:** `/agents`.

> "Here is what Rivo found out about itself. Its own model separates up from down well — AUC 0.8158,
> measured on held-out forecasts."

Scroll to the economics.

> "And trading it lost money. Minus 6.49 per cent return on stake, out of sample, walk-forward. Look
> at the edge buckets: claiming more edge did not earn more. There is no monotone relationship."

> **"A model can predict well and still trade badly."**

Point at **REJECTED**.

> "So Rivo's own agent is rejected for real capital, and the execution path enforces that — it is a
> state the gate reads, not a badge on a page."

## 1:15–1:40 · Shadow

**On screen:** the Live Shadow table on the same page.

> "Before anything trades, it runs here: deciding against live DreamDEX contracts at real prices,
> sending nothing."

Point at a `HYPOTHETICAL` row, then at a `SETTLED` one.

> "When the contract settles, the same outcome that would close a real position resolves the shadow
> record. The agent said 0.38 against the market's 0.335, and here is what actually happened."

## 1:40–2:10 · The real transaction

**On screen:** `/proof`.

> "And when an agent does get to trade — testnet only, chosen explicitly, because this one is
> rejected — it is real. Real DreamDEX order, real Somnia transaction."

Open a hash in the explorer. On camera.

> "Attempts, submitted, confirmed — counted separately and never merged. An attempt is not a
> transaction; a shadow decision is not a trade."

## 2:10–2:35 · The loop

**On screen:** the loop panel at the bottom of `/proof`.

> "Market, prediction, decision, outcome, evidence. Every contract that settles joins the calibration
> dataset and the agent's record — so the next answer rests on one more settled fact than the last."

## 2:35–3:00 · What it is for

> "Rivo turns DreamDEX Event Contract probabilities into measurable intelligence, tests whether an
> agent actually has economic edge rather than merely accuracy, and lets a builder prove it through
> shadow testing and verifiable testnet execution."

> **"Understand the market. Validate the agent. Prove it on DreamDEX."**

---

## What not to say

- Do not say Rivo is profitable. It is not, and the evidence saying so is on the page.
- Do not say calibration predicts anything. It describes contracts that have already settled.
- Do not call a market–model gap a mispricing. The spread may exceed it and the depth may not be
  there. Market assessments are descriptive, never BUY or SELL.
- Do not say "production-ready". Say what has run, for how long, and against what.
- Do not say Rivo's limits are enforced on-chain. They are enforced in software; the venue offers no
  way to scope what a signer may do with Event Contracts, and we do not claim otherwise.
