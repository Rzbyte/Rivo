# Rivo — architecture

What the system is, how the pieces divide, and why each boundary is where it is.
For how to deploy it, see [DEPLOY.md](DEPLOY.md); for what it protects against, [SECURITY.md](SECURITY.md).

---

## Execution permission

Five things have to agree before a single unit of capital moves. Four of them are new; the fifth was
always there and is unchanged.

```
strategy state  ·  execution mode  ·  network  ·  signer  ·  portfolio risk
```

This exists because the repository was carrying a contradiction in the open. `src/research/gating.ts`
evaluates a strategy against out-of-sample economics and returns **REJECTED** for the one in
production — and `mayExecuteLive()`, the function that reads that verdict, was called by exactly one
place: the research CLI. The worker asked a smaller question,

```ts
mayTradeLive(portfolio) && authority.available()
```

which is "did the user switch Autopilot on, and can we still sign". Both are necessary. Neither knows
whether the forecast has ever been shown to make money. So a strategy this repository's own evidence
calls economically rejected could reach `executor.buy()` with a real balance behind it, and nothing
in the path would object.

### The three modes

| mode | what it may do |
|---|---|
| `shadow` | Decide, price, record. Spend nothing. |
| `experimental_testnet` | Spend, on an **approved testnet only**, on a strategy that is not validated — because somebody chose that explicitly. |
| `validated_autopilot` | Spend, on any network, **only** behind a VALIDATED strategy. |

The Autopilot boolean this replaced could not express the case this deployment actually has: run a
strategy that failed economic validation, against a testnet, deliberately, without that being one
flag away from doing it to real money.

### What is permitted

Exactly four combinations, and the table is asserted in `src/runtime/permission.test.ts`:

```
validated_autopilot  + VALIDATED  + testnet   ✓
validated_autopilot  + VALIDATED  + mainnet   ✓
experimental_testnet + VALIDATED  + testnet   ✓
experimental_testnet + REJECTED   + testnet   ✓   ← what runs here today
```

`experimental_testnet` is bounded by **list membership**, not by `network !== "mainnet"`, so a typo
fails the test instead of passing a negation. An UNVALIDATED strategy additionally needs
`RIVO_ALLOW_UNVALIDATED_EXPERIMENTAL=true` — the exact string, nothing truthy.

### Fail closed

Every unknown denies, and says which: `STRATEGY_REJECTED`, `STRATEGY_UNVALIDATED`, `SHADOW_ONLY`,
`MODE_IS_SHADOW`, `EXPERIMENTAL_TESTNET_REQUIRED`, `NETWORK_NOT_APPROVED_FOR_EXPERIMENTAL`,
`EXPERIMENTAL_NOT_CONFIGURED`, `SIGNER_UNAVAILABLE`, `DELEGATION_MISSING`, `MODE_UNKNOWN`,
`STRATEGY_UNKNOWN`, `NETWORK_UNKNOWN`. An empty input denies. A mode this build has never heard of
denies — including the pre-upgrade string `autopilot`.

`mayTradeLive` is **deleted** rather than deprecated. Leaving it would leave the shorter question
available to the next person who needs a boolean.

### The strategy running here

| | |
|---|---|
| Strategy | Diffusion Taker V1 |
| Forecast quality | **AUC 0.8158** — measured, and genuinely good |
| Economic validation | **REJECTED** — −6.49% return on stake out of sample, walk-forward |
| Execution eligibility | **Experimental Testnet only** |

Both numbers are true and they point in opposite directions, which is the entire point of having the
gate. A model can be right about direction and still be a losing trade, because being right is not
the same as being right by more than the spread you cross to act on it.

Evidence: [ALPHA-RESEARCH.md](ALPHA-RESEARCH.md). Live on 2026-08-23 the drawdown breaker halted this
portfolio at −37% against a 35% limit, which is the same conclusion arriving the expensive way.

## 1. Four planes

