# Security

Rivo signs transactions on behalf of people who are not watching. This is what it does about that,
what it deliberately does not claim, and where the sharp edges still are.

Nothing here is a certification. It is a written record of a hardening pass, so that somebody
deciding whether to fund a wallet can check the reasoning rather than trust a badge.

---

## 1. The threat model, stated first

| adversary | what they get | what stops them |
|---|---|---|
| a stranger with a portfolio id | nothing | every query is scoped by user id; an id they do not own returns 404 |
| a stranger with a stolen access token | that user's portfolio, until the token expires | Privy issues and expires the token; Rivo verifies it and stores no session of its own |
| **someone who fully compromises Rivo's server** | the ability to **ask Privy to sign** for delegated wallets, until each user revokes | Rivo never holds key material. The blast radius is what those wallets hold, not what their owners hold |
| someone who compromises the database | read of every portfolio's history; write access to policy | no keys, no session secrets, no credentials are stored in it |
| a malicious user | their own portfolio | isolation is per-row and enforced by foreign keys and query scoping, not by convention |

The third row is the one worth dwelling on, because it is the row a hosted trading product usually
loses. Rivo cannot exfiltrate a key it does not have. What a compromised Rivo *can* do is place
Event Contract orders from a delegated wallet — which is bounded by that wallet's balance, and
which the user can stop at any moment by revoking delegation in the product or in Privy.

**What Rivo does not claim.** The trading limits — capital ceiling, correlated delta budget, expiry
buckets, tenor caps, drawdown breaker — are enforced **in software, by Rivo**. They hold exactly as
long as Rivo's own code is correct and is the only thing asking Privy to sign. The venue offers no
on-chain way to scope what a signer may do with Event Contracts: `placeBinaryOrderFor` is compiled
into the deployed BinaryPool and reverts for every caller, which `npm run probe:operator`
re-measures in about a minute. Where Privy transaction policies are attached to a wallet they are
enforced by Privy at signing time; Rivo declares the policy it wants in `POLICY_INTENT`
(`src/signing/privy.ts`) and describes it as *requested*, not *enforced*, because attaching it is
an operator action Rivo cannot perform on the operator's behalf.

---

## 2. Authentication and authorisation

**One path from a token to an identity.** `web/lib/auth.ts` is the only place a bearer token is
accepted, and `verifyAccessToken` (`src/signing/privy.ts`) is the only place one is verified. It
returns a DID and nothing else, so no route can accidentally trust a claim the token merely carried.

**Ownership is a query parameter, not a check.** Every accessor takes the owner id as well as the
resource id:

```ts
portfolioOf(userId, id)      updatePolicy(userId, id, patch)      setDelegated(userId, walletId, …)
```

A route that forgets to check ownership therefore *finds nothing* rather than succeeding against
somebody else's portfolio. The failure mode is a 404.

**404, never 403.** A 403 confirms the resource exists. For an id somebody guessed, that is
information they did not have a moment ago.

**Tested, not asserted.** `web/lib/api.test.ts` exercises: no token, a forged token, a token in the
wrong scheme, another user's portfolio on read, on write, and on the Autopilot switch, and an
attempt to re-post an external wallet as a signer. The database is real in those tests — an
ownership check that passes against a mock is a mock of an ownership check.

**The schema is asserted about directly**, in `src/db/security.test.ts`. A column named
`private_key` added in six months by someone who was not here for the reasoning would pass every
behavioural test in this repository and destroy the product's central claim — so there is a test
that reads `information_schema` and fails on one. The same file pins that the append-only triggers
are still attached, that a wallet cannot be marked delegated with nothing to sign through, and that
two portfolios produce two different signing authorities.

**CSRF is not applicable, by construction.** Authentication is a bearer token in an `Authorization`
header, never a cookie, so a cross-site request cannot carry credentials. This is worth stating
because the usual mitigation (a CSRF token) would be theatre here, and its absence should not read
as an oversight.

