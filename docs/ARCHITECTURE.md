# Rivo — architecture and migration assessment

Written against the code at `pre-production-restructure` (53 commits, 17,548 lines of TypeScript,
322 tests). It records what already exists, what production needs that does not exist yet, and the
one measurement that decided the shape of the answer.

---

## 0. Baseline, measured before anything moved

```
npm test          23 files, 322 tests, all passing        2.0s
npm run typecheck tsc --noEmit x2 (app + public bundle)   clean
npm run build:public  99.4 kB bundle, 150.2 kB single-file page  clean
```

Restore point: `git tag pre-production-restructure`.

---

## 1. What exists, and is kept

The engine is not a prototype. It is layered, and the layers are already separable.

| plane | modules | what it owns |
|---|---|---|
| pricing | `model/fairvalue`, `model/vol`, `calibration/` | conditional Φ(z) fair value, the calibration harness, AUC/Brier |
| discovery | `core/indexer`, `engine/scan`, `engine/book` | venue reads, the eight-market term structure, depth ladders |
| evaluation | `engine/opportunity` | edge, confidence, fillable size, per-leg delta |
| allocation | `portfolio/allocator` | Kelly sizing under **every** portfolio constraint at once |
| risk | `portfolio/risk`, `portfolio/profiles`, `portfolio/policy` | correlated exposure through ρ, expiry buckets, tenor caps, profiles |
| lifecycle | `runtime/loop`, `runtime/position`, `runtime/settlement` | the cycle, post-entry management, settle → claim → recycle |
| execution | `runtime/executor`, `runtime/allowance`, `runtime/maker` | ec-core order placement, inline pool approval, lot quantisation |
| truth | `runtime/reconcile`, `runtime/onchain`, `runtime/state` | chain-wins reconciliation, the ledger identity, atomic state writes |
| authority | `runtime/signer` | who signs, and what bounds that authority carries |
| safety | `runtime/lock`, `runtime/alert` | single-writer locking, breaker alerts |
| product | `public/`, `web/` | the static cockpit, the control server, the per-owner registry |

Three properties in here are load-bearing and must survive every change below:

1. **The allocator is portfolio-level.** `allocate()` scores every leg across every market, then
   spends a single budget through correlated-delta, expiry-bucket and tenor headroom. Three
   individually-positive BTC legs do not produce three buys. This is the product.
2. **The chain is the authority.** `reconcile()` treats local state as a claim and the outcome-token
   contract as the fact. A restart cannot re-buy what the wallet already holds.
3. **The ledger identity is enforced.** `cash + Σ open cost == capital + contributed + realised`,
   checked every cycle. This caught a live run that had drifted 426 of phantom cash.

---

## 2. What production needs, and does not have

| # | gap | today | consequence |
|---|---|---|---|
| 1 | durable state | `data/state.json` + `decisions.jsonl` per directory | one machine, one disk; no concurrent readers; no query |
| 2 | **execution provenance** | `txHash` lives on `HeldPosition` only | closing a position **erases its tx hash**. `proof.ts` already works around this. This is the "208 positions, 10 hashes" defect, and it is real |
| 3 | identity | a wallet address typed or connected in the browser | no accounts, no sessions, no email/social onboarding |
| 4 | autonomous signing | **one** backend key; Autopilot allowed only for that key's own address (`web/registry.ts`) | Rivo is single-tenant by construction. This is the blocker that makes it a script rather than a product |
| 5 | worker | web server spawns `tsx src/cli/run.ts` per owner, PID-file lock | no scheduler, no leases, no fleet; a dead box is a dead portfolio |
| 6 | idempotency | crash-safety rests on reconcile alone | a crash between submit and confirm has no intent record to recover against |
| 7 | web | vanilla-TS static SPA, hash routes | not Next.js, not on Vercel, no server session |

---

## 3. The measurement that decided the architecture

Gap 4 is the hard one, and the repo's own conclusion was that it could not be closed:

> "On DreamDEX Event Contracts as of 2026-08 there is no way to place an order for somebody else,
> so the only unattended authority is a key that can do anything the account can do."
> — `src/runtime/signer.ts`

That conclusion is **correct about the chain and wrong about the product**, and the difference is
worth being precise about, because it is what turns Rivo into something a stranger can use.

**On-chain delegation is genuinely unavailable.** The deployed BinaryPool contains
`placeBinaryOrderFor` and `cancelOrderFor`; both revert `0x3fb0ba2e` from every caller tried,
including the owner acting for itself, while each parameter mistake returns a selector of its own.
Compiled in, switched off. Reproducible in one minute with `npm run probe:operator`. Nothing below
changes that, and nothing below pretends otherwise.