```
      a person                                        DreamDEX / Somnia
         │                                                    ▲
         ▼                                                    │
  ┌──────────────────────┐                    ┌───────────────┴──────────────┐
  │ WEB / CONTROL        │                    │ EXECUTION                    │
  │ Next.js on Vercel    │                    │ long-running worker fleet    │
  │ request-scoped       │                    │ many portfolios, one process │
  │ never runs a loop    │                    │ leases, not assignments      │
  └──────────┬───────────┘                    └───────────────┬──────────────┘
             │                                                │
             └───────────────────┬────────────────────────────┘
                                 ▼
                   ┌─────────────────────────────┐    ┌──────────────────────┐
                   │ DURABLE STATE               │    │ IDENTITY / SIGNING   │
                   │ managed PostgreSQL          │    │ Privy                │
                   │ the only shared truth       │    │ holds the keys, so   │
                   │ append-only where it counts │    │ Rivo does not        │
                   └─────────────────────────────┘    └──────────────────────┘
```

**The worker is not a serverless function and cannot be.** A trading cycle settles, claims, reconciles
and allocates on a clock that has nothing to do with anybody being logged in, and it holds a lease
while it does. The product's whole promise — configure once, close the browser — is that this plane
keeps running when the others are idle.

**The web tier never trades.** It reads and writes policy; it does not execute. The only thing it can
start is a portfolio's `running` state, and the worker decides what that means.

---

## 2. The engine, unchanged

The trading intelligence predates the product and did not move to accommodate it. `allocate`,
`manage`, `reconcile`, `cycle` and the cash-ledger identity are the same functions with the same
tests they had before there was a database.

| module | owns |
|---|---|
| `model/` | realized volatility, conditional fair value |
| `engine/` | dual-crossing-path book, opportunity scoring, live snapshot |
| `portfolio/` | risk profiles, correlated delta and expiry-bucket risk, the capital allocator |
| `runtime/` | the cycle, position management, settlement, reconciliation, execution, authority |
| `calibration/`, `backtest/`, `research/` | the evidence harness |

Two seams were added underneath it, and nothing else:

```ts
// src/store/types.ts — the cycle writes into this and does not know what it is
export interface StateSink    { save(state: RivoState): void | Promise<void>; }
export interface DecisionSink { append(records: DecisionRecord[]): void | Promise<void>; }

// src/runtime/signer.ts — the executor asks for authority and does not know whose
export interface ChainSigner extends SigningAuthority { account(): Promise<Account>; }
```

Both are satisfied structurally by what already existed. `StateStore` and `DecisionLog` write files;
`PostgresStateStore` and `PostgresDecisionLog` write rows. `EnvKeyAuthority` reads a key from the
environment; `PrivyDelegatedAuthority` asks a TEE. The cycle cannot tell.

---

## 3. Signing: whose authority, and what bounds it

This is the part that turns a script into a product, and the part most worth being precise about.

**On-chain scoping is unavailable, measured rather than assumed.** The deployed BinaryPool contains
`placeBinaryOrderFor` and `cancelOrderFor`; both revert `0x3fb0ba2e` for every caller tried,
including the owner acting for itself, while each parameter mistake returns a selector of its own.
Compiled in, switched off. `npm run probe:operator` re-runs the differential in about a minute.

**Key custody is a separate question, and it has an answer.** Reading the installed SDK rather than
the kit's entry point:

```ts
// markets-sdk/dist/writer.js
else if (typeof config.account === "object" && "signTransaction" in config.account) localAccount = config.account;
// markets-sdk/dist/unified/exchange.d.ts
setSigner(signer: Pick<TraderConfig, "privateKey" | "account" | "walletClient">): void;
// @privy-io/server-auth/viem
declare const createViemAccount: (input: {walletId, address, privy}) => Promise<LocalAccount>;
```

Any object with `signTransaction` is the SDK's local-signing fast path, and Privy's server SDK
returns exactly that. So:

```
createExchange({ withSigner: false })  →  ctx.exchange.setSigner({ account })
```

Every ec-core verb then signs as **that user's** wallet, from the server, with the user offline, and
Rivo's database holds an address and a wallet id. `npm run check:kit` binds a throwaway account and
checks the exchange reports it; `src/runtime/executor.kit.test.ts` proves two executors in one
process get two different wallets and that an injected signer never falls back to `PRIVATE_KEY`.

**What is enforced, and by what:**