**CORS.** The Next.js API routes set no CORS headers, so browsers enforce same-origin. The older
standalone cockpit (`src/web/server.ts`) deliberately does allow cross-origin reads — it is meant
to be reachable from a static page on another host — and gates every mutating request behind
`RIVO_CONTROL_TOKEN`, refusing to bind off-loopback without one.

---

## 3. What Rivo can be made to sign

An autonomous signer is only as safe as the set of transactions it can be talked into producing.
Rivo's is closed, and it is closed structurally rather than by validation:

* The `Executor` interface has six verbs — buy, sell, mint a complete set, merge one, claim,
  cancel. There is no "call this contract" method to abuse.
* Every market id comes from the venue scan, not from a request. A user cannot name a contract.
* Prices and sizes come from the allocator, which spends a budget derived from `capital` — a
  number the user set, which the database constrains to be non-negative and finite.
* The only unbounded approval Rivo ever sends is ERC-20 `approve` to a **pool address the venue
  itself reported**, and it is capped by the venue's own contract set rather than by a parameter.

The remaining risk is a bug in Rivo, not a request from a user. That is the honest shape of it.

---

## 4. Secrets

* **Nothing secret is in the repository.** `.env` is gitignored; `.env.example` carries names and
  explanations and no values.
* **`PRIVY_APP_SECRET` is the most sensitive value in a deployment.** Anyone holding it can ask
  Privy to sign for every wallet a user has delegated. Only `PRIVY_APP_ID` is `NEXT_PUBLIC_`, and
  the split is deliberate.
* **Register a Privy authorization keypair.** With `PRIVY_AUTHORIZATION_KEY` set, a stolen app
  secret alone cannot move a wallet.
* **No credential is ever logged.** `safeTarget()` (`src/db/pool.ts`) exists so that a connection
  error names a host and a database and never a password — a stack trace carrying a connection
  string has published it to every log sink downstream. `AuthorityDescription` has five fields and
  none of them can hold key material, which `src/signing/privy.test.ts` asserts by serialising it
  and searching for the secrets.
* **A build artefact leaked once.** `web/.next/` was committed early in this work — 314 generated
  files including webpack cache packs that had inlined `.env.example`. Harmless in that instance,
  and exactly the mechanism by which a real `.env` gets published. Removed, and gitignored.

---

## 5. Integrity of the record

* `executions` and `decisions` are append-only, and the database enforces it: a trigger refuses
  every DELETE, refuses to rewrite what was intended, refuses to replace a recorded transaction
  hash with a different one, and refuses to move a row backwards through its state machine.
* The one exception is a user's right to erasure, and it must be **declared**:
  `SET LOCAL rivo.erase = 'on'` lasts a single transaction and appears in `eraseUser()` rather than
  nowhere.
* Portfolio state saves are version-checked. A save built on a stale snapshot throws rather than
  overwriting whoever did the work.
* Two workers cannot run one portfolio: leases are taken by conditional UPDATE, expire on their
  own, and carry a fencing token that only increases — so a worker that stalls, loses its lease and
  wakes up believing it still holds one is refused a renew, a release and a read.

---

## 6. Rate limiting

**Mutating routes are limited per user: 30 changes per 60-second sliding window.** Reads are not,
deliberately — the dashboard polls, and a limiter that fought the product's own refresh is a limiter
somebody eventually removes.

A sliding window rather than a fixed one, because a fixed window lets a caller send the whole
allowance at 59 seconds and again at 61, which is twice the intended rate at exactly the moment it
matters. `web/lib/ratelimit.test.ts` pins that with staggered requests; an earlier version of the
test sent them at one instant, so they expired together and proved nothing.

**The honest limit of this.** It is in-memory, therefore **per instance**. On Vercel that means a
burst spread across cold starts sees a higher effective ceiling than the number above. That is a
real weakening, and it is written here rather than in a footnote. A deployment needing a hard global
limit needs a shared store or a limiter at the edge; this is the floor beneath that, not a
replacement for it.