**Off-chain custody of the signing key is available, and is a different question.** Reading the
installed SDK rather than assuming:

```ts
// @somnia-chain/markets-sdk/dist/unified/exchange.d.ts
export type SomniaMarketsConfig = ClientConfig & Pick<TraderConfig, "privateKey" | "account" | "walletClient">;
setSigner(signer: Pick<TraderConfig, "privateKey" | "account" | "walletClient">): void;

// @somnia-chain/markets-sdk/dist/writer.js — how a signer is resolved
if (config.privateKey) localAccount = privateKeyToAccount(config.privateKey, { nonceManager });
else if (typeof config.account === "object" && "signTransaction" in config.account) localAccount = config.account;
```

Any object with a `signTransaction` method is accepted as the local-signing fast path. And:

```ts
// @privy-io/server-auth/dist/dts/viem.d.ts
declare const createViemAccount: (input: { walletId: string; address: Hex; privy: PrivyClient })
  => Promise<LocalAccount>;
```

A viem `LocalAccount` whose `signTransaction` is an authenticated call to Privy's TEE. The two
interfaces meet exactly. `ec-core`'s own `createExchange` only forwards `privateKey`, but it returns
the exchange, and `setSigner` is a documented, supported method on it:

```
createExchange({ withSigner: false })  ->  ctx.exchange.setSigner({ account: privyAccount })
```

Every ec-core verb Rivo already calls — `placeLimit`, `sellableSize`, `maybeClaim`,
`cancelTracked` — then signs as the **user's** wallet, from the server, with the user offline, and
**no key material ever exists inside Rivo**. The user grants this once via Privy delegated actions
and revokes it whenever they like.

So the honest statement of the authority model becomes:

```
BOUNDS ENFORCED ON-CHAIN        none. The venue's operator entrypoint is disabled. (measured)
BOUNDS ENFORCED BY CUSTODY      Rivo cannot exfiltrate the key, because it never has it.
                                Privy holds it; Rivo holds a revocable right to ask for signatures.
BOUNDS ENFORCED IN SOFTWARE     capital ceiling, correlated delta budget, expiry buckets, tenor
                                caps, drawdown breaker, per-portfolio kill switch. Real, and only
                                as strong as Rivo's own correctness.
BOUNDS ENFORCED BY ARITHMETIC   the portfolio wallet holds only its float.
```

That is a materially stronger position than "we hold your key", strictly weaker than an on-chain
scope, and it is stated that way everywhere it is displayed.

---

## 4. Target shape, adapted to this repository

No big-bang move. `src/` stays where it is and keeps its meaning; the new planes are added beside
it and the existing ones are given a seam rather than a rewrite.

```
src/
  core/ model/ engine/ portfolio/ calibration/ backtest/ research/   unchanged
  runtime/          engine lifecycle — gains an execution ledger and an authority seam
  db/               NEW  pg pool, migrations, typed queries
  store/            NEW  StateStore interface: FileStateStore | PostgresStateStore
  ledger/           NEW  permanent execution record, append-only
  worker/           NEW  lease-based multi-portfolio scheduler
  public/ web/      the existing static cockpit and control server, kept working
web/                NEW  Next.js app — Privy auth, control-plane API, dashboard (Vercel)
```

Plane separation, as required:

| plane | where | why there |
|---|---|---|
| web / control | Next.js on Vercel | request-scoped, scales to zero, never runs a loop |
| durable state | managed PostgreSQL | the only thing both planes trust |
| execution | long-running worker container | a trading cycle is not a serverless function |
| identity / signing | Privy | key custody is not Rivo's business to be in |

---

## 5. Order of work

1. `src/db` + migrations, verified against a real PostgreSQL. ← storage plane
2. Permanent execution ledger, and the intent → submit → confirm → finalize state machine. ← gap 2, 6
3. `StateStore` seam; `FileStateStore` keeps every existing CLI, test and backtest working.
4. `PrivyAuthority` behind the existing `SigningAuthority` interface. ← gap 4
5. Worker with database leases; per-portfolio isolation preserved. ← gap 5
6. Next.js app, Privy onboarding, portfolio dashboard built around SKIP decisions. ← gap 3, 7
7. Observability, security pass, deployment, full verification.

Everything in step 3 onward is additive to the engine. The engine's own tests are the regression
gate: if a change makes `allocate`, `manage`, `reconcile` or the ledger identity behave differently,
that is a bug in the change, not a test to update.