| | |
|---|---|
| on-chain | *nothing*. The venue's operator entrypoint is disabled. |
| by custody | Rivo cannot exfiltrate a key it never has. Revocation ends its authority. |
| by Privy policy | transaction policies, **where an operator has attached them**. Rivo declares what it wants in `POLICY_INTENT` and says "requested", not "enforced", until then. |
| by software | capital ceiling, correlated delta budget, expiry buckets, tenor caps, drawdown breaker, kill switch. Real, tested, and exactly as strong as Rivo's own correctness. |
| by arithmetic | the Rivo Portfolio holds only what its owner funded it with. |

The grant is checked in both directions. Turning Autopilot off stops the portfolio server-side and
calls Privy's `revokeWallets`; a user who revokes inside Privy instead is discovered by the worker,
which asks for the signer once per cycle and, on a revocation-shaped refusal, clears the grant and
pauses the portfolio. A timeout does neither — a flaky network must not switch a user off.

---

## 4. Durable state

```
users ─── wallets ─── portfolios ─┬─ portfolio_runtime   the mutable half of RivoState
                                  ├─ positions           lots. NOT unique per leg — see below
                                  ├─ executions          the ledger. append-only, enforced
                                  ├─ position_executions which transactions produced which lot
                                  ├─ decisions           the forward-test record. append-only
                                  ├─ events              what needed attention
                                  └─ portfolio_leases    one worker per portfolio, fenced
workers                                                  the fleet, heartbeating
```

**Isolation is a query parameter, not a check.** Every accessor takes the owner id as well as the
resource id, so a route that forgets to check ownership finds nothing rather than succeeding
against someone else's portfolio.

**`executions` is append-only and the database enforces it.** A trigger refuses every DELETE,
refuses to rewrite what was intended, refuses to replace a recorded transaction hash with a
different one, and refuses to move a row backwards through its state machine. The one exception is a
user's right to erasure, and it must be *declared*: `SET LOCAL rivo.erase = 'on'` lasts a single
transaction and appears in `eraseUser()` rather than nowhere.

**Positions are lots, deliberately.** The allocator tops a leg up by adding a lot so each keeps the
price it was actually filled at, and `reconcile` corrects them proportionally. A partial unique
index on `(portfolio, market, leg)` looked like an invariant worth enforcing and was the opposite —
see §7.

**Saves are version-checked.** The lease stops two workers touching one portfolio; the `version`
column is the assertion behind it. A save built on a stale snapshot throws rather than overwriting.

---

## 5. The execution ledger

One row per action that touches the chain, written **before** it is attempted and never deleted.

```
intended   durable, nothing signed. Crashing here costs nothing.
submitted  handed to the chain, hash known. Crashing here is why the row exists.
confirmed  receipt seen.
failed     rejected or reverted, with the reason.
orphaned   sent, and no receipt could be found.
```

`orphaned` is not a synonym for `failed`. An RPC that will not answer looks exactly like a
transaction that was never sent, and calling that a failure is a guess in the one direction that
duplicates a trade. Position truth for such a row comes from `reconcile`, against the outcome-token
contract.

Crash safety has two independent defences and needs both. The ledger stops a repeat **within** a
pass — an intent is durable before anything is signed, so a retry finds the earlier attempt.
Reconciliation stops a repeat **across** passes — the kit returns a hash only after the write
completes, so there is an instant in which Rivo has sent a transaction and cannot name it. The chain
can. `src/ledger/idempotency.test.ts` tests both halves against both stores.

---

## 6. The worker

```
register → heartbeat → claim what is due → recover → cycle → release → repeat
```

Nothing assigns work. Each worker asks for portfolios that are due and unleased, and
`FOR UPDATE ... SKIP LOCKED` makes that a queue rather than a stampede — adding a worker adds
throughput with no coordinator and no partition to rebalance.

Leases carry a **fencing token** that only increases, so a worker that stalls past its expiry, loses
the lease and then wakes up is refused a renew, a release and a read. A timeout alone would not make
that safe; it would move the collision later.

**Recovery runs before the cycle**, not after. A pass that allocates while a transaction from the
previous process is unaccounted for is reasoning from a portfolio that may already own what it is
about to buy.

