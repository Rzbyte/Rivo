# Demo script

A 3-minute recording, shot by shot. Everything here is real — no mockups, no
sped-up footage, no numbers typed into a slide. If a command is in this file it
runs, and the figure it prints is the figure to say out loud.

The order is chosen to answer, in sequence, the three questions a judge is
actually holding: *what is this?*, *does it work?*, and *would I trust it with a
key?* Most submissions answer the first and stop.

---

## Before you record

```bash
npm ci
npm run build:public
npm run link:kit && npm run check:kit    # live path only
npm run agent -- status                  # should show a funded agent wallet
npm run doctor                           # every line green
```

Have these open, in this order, so no shot needs a page load:

1. `https://rzbyte.github.io/Rivo/` — the public page, on **#/app** with a demo portfolio already running
2. A terminal, font large enough to read at 720p (18pt+), window ~100 columns
3. `docs/evidence/live-canary.json` in an editor, folded to the `stages` block
4. The explorer on the agent wallet's address

Record at 1080p. Speak over your own terminal; do not narrate a slide.

---

## 0:00–0:20 · The problem, stated once

**On screen:** the public page, term-structure panel — eight bars, BTC and ETH at
four tenors, model against book price.

> "DreamDEX runs eight Event Contract windows at once: two assets, four
> horizons. They are not eight independent bets. When the model disagrees with
> the book, it disagrees on all of them at the same time, in the same direction.
>
> A signal bot takes the biggest one and max-bets it. Then it takes the same bet
> three more times without noticing."

**Why this shot first:** it makes the portfolio layer necessary before anything
is claimed for it. Skip it and everything after sounds like a feature list.

---

## 0:20–0:45 · It refuses a trade it could take

**On screen:** terminal.

```bash
npm run allocate -- --capital 50 --profile balanced
```

Let it print. Then point at one skipped leg with positive edge:

> "This leg has real positive edge and real depth available. It is skipped
> anyway — and the reason is named, in collateral you can check: BTC exposure is
> already at budget from a better-scoring leg.
>
> Every rejection prints the constraint that caused it. Not a score, not a
> confidence — the limit that bound."

If the venue happens to be quiet and nothing qualifies, that is a *better* shot,
not a worse one: it prints `0 of 16 legs tradeable` with a reason per leg. Say
"holding cash is a decision it makes and explains."

---

## 0:45–1:15 · It ran for a day and stopped itself

**On screen:** `docs/evidence/live-canary.json`, then the explorer.

```bash
npm run proof -- --data-dir ./data-canary --address <the canary wallet>
```

> "This is not a dry run. 1,005 cycles on Somnia testnet. 208 positions opened,
> 68 settled, ten transactions confirmed by reading their receipts back from the
> chain rather than from our own logs.
>
> And look at the RISK CHECK line. Nobody stopped this. It traded until its own
> drawdown breaker hit 35%, then halted new entries and let the open positions
> settle out — instead of dumping them into a thin bid and paying the spread on
> top of the loss.
>
> Realised P&L was minus 25 on 20 of capital. The breaker is the part that
> worked."

**Do not apologise for the loss here.** The next beat earns it.

---

## 1:15–1:45 · The honest result

**On screen:** the evidence page, holdout panel.

> "The forecasting model works: AUC 0.83, Brier 0.17 over 30,771 held-out
> forecasts — 32% skill against always saying fifty-fifty.
>
> Trading on it by taking liquidity does not. Replayed against 53,989 fills that
> actually executed, every edge band is negative and the losses grow with the
> claimed edge. That is the winner's curse, measured: picking the leg that
> maximises model-minus-price picks the leg where the model is most wrong.
>
> We published that. It is in the README, above the fold."

Then the sizer table:

> "So what is the portfolio layer worth on an edge that is genuinely negative?
> Every unconstrained rule is bankrupt inside 60 trades. Rivo survives 1,200 and
> keeps 69% of the capital. The constraints are not decoration."

---

## 1:45–2:20 · Whose key, and what it can lose

**On screen:** terminal, then the explorer on the agent wallet.

```bash
npm run probe:operator
```

> "An unattended bot has to hold a hot key. The fix for that is on-chain
> scoping — grant a key permission to trade and nothing else. The spot venue has
> it. So we asked whether Event Contracts do, and asked the chain instead of the
> SDK.
>
> The entrypoints are there. `placeBinaryOrderFor`, `cancelOrderFor`, both in
> the deployed bytecode. And both revert with the same error, from every caller
> we tried, including the owner acting for itself — while every parameter
> mistake returns a different one. The feature is compiled in and switched off."

```bash
npm run agent -- status
```

> "So we bounded the loss instead of the permission. This is the wallet Rivo
> signs with. It holds 25 tUSDC and nothing else — no other assets, no allowance
> against my wallet. If this machine is taken, that is the number that is gone,
> and one command sweeps it back.
>
> That does not make a hot key safe. It makes the loss a number I chose. On this
> venue that is the strongest honest claim available, and we say so in the
> product rather than in a footnote."

**This is the beat that separates the submission.** Do not rush it.

---

## 2:20–2:45 · Anyone can run it

**On screen:** the public page on a browser with no wallet extension, then
compose.

> "No wallet, no install, nothing to sign — the pricing engine runs in the tab
> against the same public indexers, and it is the same code the runtime trades
> on, not a copy.
>
> And for the real thing: one command. The key stays on your machine, state
> survives a restart, and it comes up in dry run — because trading is something
> you opt into, never something an image decides for you."

```bash
docker compose up -d
```

---

## 2:45–3:00 · What we are handing back

> "Fourteen findings from building against the SDK, each reproducible. The
> biggest one is that switching on two entrypoints that already exist would give
> every Event Contract bot a non-custodial path — which is the difference
> between a product and a script.
>
> 230 tests, CI that builds and runs the container, and every negative result we
> found published next to the positive ones."

---

## Things not to do

- **Do not speed up terminal footage.** A judge can tell, and the whole pitch is
  that the numbers are real.
- **Do not lead with the model.** It is why the product works; it is not the
  product, and the model is the most commoditised part of this space.
- **Do not bury the negative result at the end** as a caveat. Said early and
  plainly it reads as rigour; said last it reads as an admission.
- **Do not demo Autopilot starting from the browser** unless the backend is up
  and healthy on camera. A disabled button with a clear reason is a better shot
  than a spinner.
