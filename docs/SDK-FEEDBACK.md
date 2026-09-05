# SDK & documentation feedback

Findings from building [Rivo](../README.md) against `@somnia-chain/markets-sdk`,
`@dreamdex-bot-kit/ec-core`, and the Somnia Markets indexer, over roughly a week in
August 2026 on the DreamDEX testnet venue
(`0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c`).

**Written against markets-sdk 0.25.0. Every finding below was re-checked against 0.29.0 and the
current kit `main` on 2026-09-05** — see [§16](#16-what-the-re-check-changed) for the method and
the full scoreboard.

**Fifteen findings, of which thirteen stand and two we withdraw.** Every one is reproducible;
where a snippet is given it runs against public endpoints with no key. Ordered roughly by how much
time each cost us.

**We withdraw #8 and #11, and we rewrote #4.** All three were things we believed on 2026-08-22 and
cannot reproduce now. Two were our own measurement error rather than a venue defect, and saying so
is the whole point of publishing a list like this — a finding nobody re-checks is an anecdote.
The corrections are in place, in each section, with the numbers that produced them.

Three worth pulling out:

- **#4 — the SDK's own auto-approve block is one `switch` short of a named error, and everything
  downstream of it reports "for an unknown reason" — a verdict from viem, two layers below the
  decoder that could have named the fault.** Not the allowance itself: the SDK grants that
  correctly, and we were wrong to say otherwise.
- **#9 — the on-chain permission that would make non-custodial Event Contract bots possible is
  already deployed and switched off.** It has a name, and the name is `OnlyApprovedContracts()`.
  One flag away from changing what can be built here.
- **#1 — the oracle's `numericValue` carries no scale, and the scale differs by question type.**
  Still true, and still silent: both 1e2 and 1e4 rows were live in the same query on 2026-09-05.
  Every consumer has to price against that reference and there is no correct way to do it.

And one that arrived last, from building the product rather than the bot:

- **#15 — `createExchange` forwards only a private key, which makes the SDK's own signer
  flexibility invisible.** The SDK accepts any viem `Account`; the kit's entry point does not
  expose it. That gap is the difference between "users must paste private keys" and a wallet whose
  key never leaves a TEE, and it is five lines wide.

The kit is genuinely good — `ec-core` is 1,585 lines that absorb sixteen documented sharp edges,
and `docs/gotchas.md` and `docs/measuring-edge.md` are better than most production trading
codebases have. Two of the findings below are things the docs already warn about in prose but
that the SDK still lets you get wrong silently, which is the gap worth closing.

---

## 1. The oracle's `numericValue` scale is inconsistent and undeclared

**Severity: high — silent, and it destroys every downstream number.**

`OracleAnswer.numericValue` carries no decimals field, and the scale differs by question type:

| question | example `numericValue` | real value | scale |
|---|---|---|---|
| opening reference (`MarketReferenceLink`) | `6840343` | 68403.43 | **1e2** |
| settlement answer | `684321050` | 68432.1050 | **1e4** |

Reading an opening reference at 1e4 yields 684.03 against a spot of 68644.70 — a moneyness of
+460%, which produces a perfectly plausible-looking probability of exactly 1.000 on every market.
Nothing errors. Our first calibration run reported an AUC that looked fine until we noticed every
window was priced at the boundary.

**Reproduce:**

```bash
curl -s -X POST https://dev.smk.somnia.host/v1/graphql -H 'content-type: application/json' \
 -d '{"query":"{ OracleAnswer(limit:6, order_by:{resolvedAt:desc}){ oracleQuestionId numericValue outcomeLabel } }"}'
```

Compare `numericValue` against the price embedded in `outcomeLabel` (`">= 68237.4201"`).

**Workaround we shipped** (`src/core/indexer.ts::scaleReference`): choose the power of ten that
lands the reference nearest a known-good price for the same asset — spot at the window's open,
which *is* the reference by construction for up/down markets — and reject the row when nothing
lands within ~40%.

**Suggested fix:** add `decimals` (or `scale`) to `OracleAnswer`. Failing that, document the
per-question-type scale in the Event Contracts reference. This is the single highest-value change
on this list: every consumer of these markets has to price against that reference, and there is
currently no way to do it correctly without guessing.

---

## 2. `clobStatus` is not a live filter, and paging on it silently returns nothing

**Severity: high — fails closed in a way that looks like an empty venue.**

The indexer leaves long-settled windows flagged `Trading`. Measured 2026-08-19: **~20 rows
reported `Trading` while exactly 8 were genuinely open.**

`docs/event-contracts.md` gotcha #1 already says to gate on on-chain status rather than the
indexer. The failure mode worth adding is subtler than "stale by seconds": the natural query
shape breaks outright.

```graphql
Market(where: { clobStatus: { _eq: "Trading" } }, order_by: { expiry: asc }, limit: 100)
```

Ordered ascending with a limit, stale rows fill the page before any live one appears. Filter
`expiry > now` client-side afterwards and you get **zero markets**, forever, with nothing in the
log to say why. We shipped this bug and spent a while assuming the venue had gone quiet.

**Fix in the consumer:** push the expiry bound server-side.

```graphql
Market(where: { marketType: { _eq: "BINARY" }, venueId: { _eq: $v },
                clobStatus: { _eq: "Trading" }, expiry: { _gt: $now } })
```

**Suggested fix:** have the indexer transition `clobStatus` off `Trading` at expiry, or document
the paging hazard alongside gotcha #1. `ec-core::activeMarkets` filters on `m.active` and is
therefore fine — but anyone querying the indexer directly, as any UI must, will hit this.

---

## 3. `packages/backtest` has no event-contract support

**Severity: high for anyone building on the EC side.**

`scripts/backtest.ts` `BOT_IDS` lists nine strategies — `momentum`, `mean-reversion`, `grid`,
`market-making`, `twap`, `starter`, `ensemble`, `treasury`, `yield-optimizer` — and **none of the
six `ec-*` ones**. So the half of the kit the hackathon is about cannot be backtested by the kit.

Beyond the missing adapters, the engine's model does not transfer:

- It builds a synthetic book from OHLCV candles. Binary windows have no candles, and 97% of them
  never trade at all, so a synthetic book would let a strategy fill any size at any price on
  markets where no counterparty ever existed.
- It is bar-by-bar with one strategy callback per candle. A 15-minute window has a *life*, and
  what matters is where in that life a decision is made — our own results show model AUC rising
  from 0.60 at 10% through the window to 0.94 at 90%.
- Settlement is the entire P&L event for a binary and has no analogue in the spot model.

**What we built instead** (`src/backtest/`): replay against **fills that actually executed**. A
printed fill is proof a counterparty existed at that price for at least that size, which removes
the need to model a book at all. 53,989 fills over 30 days was ample.

**Suggested fix:** a fill-replay mode in `packages/backtest`, plus `ec-*` adapters. The data is
already in the indexer; the `Fill` table has everything needed including `makerSide`.

---

## 4. The SDK's auto-approve block turns any bad argument into a `TypeError` from a transitive dependency

**Severity: high — it is the first thing a new Event Contract developer hits, and what they see
names nothing.**

**This section replaces an earlier one that was wrong, and the correction matters more than the
finding.** We originally reported that `ec-core` has no allowance handling and that a fresh
wallet's first Event Contract order therefore always reverts. The first half is literally true and
irrelevant; the second half is false. **The SDK grants the allowance itself, on the binary path, by
default.**

`orders.js::placeOrder` — the function that ends in `placeBinaryOrder` — opens with:

```js
// Escrow pulls from msg.sender via the pool, so authorize the POOL:
// buys need a collateral ERC-20 allowance; sells need a one-time operator
// grant on the outcome-token singleton (covers all markets + both sides).
if (p.autoApprove !== false) {
    const e = w.escrow(p, await w.tokens(p));
    if (e.kind === "erc20") await w.approveIfNeeded(e.token, p.pool, e.amount, gas);
    else                    await w.ensureOperator(e.outcomeToken, p.pool, gas);
}
```

`ec-core` never passes `autoApprove`, so it is on. Measured end to end on 2026-09-05, one wallet
with no allowance to the pool, one `ec-core.placeLimit`:

```
allowance(owner -> pool) BEFORE : 0
allowance(owner -> pool) AFTER  : 115792089237316195423570985008687907853269984665640564039457584007913129639935
```

That is `maxUint256`, granted to the pool, by the SDK, with no allowance code in `ec-core` at all.
Our original evidence — "a wallet that had successfully traded held an unlimited allowance to the
pool address specifically" — was the SDK working correctly, and we read it as the SDK failing.

**The real defect is next to it, and it is what actually cost us the hours.** `escrow()` is a
four-case `switch` with no `default`:

```js
function escrow(p, { outcomeToken, yesId, noId, collateral }) {
    switch (p.side) {
        case "BUY_YES":  return { kind: "erc20",   token: collateral, amount: … };
        case "BUY_NO":   return { kind: "erc20",   token: collateral, amount: … };
        case "SELL_YES": return { kind: "erc6909", outcomeToken, id: yesId, amount: p.quantity };
        case "SELL_NO":  return { kind: "erc6909", outcomeToken, id: noId,  amount: p.quantity };
    }
}
```

Any other `side` returns `undefined`, and the caller immediately reads `e.kind`. `ec-core` forwards
`SIDES[\`${outcome}-${side}\`]` without validating it, so a leg string the map does not contain
becomes, verbatim:

```
TypeError: Cannot read properties of undefined (reading 'kind')
    at Module.placeOrder (@somnia-chain/markets-sdk/dist/orders.js:457:15)
    at async Module.placeLimit (@dreamdex-bot-kit/ec-core/src/orders.ts:128:15)
```

A developer sees a `TypeError` from inside a transitive dependency they did not know they had,
pointing at a line about approvals, for what is a one-word argument mistake at their own call site.
We reproduced this on 2026-09-05 by passing `side: "BUY"` where `ec-core` wants `"buy"`.

**And the reverts really do arrive unnamed — but the chain names them.** The pool's custom errors
decode cleanly against the SDK's own `contractErrorsAbi`:

| selector | error |
|---|---|
| `0xfb8f41b2` | `ERC20InsufficientAllowance(address,uint256,uint256)` |
| `0x3fb0ba2e` | `OnlyApprovedContracts()` |
| `0xaf608abb` | `InvalidPrice(uint256,uint256)` |
| `0xeaa68ceb` | `QuantityBelowMinimum(uint256,uint256)` |
| `0x7cf05fcb` | `PostOnlyWouldCross()` |
| `0x3154078e` | `OrderAlreadyExpired()` |

`ContractRevertError` already carries `errorName` and `args`, and `revert.js` already decodes
against that ABI — both present in 0.25.0. **So the name exists at every layer and still does not
reach the caller**, and the reason is worth naming precisely: the message we actually got,

```
@somnia-chain/markets-sdk: placeBinaryOrder reverted: for an unknown reason
```

is assembled around `viem/_esm/errors/node.js:8` —

```js
super(`Execution reverted ${reason ? `with reason: ${reason}` : "for an unknown reason"}.`, …)
```

— which is the layer *below* the SDK reporting that it found no plain `require` string. A custom
error is not a `require` string, so viem correctly says it has no reason, and that verdict is what
propagates. The SDK's own decode, which would have said `QuantityBelowMinimum` or
`ERC20InsufficientAllowance`, never gets a turn on this path. Nothing here is anyone lying; it is a
named error, a decoder that can name it, and a wrapper that answers first.

**Suggested fix, in order of value:**

1. Give `escrow()` a `default` that throws `new SomniaMarketsError(\`unknown side ${p.side}\`)`.
   One line, and it converts the worst error message in the kit into the clearest.
2. Have `ec-core::placeLimit` validate `outcome`/`side` against `SIDES` before forwarding, and say
   what it got.
3. Surface `errorName` in whatever the kit's examples print when a write fails. The decode is
   already done; it just is not shown.

**A second-order hazard worth documenting alongside it.** We first tried approving inline, then
concluded it raced the SDK's nonce and moved it out of the loop. That conclusion was also wrong —
the reverts were finding #5 below, present in both runs we compared. Measured properly, an inline
approval that waits for its receipt does **not** race the SDK. Recording it because the kit's own
nonce warning makes the wrong conclusion very easy to reach, and because it is the second time on
this list that we misattributed finding #5 to something else.

---

## 5. The venue's lot is coarser than `ec-core` configures, and the rejection is unnamed

**Severity: high — it breaks any strategy that sizes continuously.**

`packages/ec-core/src/config.ts` sets testnet `lot: 1` raw unit, on the note that *"the venue
accepted orders down to 1 raw unit (0.000001 share), i.e. no lot constraint in practice."*

It does not. Measured on one market at one price, same signer, same minute:

| size | result |
|---|---|
| 1, 2, 3, 5, 8 | filled |
| 3.71 | filled |
| **9.749193184999303** | **reverted** |

3.71 is exactly 3,710,000 raw units. 9.749193… floors to 9,749,193 — a multiple of nothing. The
revert message is the same `for an unknown reason`.

This is not an edge case for anyone sizing by a continuous rule. Fractional-Kelly sizing produces
values like the third row on essentially every order, so the venue rejects everything until you
discover the constraint by bisection.

**Suggested fix:** publish the venue's real `lotSize` on the binary market row — spot and perp rows
already carry `tickSize`, `lotSize` and `minQuantity`, and binary rows carry none, which is why
`ec-core` has to guess. Failing that, correct the configured default and the comment.

---

## 6. `loadEnv()` runs too late to help a consumer decide dry-vs-live

**Severity: medium — silent, and it makes live mode unreachable from `.env`.**

`loadEnv()` lives inside `createExchange()`. But a consumer decides *whether to open a signer at
all* before calling it — that is the entire point of `createExchange({ withSigner })`. So code that
reads `process.env.PRIVATE_KEY` to choose its execution mode sees nothing, and silently stays
read-only next to a `.env` containing exactly that key.

Our runtime reported `no funded PRIVATE_KEY — staying dry` while sitting beside a populated `.env`.

**Suggested fix — and our original suggestion was already done before we wrote it.** We asked for
`loadEnv` to be exported from the package index. It is, at `packages/ec-core/src/index.ts:16`, and
has been since 2026-08-07. What remains is documentation, not code: the getting-started page should
say that a consumer branching on `process.env` must call `loadEnv()` itself first, because
`createExchange()` calling it internally is too late to help anyone deciding whether to open a
signer at all.

---

## 7. `trader.faucet()` is unreachable for a pure taker

**Severity: low, but it produces the most confusing possible failure.**

`ec-core`'s faucet call lives inside `seedInventory`, which a taker never invokes — buying by
crossing the book needs no minted inventory. So a wallet with gas and no tUSDC runs the loop
perfectly, scans every market, evaluates every leg, and buys nothing, forever. It looks exactly
like a bot that has found no opportunities.

There is a direct path, and it is the one the venue team gives out in the developer chat:

```bash
cast send 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E "faucet(uint256)" 10000000000 \
  --private-key $KEY --rpc-url https://dream-rpc.somnia.network
```

That is a plain ERC-20 call needing nothing but a key, and it is not in the developer
documentation — only in chat. Ours now calls `faucet(uint256)` directly for exactly that reason:
routing it through the kit meant a developer had to clone a second repository and link it before
they could fund a wallet, which is a strange prerequisite for getting test tokens.

**Suggested fix:** put the direct `faucet(uint256)` call in the Event Contracts docs beside the
token address — it is the first thing a new developer needs and it is currently tribal knowledge.
Then expose the faucet on the exchange surface too, or top up collateral in the same place gas is
checked (`assertFunded` already reads the native balance and throws a good message when it is zero
— collateral deserves the same).

---

## 8. WITHDRAWN — `OutcomeBalance` agrees with the chain; our reader was reading a recycled pool

**Withdrawn 2026-09-05. This was our measurement error, not a venue defect.**

We reported that `OutcomeBalance` disagreed with the outcome-token contract in both directions and
did not converge, on the strength of two rows out of five on one wallet reading `0.3100` and
`0.7900` against an on-chain `0.0000`, both on **Finalized** windows.

Re-measured against the ERC-6909 singleton `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9`, using the
`tokenId` carried on the indexer row itself:

```
80 rows on one wallet:  agree 80,  indexer overstates 0,  indexer understates 0
```

**The original method is the bug, and this document already described it.** We read balances via
`getBinaryPoolParams()` → `yesId`/`noId` → `balanceOf`. Pools are recycled: when a window ends its
pool is handed to the next one and those ids move with it, so a finished window's pool answers for
somebody else's token — a confident zero. That is exactly the trap written up in the original
version of this section, under "A trap for anyone who does what we did", and we then filed its
output as evidence against the indexer. Every one of the 80 rows on this wallet belongs to a window
whose pool has since rolled, which is why the effect was easy to reproduce and easy to misread.

**Reading by the row's own `tokenId` sidesteps recycling entirely** and needs no pool call:

```
balanceOf(owner, OutcomeBalance.tokenId)   on the singleton
```

**What survives.** Nothing about the indexer here — but the recycling hazard is real and belongs in
the docs beside the pool-recycling gotcha, because the failure is silent and the wrong answer is
the one that authorises deleting a position. Rivo keeps its guard (`getBinaryPoolParams().market`
compared against the market you meant) for that reason; it is what makes a pool read safe, and it
is the reason our live runtime was never actually wrong about a holding.

The earlier lag observation — a maker re-reading inventory, seeing zero and re-minting, measured at
40 complete sets bought to support 16 orders — was a different measurement and is not withdrawn.
It is ordinary indexer lag, and the fix is the same: read holdings from the chain before spending
money on the answer.

---

## 9. Event Contracts ship `placeBinaryOrderFor` and `cancelOrderFor` — and both are disabled

**Severity: high — this single flag is what stands between the kit and a non-custodial product.**

This started as a grep. `docs/session-keys.md` describes the split-key model well and spot
supports it: `Pool.place` detects `ctx.owner` and routes through `placeOrderFor`, while
`ec-core::placeLimit` calls `trader.placeOrder` directly and `grep -rn
"placeOrderFor\|OWNER_ADDRESS" packages/ec-core/src/` returns nothing.

That grep turned out to understate the situation, in an interesting direction. **The deployed
BinaryPool has the on-behalf entrypoints.** They are simply switched off — and the gate has a name.
Every on-behalf call, from every caller we tried including the pool itself, reverts `0x3fb0ba2e`,
which decodes against the SDK's own `contractErrorsAbi` as **`OnlyApprovedContracts()`**. It is an
allowlist, and nothing is on it.

Reproduce it with `npm run probe:operator` in the Rivo repo (about a minute, zero gas, no key
required — it is all `eth_call`). Saved output: [`docs/evidence/operator-probe.json`](evidence/operator-probe.json).

**What is in the bytecode.** The pools are beacon proxies, and the beacon resolves to an
implementation that is *not* the `binaryPoolImpl` hardcoded in `ec-core/src/addresses.ts` (see the
smaller note below). In that live implementation:

| selector | | |
|---|---|---|
| `0x5d97c566` | `placeBinaryOrderFor(address owner, …)` | **present** |
| `0xe37b444b` | `cancelOrderFor(address owner, uint128)` | **present** |
| `0xa8cb3794` | `isOperatorAuthorized(address,address,bytes4)` | absent |

So the on-behalf pair exists on Event Contracts, while the spot-style gate view does not — there
is no on-chain way to ask a BinaryPool whether an operator is authorised.

**What happens when you call them.** The method is a differential, because "it reverted" is not
evidence of anything on its own. First establish a working baseline, then change one thing:

```
placeBinaryOrder      valid args             -> OK, returns an order id
placeBinaryOrder      price = 0              -> revert 0xaf608abb
placeBinaryOrder      price >= 1             -> revert 0x6e4ba61d
placeBinaryOrder      quantity = 0           -> revert 0xeaa68ceb
placeBinaryOrder      expiry = 0             -> revert 0x3154078e

placeBinaryOrderFor   the SAME valid args    -> revert 0x3fb0ba2e
cancelOrderFor        owner, order id        -> revert 0x3fb0ba2e
```

The pool distinguishes its failures — four parameter mistakes, four different selectors. Against
that baseline a single shared error on both on-behalf paths is not a parameter problem.

Nor is it an authorisation decision. `0x3fb0ba2e` comes back identically from **every** caller we
could think to try, using `eth_call`'s ability to impersonate any `from`:

```
the owner itself · an unrelated address · binaryModule · collateralRouter
marketsCore · binarySettlement · the pool itself
```

The owner calling `placeBinaryOrderFor(owner, …)` on its own behalf gets the same revert as a
stranger. No grant can fix that, because no grant is being consulted.

We also eliminated the most plausible innocent explanation — that the on-behalf path draws from a
pool vault the owner has not funded. `deposit(address,uint256)` and `withdraw(address,uint256)`
are both present, so we funded it for real: deposit
[`0x6768744c…`](https://shannon-explorer.somnia.network/tx/0x6768744cf40853fd71bd4be7481dedcb7517a019561ce780afc240fe2f0e8b35)
succeeded, the call still returned `0x3fb0ba2e`, and the deposit was swept back out with
[`0xc8ded2fa…`](https://shannon-explorer.somnia.network/tx/0xc8ded2fa23002c244f6b99f7b9b0a9ef445c0871edae42e5997a544604ff72b6).
(`setManualVaultMode` — the spot precondition — is absent from the binary pool entirely.)

**The reading: compiled in, switched off.**

**Why it matters.** With this enabled, "connect your wallet and let it run" is buildable on Event
Contracts: an owner grants a hot key permission to place and cancel, the key can never withdraw,
and revocation is on-chain. With it disabled, every autonomous EC product on this venue degrades
to "paste a private key into a web app" — which is the difference between a product and a script.
Rivo ships a bounded agent wallet (`npm run agent`) to make the *loss* small, because that is the
only lever left when the chain will not scope authority. It is a workaround, not a fix.

**What would help, in order:** enable the two entrypoints; expose `isOperatorAuthorized` on the
binary pool so a client can check a grant before sending; name the error (a selector with no ABI
entry is undiagnosable — `0x3fb0ba2e` is not in the SDK's ABIs, and the public 4-byte databases
have never seen it); then wire `ctx.owner` through `ec-core::placeLimit` the way spot's
`Pool.place` already does.

One structural wrinkle worth flagging even once it is enabled: operator grants are **per pool**,
and EC pools are recycled per window. A bot trading the 15m series would need a fresh grant every
quarter hour, or `setOperatorApprovalGlobal`, which is much broader than the per-pool default the
docs recommend. Session keys for EC probably need a venue-scoped or series-scoped grant to be
practical.

---

## 10. Down-leg liquidity comes from resting `BUY_YES`, and the docs don't say so

**Severity: medium — causes systematic under-filling, silently.**

It follows from mint-a-pair once you know it, but it is not stated anywhere and it inverts the
obvious reading of the book:

```
buy  UP    crosses resting SELL_YES at p
buy  DOWN  crosses resting BUY_YES  at p   ->  you pay 1 - p
```

A depth model that counts only `SELL_YES` underestimates Down-side size — and on this venue Down
is usually the *deeper* side. Measured 2026-08-19: **26 `BUY_YES` resting vs 10 `SELL_YES`**;
re-measured 2026-09-05 across 1,000 open orders: **641 `BUY_YES` vs 354 `SELL_YES`**. The ratio has
held for three weeks.

**One correction to our own model.** The two crossing paths above are not the whole book: `Fill`
carries native NO-side makers as well. Over 600 recent binary fills the maker sides were
`BUY_YES` 261, `SELL_YES` 199, **`BUY_NO` 133, `SELL_NO` 7**. So a complete depth model has four
resting sides to resolve, not two, and roughly a quarter of maker flow is on the legs our original
description left out.

The failure is quiet: orders just fill smaller than the sizer asked for, which reads as bad
liquidity rather than a modelling error.

**Suggested fix:** one sentence in the recipes page under "Read the order book", or a
`legDepth(market, leg)` helper in `ec-core` that resolves both crossing paths.

---

## 11. WITHDRAWN — the `Series` table is populated

**Withdrawn 2026-09-05.** The exact query in the original version of this section now returns rows:

```bash
curl -s -X POST https://dev.smk.somnia.host/v1/graphql -H 'content-type: application/json' \
 -d '{"query":"{ Series(limit:40){ seriesId intervalSec asset } }"}'
```

```
(1, 900s, BTC)   (1, 300s, SOL)   (2, 300s, SOMI)   (305, 300s, SOMI)
(1, 3888000s, BTC)   (2, 3888000s, ETH)
```

It was empty when we measured in August. Either it was backfilled since, or our query hit it before
it was populated; we cannot tell which from here, and the honest thing is to say so rather than
leave a claim standing that a reader can disprove in one command.

**One thing does survive, and it now has better evidence.** `Series` still does not cover the venue
Rivo trades: there is no row for the 3600s or 14400s cadences that are demonstrably live, so it is
not yet the authoritative list of what a venue runs, and consumers still infer the grid from
`intervalSec` on live rows. That is what makes #12 a problem rather than a curiosity.

---

## 12. Retired and malformed series persist and are indistinguishable from live product

**Severity: medium for anyone calibrating or backtesting.**

Over 30 days of settled windows we found `intervalSec` values of **56, 58, 59, 60, 89, 92, 126,
129, 135, 137, 296, 298, 300, 465, 467, 574, 578, 898, 899, 1437, 1438, 1885, 1887, 1931, 1933,
2736, 2738, 2740, 2743, 3258, 3262, 3266, 3270, 3598, 3599, 5033, 5035, 5480, 5482, 11073, 11076,
12726, 12727, 13961, 13962, 25469, 25471, 27122, 27124, 32051, 32054, 34276, 34278, 42758, 42759,
45931, 45933** alongside the real grid of 900 / 3600 / 14400 / 86400.

The 60s series alone is **9,125 settled windows** — 55% of our raw sample. It is not the product
(nothing that short has been listed since the current grid settled) and it is where a diffusion
model breaks down: over sixty seconds the horizon is shorter than any volatility measurement is
meaningful over. Calibrating without excluding it produced a reliability curve claiming 0.020
on outcomes that settled UP 31.8% of the time.

Series also drift by a second or two between windows (898s, 899s, 3598s), so cadence matching has
to be by proximity, not equality.

**Suggested fix:** a `retired` or `active` flag on the series, or populate `Series` (#6) so
consumers can scope to what the venue actually offers.

---

## 13. Testnet tUSDC(6) vs mainnet USDso(18)

**Severity: low — well documented, still a recurring foot-gun.**

`docs/gotchas.md` #15 covers USDso being 18 decimals. The asymmetry deserves equal billing: **on
testnet the collateral is tUSDC with 6 decimals**, so anything reading raw `Order.price`,
`Order.quantityRemaining`, or `Fill.fillPrice` needs the per-network divisor, and code that works
perfectly on testnet is wrong by 10¹² on mainnet.

`ec-core::loadConfig` gets this right and comments it clearly. The trap is for direct indexer
consumers — again, any UI.

Related and worth a line in the docs: `Fill.fillPrice` **is** always an Up probability regardless
of `makerSide`. We verified this (`quoteQuantity / quantity` matches `fillPrice` exactly on both
`BUY_YES` and `SELL_YES` maker rows) only because we suspected an inversion bug. Stating it
saves the next person the same detour.

---

## 14. `DreamDexRest` issues an unbounded `fetch`

`packages/core/src/rest.ts:139` calls `fetch` with no `AbortSignal`, so a request that connects
and then stalls never resolves and never rejects. Every other network path in the kit is bounded —
viem's `http()` transport defaults to a 10s timeout and `waitForTransactionReceipt` to 180s — which
makes this one the exception rather than the pattern, and the easiest kind of gap to miss.

The failure mode is specific and quiet. A stalled read does not throw, so a caller's `try/catch`
never runs, its retry logic never runs, and its process stays alive at zero CPU holding an open
socket. Nothing that inspects the process reports a problem.

We hit exactly this shape in **our own** indexer client, not in the kit — which is why it is worth
reporting rather than shrugging at. A live Rivo runtime sat frozen for two hours: state file
untouched, three sockets open, `utime` unchanged between samples, and every liveness check that
looked at the process said healthy. It had stopped trading, settling and claiming. The fix was one
line per call site:

```ts
const res = await fetch(url, { ..., signal: AbortSignal.timeout(20_000) });
```

**Suggestion:** give `DreamDexRest` a `timeoutMs` option defaulting to something finite, and say in
the docs that an autonomous bot must bound every read. Bots built on this kit are explicitly meant
to run unattended, and unattended is precisely when nobody notices a hang.

---

## 15. `createExchange` hides the SDK's own signer flexibility, and that hides a whole product tier

**Severity: medium — nothing is broken, but the shape of the kit's entry point makes a supported
capability look impossible, and we nearly wrote it off on that basis.**

`ec-core`'s `createExchange` takes `{ withSigner?: boolean }` and forwards exactly one signing
source:

```ts
// packages/ec-core/src/exchange.ts
if (opts.withSigner && !config.privateKey) throw new Error("PRIVATE_KEY is required for trading…");
const exchange = new SomniaMarkets({ …, privateKey: opts.withSigner ? config.privateKey : undefined });
```

Read that alone — and every example does read it alone — and the conclusion is that trading with
`ec-core` means putting a raw private key in the process environment. For a bot that is fine. For
a **product**, it is disqualifying: it means either asking users to paste private keys, or holding
strangers' keys on a server. We had written §9 above on the assumption that the venue left no
third option.

The SDK underneath does not have that limitation, and says so:

```ts
// markets-sdk/dist/unified/exchange.d.ts
export type SomniaMarketsConfig = ClientConfig & Pick<TraderConfig, "privateKey" | "account" | "walletClient">;
setSigner(signer: Pick<TraderConfig, "privateKey" | "account" | "walletClient">): void;

// markets-sdk/dist/writer.js — how a signer is resolved
if (config.privateKey) localAccount = privateKeyToAccount(config.privateKey, { nonceManager });
else if (typeof config.account === "object" && "signTransaction" in config.account) localAccount = config.account;
```

**Any object with a `signTransaction` method is accepted as the local-signing fast path** — it
signs locally and confirms in one round trip, exactly as a private key does. And `setSigner` rebinds
an exchange after construction, which the docstring describes for browser wallet-connect flows.

Those two facts together are the difference between a script and a product:

```ts
const ctx = createExchange({ withSigner: false });
ctx.exchange.setSigner({ account });   // any viem Account
// every ec-core verb — placeLimit, sellableSize, maybeClaim, cancelTracked — now signs as `account`
```

The `account` can be a key. It can equally be a viem `LocalAccount` whose `signTransaction` is an
authenticated call to a TEE that holds the key share — which is what Privy's
`createViemAccount({ walletId, address, privy })` returns. Rivo uses exactly that: each user's
portfolio wallet signs its own orders, server-side, while the user is offline, and **Rivo's
database holds an address and a wallet id and no key material at all.**

**What we would change.** Not the SDK — it is already right. `ec-core`:

```ts
export function createExchange(opts: {
  withSigner?: boolean;
  /** A pre-built signer: viem Account, or a wallet client. Anything the SDK accepts. */
  account?: Account;
  walletClient?: WalletClient;
} = {}): EcContext
```

Five lines, and one sentence in the README pointing out that a signer need not be a private key.
As it stands, the kit's most consequential capability for anyone building a consumer product is
reachable only by reading `dist/writer.js` in a transitive dependency.

**This does not weaken §9.** On-chain scoping and key custody are different questions. The venue
still offers no way to bound what a signer may do with Event Contracts — `placeBinaryOrderFor` is
still compiled in and disabled — so the limits remain software-enforced. What changes is who holds
the key, and that is the half a hosted product cannot compromise on.

Verified rather than asserted: `npm run check:kit` in the Rivo repo builds an exchange with no
signer, binds a throwaway viem account, and checks the exchange reports it as its wallet.

---

## 16. What the re-check changed

**Method.** On 2026-09-05 every finding above was re-run against `@somnia-chain/markets-sdk` 0.29.0
(published 2026-09-01; the document was originally written against 0.25.0, published 2026-08-07)
and against `dreamdex-bot-kit` `main`. Static claims were checked by diffing the two published
tarballs; live claims were re-queried against the public indexer and the testnet RPC; the two
claims that need a wallet were re-run with a funded testnet key.

| # | claim | 2026-09-05 |
|---|---|---|
| 1 | oracle `numericValue` scale undeclared | **stands** — 1e2 and 1e4 rows in the same query |
| 2 | `clobStatus` is not a live filter | **stands, worse** — 500 rows flagged `Trading`, 0 unexpired |
| 3 | `packages/backtest` has no EC support | **stands** — `BOT_IDS` still lists no `ec-*` |
| 4 | first-order failure | **rewritten** — the SDK does approve; the defect is the missing `default` |
| 5 | venue lot coarser than configured | **stands** — `config.ts` still `lot: 1` with the same note |
| 6 | `loadEnv()` runs too late | **stands; suggestion was already shipped** 2026-08-07 |
| 7 | `faucet()` unreachable for a taker | **stands** — direct `faucet(uint256)` simulates fine, still undocumented |
| 8 | `OutcomeBalance` disagrees with chain | **withdrawn** — 80/80 rows agree |
| 9 | on-behalf entrypoints disabled | **stands, now named** — `OnlyApprovedContracts()` |
| 10 | down-leg depth is resting `BUY_YES` | **stands, extended** — NO-side makers are a quarter of flow |
| 11 | `Series` is empty | **withdrawn** — it returns rows |
| 12 | retired series indistinguishable | **stands** — 61 distinct `intervalSec`, 57 off-grid |
| 13 | testnet 6dp vs mainnet 18dp | **stands** — and `fillPrice` identity holds on 600/600 binary fills |
| 14 | `DreamDexRest` unbounded `fetch` | **stands** — `rest.ts:139` still has no `AbortSignal` |
| 15 | `createExchange` hides the signer | **stands** — still `{ withSigner?: boolean }` only |

**What moved upstream in between.** `ec-core` was bumped to markets-sdk `^0.28.1`, `activeMarkets`
gained a `scope` override, and the post-only comment was corrected to say it reverts
(`PostOnlyWouldCross`) rather than resting nothing — which matches what we measured independently.
None of the fifteen findings above were addressed by those commits.

**Reproducing #13's price identity**, since it is the one claim in this document that is a pure
data assertion:

```graphql
Fill(limit: 600, order_by: {timestamp: desc}, where: {market: {marketType: {_eq: "BINARY"}}}) {
  fillPrice quantity quoteQuantity makerSide
}
```

`quoteQuantity / quantity == fillPrice / 1e6` on every row, across all four maker sides. Note the
1e6: the `Fill` table mixes binary rows with spot and perp rows that use 1e18, so a consumer that
picks one divisor for the table gets the other market types wrong by a factor of 10¹².

---

## Smaller notes

- **`ec-core/src/addresses.ts` hardcodes a stale `binaryPoolImpl`.** It lists
  `0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD`; the beacon a live pool proxy actually delegates to
  resolves to `0x48e523c9f22f98548d263f0aD444D732e5202C0E` (40,566 bytes against 37,936). Nothing
  in the kit's own paths breaks, because they go through the SDK rather than the address — which
  is exactly why it can drift unnoticed. Anyone reasoning about the deployed bytecode from that
  constant, as we did first, reads the wrong contract. The file's comment says a stale entry "fails
  loudly"; this one does not, because the code-presence check passes on a contract that is simply
  an older version of the right thing.
- **`ec-oracle-follow`'s README is the most useful document in the kit.** Its honesty about the
  signal being a placeholder, and specifically the line *"the version of this strategy that makes
  money is a staleness play... not a forecasting edge"*, saved us from building the wrong thing.
  Our measurements agree with it: taking liquidity on a forecasting edge lost money at every
  threshold we tested. More strategy READMEs should state what does *not* work.
- **`OF_MAX_DISAGREEMENT` deserves promotion from a knob to a documented principle.** We shipped
  an edge floor with no ceiling and paid for it — losses grew monotonically with claimed edge,
  reaching −28% per unit staked above 0.40. The README explains exactly why
  (*"a very large gap on a liquid book usually means the model and the book disagree on the
  question or inputs, not a free 25-cent edge"*) and we still had to rediscover it empirically.
  A line in the main Event Contracts docs would help.
- **`getOpeningPrices` is the right abstraction** and `strike = 0` meaning "settles against its
  own opening price" is well explained in `ec-oracle-follow`'s README — but that explanation lives
  in a strategy README, not in the protocol docs, where `strike: 0` still reads as missing data.
- **Zero fees across maker, taker and settlement is a genuinely differentiating property** and is
  underplayed. It is what makes continuous rebalancing and complete-set arbitrage viable at all;
  it deserves more than a line in the market-structure page.

---

## What worked well, specifically

Worth saying, because feedback lists skew negative:

- `ec-core::placeLimit` quantising in integer tick/lot space is exactly right, and the comment
  explaining why `(0.05).toFixed(18)` breaks is the kind of documentation that prevents a whole
  class of bug.
- `assertTxOk` catching mined-but-reverted writes. Nobody expects a successful transaction to be
  a silent rejection.
- `settledMarkets()` wrapping `listBinaryMarkets({ status: "Finalized" })` — the "winnings are
  claimed, not received" section is the best explanation of that hazard we found anywhere.
- The per-window expiry headroom scaling to the series cadence rather than a fixed 300s. We
  adopted the same rule directly.
- `docs/measuring-edge.md` naming the five structural edges and insisting you name yours before
  building. We could not honestly name one for a directional taker, and the measurements
  eventually confirmed that. The document was right before our data was.