Nothing in a portfolio's cycle touches `process.env`. That is what lets one process manage forty
portfolios that sign as forty different wallets.

---

## 7. Three bugs of one shape, and what they cost

All three were found by running the system against the live venue, not by reading it. All three are
the same mistake in different disguises: **a mutation that moves capital without leaving a record
the store can follow.**

| | what happened | how it showed up |
|---|---|---|
| lot overwrite | a partial UNIQUE index made a second lot's upsert overwrite the first | 3 ledger repairs in 40 cycles, drifting negative; BTC exposure reached 200% of a budget that was never broken — the exposure it was applied to was wrong |
| lost provenance | `position_executions` was never written | every closed position's audit trail was an empty list |
| partial sale | a REDUCE closed the whole position's row | one REDUCE of 0.66 shares, next cycle repaired the ledger by −0.31 — exactly the remainder's cost |
| merged position | a full merge removed the position with no closed record | 59 ledger repairs in one run; nothing closed the row, so the position came back on reload with the merge's capital already credited |

Each has a regression test. The store now also closes rows the state no longer accounts for, loudly,
because the class has appeared four times and the next disguise is not predictable — leaving an
orphaned row open means the position resurrects, which is worse than closing it and shouting.

The `LEDGER REPAIRED` warning is why any of this was visible. An accounting identity checked every
cycle is the cheapest bug detector in the system.

---

## 8. Where the code is

```
src/
  core/ model/ engine/ portfolio/ calibration/ backtest/ research/   the engine, unchanged
  runtime/     the cycle, execution, reconciliation, authority, receipts
  signing/     Privy delegated authority — per-user signing, no key material held
  ledger/      the permanent execution record, and crash recovery
  store/       the seam: file (dev, tests, one portfolio) | PostgreSQL (production)
  db/          pool, migrations, accounts, portfolios, leases, events, the view model
  worker/      lease-based scheduler
  proof/       evidence tooling over the database
  public/      the public pricing page — browser bundle, shares the runtime's math
  web/         the original single-portfolio cockpit
  cli/         start · worker · web · report · proof · calibrate · scan · … · agent
web/
  app/         Next.js — landing, the product, the control-plane API, a read-only demo
  components/  the dashboard, built around decisions rather than fills
  lib/         auth (one path from token to identity), validation, chain metadata
```

---

## 9. What is verified, and what is not

Stated here rather than implied anywhere, because the difference is the whole value of the record.

**Verified by running it:**

- 810 tests, including 130+ against a real PostgreSQL — leases, fencing, append-only triggers,
  optimistic concurrency, ownership boundaries, idempotency, crash recovery. Verified against both a
  local server and a managed Supabase instance (PostgreSQL 17.6).
- The worker managing a portfolio against the **live DreamDEX testnet venue**: market discovery,
  correlated allocation, position management including REDUCE and EXIT, settlement, claim sweeps,
  and the ledger identity holding to 1e-15 across hundreds of cycles.
- Per-user signing bound through the **real kit and SDK** — two executors in one process signing as
  two different wallets, and an injected signer not falling back to `PRIVATE_KEY`.
- `next build`, `build:public`, `typecheck` across engine, page and web app.

- **The Privy signing chain, against a real Privy app.** Credentials authenticate;
  `createViemAccount` returns a working viem account; **Privy signs a Somnia transaction
  (chainId 50312) when Rivo asks**; that account binds through `ec-core`'s `setSigner` and becomes
  the exchange's wallet; and two authorities in one process produce two different wallets. Rivo held
  no key material at any point.

**Not verified, and why:**

- **The user-consent flow.** The chain above was proven with an app-owned Privy wallet. A production
  portfolio uses a **user-delegated embedded wallet** — same signing path, different authorisation:
  the user grants it in Privy's own prompt and can revoke it. Proving that needs a browser sign-in,
  which a headless environment cannot do.
- **A broadcast transaction to DreamDEX.** Needs a funded wallet: STT for gas and tUSDC for
  collateral, both from the Somnia faucet.
- **The Docker image build.** Docker is unavailable here. The workspace-free install it depends on
  was verified directly instead, and CI builds and runs the image.
