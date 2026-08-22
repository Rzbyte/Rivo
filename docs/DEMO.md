# Demo script

A 3-minute recording, shot by shot. Everything here is real — no mockups, no sped-up footage, no
numbers typed into a slide. If a command is in this file it runs, and the figure it prints is the
figure to say out loud.

The order answers, in sequence, the three questions a judge is actually holding: *what is this?*,
*does it work?*, and *would I trust it with money?* Most submissions answer the first and stop.

**The single sentence this demo has to earn:**

> A user signs in, funds an isolated Rivo Portfolio, sets a risk budget, enables Autopilot once,
> closes the browser — and Rivo keeps managing their DreamDEX Event Contract portfolio server-side,
> with every decision, execution and reconciliation durably recorded.

---

## Before you record

```bash
npm ci
npm run privy:check                      # every line ok, or you cannot shoot 0:20–1:05
npx tsx scripts/dev-postgres.ts start    # or point DATABASE_URL at a managed database
npm run db:migrate
npm run link:kit && npm run check:kit    # the live path, including the signer binding
npm run worker                           # leave it running in its own window
npm run dev:web                          # the product, on :3001
```

Have these open, in this order, so no shot needs a page load:

1. `http://localhost:3001` — the landing page, signed out
2. The product at `/app`, in a second profile, already signed in and funded
3. A terminal running the worker, font large enough to read at 720p (18pt+)
4. A second terminal for `npm run proof`
5. The Somnia explorer on the Rivo Portfolio's address

Record at 1080p. Speak over your own screen; do not narrate a slide.

**If you have no Privy credentials**, shoot the alternative path in the box at the bottom. It
demonstrates the same engine and says plainly which two shots are missing. Faking them is worse than
not having them.

---

## 0:00–0:20 · The problem, stated once

**On screen:** the landing page, the "Three positive edges. One position." panel.

> "DreamDEX runs eight Event Contract windows at once — BTC and ETH, at fifteen minutes, one hour,
> four hours, a day. They are not eight independent bets. BTC UP at 15 minutes and BTC UP at 4 hours
> are the same directional view with different clocks, and a bot that scores each market on its own
> will buy that view three times and call it diversification."

Point at the three rows: two refused, one taken.

> "That is the problem Rivo exists for. Everything after this is that idea, working."

---

## 0:20–0:45 · Sign in, and the Rivo Portfolio

**On screen:** the landing page → "Continue with email".

Sign in with an email address. Do not skip the code entry — the point is that there is no wallet
software involved.

> "No extension, no seed phrase, no private key. Rivo opens a **Rivo Portfolio** — a trading account
> held by Privy, separate from any wallet you already have."

**On screen:** the funding step, address visible, balances reading.

> "Separate on purpose. Whatever you put in here is the entire budget Rivo can ever act on. Your
> main wallet is identity and a funding source, and Rivo cannot touch it."

Say the balance out loud as it appears. It is a live read.

---

## 0:45–1:05 · Configure, and enable Autopilot once

**On screen:** the configure step. Set capital. Pick **Balanced**. Point at the panel underneath.

> "Three profiles do the work. What they actually change is shown in collateral, not in fractions —
> at most this much in one position, at most this much exposure to BTC per one percent move."

Click **Enable Autopilot**. Let Privy's own consent prompt appear on camera.

> "One prompt, from Privy, not from us. It grants Rivo the right to *ask* Privy to sign for this
> account. Rivo never holds the key — a full compromise of our servers gets the ability to place
> Event Contract orders from a funded portfolio until its owner revokes, and nothing else."

**Then close the tab.** On camera. This is the shot the whole submission rests on.

---

## 1:05–1:40 · The portfolio-level decision

**On screen:** the worker terminal, mid-cycle.

> "Nothing is open now. This is a worker on a different machine, and it is the thing that trades."

Let a cycle land. Then reopen the dashboard.

**On screen:** the Decisions tab, one cycle expanded.

> "Sixteen legs considered in this pass. One entered. Fifteen refused — and every refusal says which
> constraint refused it."

Scroll to a cycle with the correlated banner:

> "*Three BTC windows had positive edge. Rivo took the 1-hour and refused the others — same
> directional view, and the portfolio only has one BTC budget.*"

