# SDK & documentation feedback

Findings from building [Rivo](../README.md) against `@somnia-chain/markets-sdk` 0.25.0,
`@dreamdex-bot-kit/ec-core`, and the Somnia Markets indexer, over roughly a week in
August 2026 on the DreamDEX testnet venue
(`0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c`).

**Fourteen findings.** Every one is reproducible; where a snippet is given it runs against public
endpoints with no key. Ordered roughly by how much time each cost us.

Five of them (#4–#8) came out of taking Rivo live rather than reading the docs — they are the
things that only appear once a real wallet sends a real order. Three are worth pulling out:

- **#4 — a developer who follows your documentation exactly cannot place their first Event
  Contract order, and the error names nothing.** The one we would fix first, because it is the
  difference between a new builder shipping and concluding the venue is broken.
- **#8 — `OutcomeBalance` is wrong about what a wallet owns, in both directions, and does not
  converge.** Two of five rows on one wallet. A bot cannot guess at its own holdings.
- **#9 — the on-chain permission that would make non-custodial Event Contract bots possible is
  already deployed and switched off.** One flag away from changing what can be built here.

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

## 4. `ec-core` has no allowance handling, so a fresh wallet's first order always reverts

**Severity: highest on this list. It blocks every new event-contract developer, silently.**

The pool that escrows collateral needs an ERC-20 allowance. The **spot** half of the kit grants one
before every order — `packages/core/src/execute.ts` calls
`ensureAllowance(ctx, inputToken, p.pool, requiredAmount)`. The **event-contract** half has no
equivalent:

```bash
grep -rn "approve\|allowance" packages/ec-core/src/   # → no results
grep -rn "approve\|allowance" node_modules/@somnia-chain/markets-sdk/dist/   # → no results
```

So a wallet that follows the documentation, funds itself from the faucet, and places its first
Event Contract order gets:

```
@somnia-chain/markets-sdk: placeBinaryOrder reverted: for an unknown reason.
```

which names nothing. Not the missing allowance, not the pool, not the token. We lost hours to it,
and the only reason we found it was by comparing two wallets on-chain: ours held **zero** allowance
to every candidate spender, while a wallet that had successfully traded held an **unlimited**
allowance to the **pool address** specifically — not to `binaryModule`, not to `marketsCore`.

**Reproduce** — pick any wallet from a recent binary `Fill` and compare:

```bash
# allowance(owner, spender) on tUSDC 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E
cast call $TUSDC "allowance(address,address)" $WALLET $POOL --rpc-url https://api.infra.testnet.somnia.network
```

**Suggested fix:** call `ensureAllowance` from `ec-core`'s `placeLimit` exactly as the spot path
does, or fail early with a message that names the missing approval. This is the difference between
a developer's first order working and a developer concluding the venue is broken.

**A second-order hazard worth documenting alongside it.** We first tried approving inline, then
concluded it raced the SDK's nonce and moved it out of the loop. That conclusion was wrong — the
reverts were finding #5 below, present in both runs we compared. Measured properly, an inline
approval that waits for its receipt does **not** race the SDK: an approval fired mid-cycle between
two orders, and the order immediately after it filled. Recording the correction because the kit's
own nonce warning makes the wrong conclusion very easy to reach.

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

**Suggested fix:** export `loadEnv` from the package index (it is already exported from
`config.ts` but is easy to miss), or note in the getting-started page that consumers must load
`.env` themselves before branching on its contents.

---

## 7. `trader.faucet()` is unreachable for a pure taker

**Severity: low, but it produces the most confusing possible failure.**

`ec-core`'s faucet call lives inside `seedInventory`, which a taker never invokes — buying by
crossing the book needs no minted inventory. So a wallet with gas and no tUSDC runs the loop
perfectly, scans every market, evaluates every leg, and buys nothing, forever. It looks exactly
like a bot that has found no opportunities.

**Suggested fix:** expose the faucet on the exchange surface, or top up collateral in the same
place gas is checked (`assertFunded` already reads the native balance and throws a good message
when it is zero — collateral deserves the same).

---

## 8. `OutcomeBalance` disagrees with the chain in BOTH directions, and does not converge

**Severity: high — it is wrong about what a wallet owns, which is the one thing a bot cannot guess.**

We first filed this as ordinary indexer lag. It is not. Re-measured against the outcome-token
contract itself on 2026-08-22, one wallet, one read:

| market | leg | `OutcomeBalance` | ERC-6909 `balanceOf` | window |
|---|---|---|---|---|
| …5d4e | UP | 0.3100 | **0.0000** | Finalized |
| …5dc1 | DOWN | 0.7900 | **0.0000** | Finalized |
| …5dc2 | DOWN | 0.0700 | 0.0700 | Finalized |
| …5deb | DOWN | 0.3800 | 0.3800 | Finalized |
| …5de8 | DOWN | 0.3100 | 0.3100 | Trading |

**Two of five rows were wrong, and they were wrong in the direction nobody plans for.** Lag means
the table is *behind* — a fill or a mint that has not appeared yet. That is the case we had already
hit and reported: a maker re-reads its inventory, sees zero, mints again. Measured then at **40
complete sets bought to support 16 orders**, roughly 400 collateral spent re-acquiring inventory it
already held.

These two rows are the opposite. The positions settled, the tokens were burned on-chain, and the
row stayed. It is still there hours later, so this is not a few seconds of catch-up — it does not
converge. A bot reading that table sees an asset that does not exist, and any sensible thing it
does next is wrong: our runtime reported them as unclaimed payouts on **every single cycle**, and
a market still listed as Trading would instead have had a phantom position adopted into the
portfolio, with phantom value credited to the ledger.

Both directions are the same underlying problem: `OutcomeBalance` is a derived copy being used as
the record of ownership. Ours is now read from the pool's own ERC-6909 singleton
(`getBinaryPoolParams()` → `outcomeToken`, `yesId`/`noId`, then `balanceOf(owner, id)`) and the
indexer is treated as a hint. That works, and it is three calls where one indexed read should do.

**What would help:** treat a burn on settlement as an event that zeroes the row, the same way a
mint creates it; and document, beside the mint-a-pair recipe, that this table must not be used as
the authority on holdings by anything that spends money on the answer.

---

## 9. Event Contracts ship `placeBinaryOrderFor` and `cancelOrderFor` — and both are disabled

**Severity: high — this single flag is what stands between the kit and a non-custodial product.**

This started as a grep. `docs/session-keys.md` describes the split-key model well and spot
supports it: `Pool.place` detects `ctx.owner` and routes through `placeOrderFor`, while
`ec-core::placeLimit` calls `trader.placeOrder` directly and `grep -rn
"placeOrderFor\|OWNER_ADDRESS" packages/ec-core/src/` returns nothing.

That grep turned out to understate the situation, in an interesting direction. **The deployed
BinaryPool has the on-behalf entrypoints.** They are simply switched off.

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
is usually the *deeper* side. Measured 2026-08-19: **26 `BUY_YES` resting vs 10 `SELL_YES`.**

The failure is quiet: orders just fill smaller than the sizer asked for, which reads as bad
liquidity rather than a modelling error.

**Suggested fix:** one sentence in the recipes page under "Read the order book", or a
`legDepth(market, leg)` helper in `ec-core` that resolves both crossing paths.

---

## 11. The `Series` table is empty

**Severity: low, but it forces guesswork.**

```bash
curl -s -X POST https://dev.smk.somnia.host/v1/graphql -H 'content-type: application/json' \
 -d '{"query":"{ Series(limit:40){ seriesId intervalSec asset } }"}'
# -> {"data":{"Series":[]}}
```

So there is no authoritative list of which cadences a venue runs, and consumers must infer the
grid from `intervalSec` on live rows. That matters because of finding #7.

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