The reason it is a floor rather than a wall: every mutating route is authenticated and scoped to one
user, and the expensive path — a trading cycle — is not reachable from a request at all. It belongs
to the worker, on a schedule the API cannot influence. So the damage an authenticated user can do by
looping is bounded by their own rows.

Also in place:

* `DATABASE_POOL_MAX` caps connections so a burst cannot exhaust the database's slots.
* `DATABASE_STATEMENT_TIMEOUT_MS` (30s default) means no single query can pin a connection
  indefinitely.

---

## 7. Dependencies

`npm audit` at the time of writing: **11 low, 0 moderate, 0 high, 0 critical**, from a starting
point of 36 with 5 high. CI fails on anything high or critical (`npm audit --audit-level=high`),
so this floor cannot quietly slip.

Three `overrides` in `package.json` pin transitive dependencies past their advisories, and each is
there for a reason worth recording:

| override | why |
|---|---|
| `ws@^8.21.3` | uninitialized memory disclosure and a fragment-based DoS in ≤8.20.1, reachable through the Solana client inside Privy's SDKs |
| `axios@^1.19.0` | a cluster of DoS and prototype-pollution advisories in ≤1.17.0, pulled in by a Coinbase SDK inside a wallet connector |
| `uuid@^11.1.1` | missing buffer bounds check in v3/v5/v6 when `buf` is supplied |

None of the three is code Rivo calls directly; all arrive through `@privy-io/*`. The overrides are
preferable to waiting for a major-version bump of a wallet SDK, and they are pinned rather than
floated so an upgrade is a deliberate act.

**The worker container does not contain most of that tree at all.** It installs with
`--workspaces=false`, so React, Next, WalletConnect and the Coinbase SDK — the source of nearly
every advisory above — are absent from the process that signs transactions.

---

## 8. The runtime, hardened

* The container runs as uid 1000, not root, and declares its state volume rather than writing into
  its own layer.
* `deploy/rivo-worker.service` applies `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
  a `SystemCallFilter`, and a `ReadWritePaths` of exactly one directory.
* The health endpoint reports fleet state and a database host. It carries no user data and no
  credential, and `/ready` returns 503 rather than 200 when the worker has not completed a pass in
  five minutes — a worker that is up and not working is not healthy.
* Alerts are marked delivered in the database, so a restart does not re-send every warning the
  fleet has produced. Refused trades are decisions, not events, and never alert.

---

## 9. Known gaps

Stated rather than omitted:

1. **Rate limiting is per instance, not global.** §6. A floor, not a wall.
2. **Trading limits are software-enforced.** §1. This is a property of the venue and cannot be
   fixed here.
3. **Privy transaction policies are requested, not verified by Rivo.** `POLICY_INTENT` describes
   what should be attached; Rivo does not currently read back the policy attached to a wallet and
   compare it. A deployment should check the dashboard.
4. **Privy sign-in, delegation and a real server-side signature are unverified.** No credentials
   were available in the environment this was built in. Every code path around them is tested with
   the credentials absent — a wallet that is not delegated refuses to build a signer, a revoked
   grant degrades to Shadow Mode, nothing displayable can carry a secret — and the signer BINDING is
   verified against the real kit and SDK with a local key. What is unproven is Privy's half of the
   round trip. `npm run privy:check` authenticates for real and reports exactly what is missing.
5. **A crash between signing and the return of a transaction hash is unattributable.** The kit
   returns a hash only after the write completes, so there is a window in which Rivo has sent a
   transaction and cannot name it. The execution ledger records such rows as `orphaned` — not
   `failed` — and position truth comes from on-chain reconciliation instead. See
   `src/ledger/idempotency.test.ts`, which tests both halves.
6. **The Docker build is verified in CI, not locally.** Docker is unavailable in the development
   environment used for this work; the workspace-free install it depends on was verified directly
   instead.
7. **No penetration testing has been done.** This is a hackathon project.