Point at the exposure bar under a refused leg: `+0.00 → unchanged, of ±2.50 per 1% move, 100% used`.

> "That is not a label. It is the arithmetic the decision was made against, recorded at the moment
> it was made."

---

## 1:40–2:05 · A real ENTER, REDUCE, and SKIP

**On screen:** the same tab, scrolling back through cycles.

Find a **REDUCE**. This is the most valuable shot in the demo, because nothing about it is
decorative:

> "*REDUCE — the model fell 0.094 since entry, 0.512 down to 0.418. Halving rather than exiting,
> because the bid at 0.389 still under-pays the model.*"

> "It did not just enter and wait. It re-priced a position it already held, decided the conviction
> had weakened but not inverted, and cut it in half. Then it named the bid it declined and why."

Then the exposure panel at the top:

> "BTC and ETH, signed, against their budgets. An UP at one tenor and a DOWN at another net off here
> exactly as they do in reality."

---

## 2:05–2:25 · The evidence

**On screen:** the second terminal.

```bash
npm run proof -- --portfolio <id>
```

> "Four numbers, and the whole point is that they are four."

Read them off the screen:

```
decisions            5,324   every leg considered
position lots           32   8 open, 24 closed
execution attempts     186   recorded before anything was signed
with a tx hash           N   handed to the chain
confirmed on-chain       N   receipts read back and verified here
```

> "Decisions are not positions. Positions are not transactions. Attempts are not confirmations. An
> earlier version of this project could show two hundred positions and ten transaction hashes with
> no way to tell which number was the lie — so the ledger is append-only, the database refuses to
> rewrite it, and each of those hashes is checked against the chain by this command."

Click one hash through to the explorer. Then scroll to the stage list:

> "And the stages it could *not* evidence are printed too."

---

## 2:25–2:45 · Still running, nobody watching

**On screen:** the worker terminal, and the browser still closed.

> "The browser has been shut for four minutes. Cycles are still landing — settle, claim, reconcile,
> allocate. The portfolio is in PostgreSQL, the lease is in PostgreSQL, and if this worker dies
> another one picks the portfolio up when the lease expires. Two of them can never hold it at once."

Kill the worker on camera. Start it again.

> "It reconciles against the chain before it does anything else, because a process that comes back
> believing it holds nothing is a process that buys everything twice."

---

## 2:45–3:00 · What it is for

> "DreamDEX settles roughly two hundred and thirty Event Contract windows a day. Nobody is going to
> watch that by hand. Rivo is the layer that lets a person participate in all of it continuously,
> inside a risk budget they set once — and that refuses the trades that would end the experiment
> early, naming the limit every time."

Last shot: the dashboard, Autopilot green, worker heartbeat ticking.

---

## Without Privy credentials

Two shots — the sign-in and the consent prompt — need a configured Privy app. Everything else is
reproducible from a checkout, and the honest version of this demo says which two are missing rather
than staging them.

```bash
npx tsx scripts/dev-postgres.ts start
export DATABASE_URL=postgres://rivo@127.0.0.1:55432/rivo
npm run db:migrate
npm run seed:demo                      # a portfolio, Shadow Mode, enforced
npm run worker                         # against the live venue
export RIVO_DEMO_PORTFOLIO_ID=<id>     # publishes /demo read-only
npm run dev:web
```

`/demo` is the dashboard on a real portfolio with no sign-in — the same decisions, exposure, ledger
and reconciliation, with the controls absent rather than disabled. Then say, on camera:

> "This portfolio is in Shadow Mode: it decides, records and reports, and sends nothing, because
> this deployment has no signing credentials configured. The proof output says so too — it reports
> zero transaction hashes and names Shadow Mode as the reason rather than looking like a failure to
> execute."

That is a weaker demo than the full one and a much stronger claim than a staged prompt.

---

## What not to say

- Do not say "production-ready". Say what has run, for how long, and against what.
- Do not say Rivo's limits are enforced on-chain. They are enforced in software; the venue's
  operator entrypoint is compiled in and disabled, and `npm run probe:operator` is the proof.
- Do not imply profit. The backtest's headline result is that naive taker strategies lose money, and
  saying so first is the reason anything else here is believable.
- Do not show a number this repository cannot reproduce.
