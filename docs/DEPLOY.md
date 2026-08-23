# Deploying Rivo

Three planes, deployed separately because they fail differently and scale differently.

```
                 ┌──────────────────────────────────────────────┐
   a person ───▶ │  WEB / CONTROL      Next.js on Vercel        │
                 │  request-scoped, scales to zero, no loops    │
                 └───────────────────┬──────────────────────────┘
                                     │
                 ┌───────────────────▼──────────────────────────┐
                 │  DURABLE STATE     managed PostgreSQL        │
                 │  the only thing both other planes trust      │
                 └───────────────────┬──────────────────────────┘
                                     │
                 ┌───────────────────▼──────────────────────────┐
   the venue ◀── │  EXECUTION         long-running worker       │
                 │  container. Never a serverless function.     │
                 └──────────────────────────────────────────────┘
                                     ▲
                 ┌───────────────────┴──────────────────────────┐
                 │  IDENTITY / SIGNING   Privy                  │
                 │  holds the keys, so Rivo does not            │
                 └──────────────────────────────────────────────┘
```

**Why the worker is not on Vercel.** A trading cycle is not a request. It settles, claims,
reconciles and allocates on a clock that has nothing to do with anybody being logged in, and it has
to be able to run for hours holding a lease. A serverless function cannot do that, and the whole
promise of the product — configure once, close the browser — is that this keeps running when
nothing else is.

---

## 0. What you need

| | | required for |
|---|---|---|
| PostgreSQL 14+ | Neon, Supabase, Railway, RDS, or your own | web and worker |
| a Privy app | [dashboard.privy.io](https://dashboard.privy.io) | sign-in and signing |
| somewhere to run a container | Railway, Render, Fly, a VPS | the worker |
| a Vercel account | | the web app |

Nothing is needed for the CLI, the backtester, the evidence commands or the test suite. Those work
on a laptop with a checkout and `npm install`.

---

## 1. The database

```bash
export DATABASE_URL="postgres://user:password@host:5432/rivo"
npm run db:migrate
```

**The worker migrates on boot; the web app only checks.** Exactly one component may alter a schema,
or a deploy that starts both races itself. `/api/health` reports a pending migration rather than
failing mysteriously.

Migrations are plain SQL in `src/db/migrations/`, applied in filename order, each in its own
transaction, each checksummed. A file that changed after it was applied is refused rather than
silently ignored.

**On Supabase, pick the Session pooler.** Three connection strings are offered and two of them are
wrong for Rivo, in ways that fail quietly rather than loudly:

| offered | port | verdict |
|---|---|---|
| Transaction pooler | 6543 | **no.** `migrate()` takes `pg_advisory_lock` *outside* a transaction and holds it across the whole run (`src/db/migrate.ts:72`). In transaction mode each statement may land on a different backend, so the lock is not really held — and two workers can migrate at once, which is the exact thing it prevents. |
| Direct connection | 5432 | IPv6-only on new projects. Works from a laptop; Railway, Render and Fly are frequently IPv4-only, and the failure is a timeout that never mentions IPv6. |
| **Session pooler** | 5432 | **yes.** IPv4, and session state survives across statements. |

The session pooler's username is `postgres.<project-ref>`, not `postgres` — that difference is how you
know you copied the right one. Set `PGSSLMODE=no-verify` alongside it: Supabase serves TLS from a
chain a container often does not carry, and Rivo verifies by default.

Verified against a real Supabase project (PostgreSQL 17.6): both migrations apply, 12 tables, 31
indexes, and the append-only triggers refuse a DELETE, an intent rewrite, a hash replacement, a
status rollback and an edit to `decisions`.

Locally, with no Docker and no root:

```bash
npx tsx scripts/dev-postgres.ts start     # downloads a self-contained PostgreSQL 16
export DATABASE_URL="postgres://rivo@127.0.0.1:55432/rivo"
npm run db:migrate
```

---

## 2. Privy

Check what is missing before configuring anything, and again after:

```bash
npm run privy:check
```

It authenticates with the server's own credentials, reports which login methods the app actually has
enabled, catches the classic mistake of a browser and server pointed at two different apps, and
lists the dashboard steps Rivo cannot perform. It never signs anything and never touches a user's
wallet.

In the dashboard:

1. Create an app. Note the **App ID** and **App Secret**.
2. Enable **Email**, **Google** and **Wallet** login.
3. Enable **embedded wallets**, created for **all users** — including users who signed in with an
   external wallet, who are precisely the people who most want trading capital kept separate from
   their main wallet.
4. Add Somnia as a custom EVM chain: **50312** (testnet) and **5031** (mainnet).
5. **Register an authorization keypair.** With one, a stolen app secret alone cannot move a wallet.
6. Consider attaching a transaction policy. Rivo declares the policy it wants in `POLICY_INTENT`
   (`src/signing/privy.ts`); attaching it is your action, not Rivo's, and Rivo describes it as
   *requested* until it is.

---

## 3. The web app — Vercel

Import the repository. `vercel.json` at the root already sets the build:

```
buildCommand      npm run build:web
outputDirectory   web/.next
```

Environment variables:

```
DATABASE_URL              postgres://…
PGSSLMODE                 no-verify        # most managed providers
PRIVY_APP_ID              …
PRIVY_APP_SECRET          …                # server-side only, never NEXT_PUBLIC_
PRIVY_AUTHORIZATION_KEY   …                # if you registered one
NEXT_PUBLIC_PRIVY_APP_ID  …                # the id again, for the browser
NEXT_PUBLIC_NETWORK       testnet
NETWORK                   testnet
RIVO_DEMO_PORTFOLIO_ID    …                # optional: publishes ONE portfolio read-only at /demo
```

Without `PRIVY_APP_ID` and `PRIVY_APP_SECRET` the app still runs: users can sign in if
`NEXT_PUBLIC_PRIVY_APP_ID` is set, and every portfolio stays in Shadow Mode because nothing can
sign. That is the correct way for a missing credential to fail.

Check `/api/health` after deploying. It answers without authentication and reports whether the
database responds, whether the schema is current, and how many workers are alive.

### Connection budget — the arithmetic nobody does until it breaks

Every process opens its own pool of `DATABASE_POOL_MAX` (default 10). The
provider's ceiling is finite and smaller than people assume: a Supabase free
project reports **60**, with 3 reserved and around a dozen already in use by its
own services — so roughly **45 are yours**.

```
workers × DATABASE_POOL_MAX  +  concurrent web instances × DATABASE_POOL_MAX  ≤  budget
```

Three workers at the default is 30. Vercel is the half that surprises people: it
is not one process, it is as many as traffic creates, and each opens its own
pool. Three concurrent instances at the default is another 30, and 60 is the
whole ceiling.

So on Vercel set **`DATABASE_POOL_MAX=2`**. A request handler runs a handful of
queries and returns; it has nothing to do with a spare connection, and holding
ten of them starves the plane that actually needs them. Leave the worker at the
default — it runs up to eight portfolios at once and genuinely uses them.

Check what you are actually using:

```sql
select count(*) from pg_stat_activity;
select name, setting from pg_settings where name = 'max_connections';
```

---

## 4. The worker — a container that stays up

Same image as the CLI, pointed at a database:

```bash
docker build -t rivo .
docker run -d --restart unless-stopped \
  -e DATABASE_URL="postgres://…" \
  -e PRIVY_APP_ID="…" -e PRIVY_APP_SECRET="…" \
  -e NETWORK=testnet \
  -p 8080:8080 \
  rivo src/cli/worker.ts --interval 45 --concurrency 8
```

On Render, `render.yaml` at the repository root is a Blueprint: **New → Blueprint**, point it at the
repository, and it prompts for the secrets rather than reading them from the repo. On Railway or Fly
it is the same image and the same command, configured in their own dashboard.

Point the platform's health check at **`/ready`**, not `/health` — a worker that is up and has not
completed a pass in five minutes is not healthy in any sense a user would recognise. `render.yaml`
already does.

On a VPS: `deploy/rivo-worker.service`, which carries the systemd hardening a process that signs
transactions should have.

**Scaling.** Run more than one. Workers claim portfolios with a database lease
(`FOR UPDATE … SKIP LOCKED`), so more of them is more throughput, with no coordinator to configure
and no partition to rebalance — and never two on one portfolio.

```bash
docker compose --profile platform up -d --scale worker=3
```

**Without `PRIVY_APP_ID` / `PRIVY_APP_SECRET`, every portfolio runs in Shadow Mode.** It decides,
records and reports, and sends nothing. That is the correct way for a missing credential to fail.

---

## 5. Everything at once, locally

```bash
cp .env.example .env       # fill in POSTGRES_PASSWORD and the Privy values
docker compose --profile platform up -d
npm run dev:web            # the web app, on :3001
```

The web app is deliberately absent from compose. It belongs on Vercel, and running it under a
process supervisor beside a trading worker blurs the one boundary this architecture exists to keep.

---

## 6. Seeing it work without signing in

```bash
npm run seed:demo          # a user, a wallet, a portfolio — all Shadow Mode
npm run worker -- --once   # one pass against the live venue
```

The seeder cannot arm live trading: the wallet it creates has no Privy wallet id and is not
delegated, so `mayTradeLive` is false and the worker runs it dry whatever the flags say.

---

## 7. Operating it

| question | where |
|---|---|
| is the fleet alive? | `GET /health` on any worker, `workers` in `/api/health` |
| is it doing anything? | `GET /ready` — 503 if no pass in five minutes |
| why did it stop? | the `events` table; the dashboard's Events tab |
| what did it decide? | the `decisions` table; the dashboard's Decisions tab |
| what did it send? | the `executions` table — append-only, survives the position |
| prove all of it | `npm run proof -- --portfolio <id>` — four counts kept apart, every hash re-checked against the chain |
| the same, readable | `npm run report -- --portfolio <id>` — including what actually refuses this portfolio's trades |
| tell me when it breaks | `RIVO_ALERT_WEBHOOK` (Slack/Discord) or `RIVO_ALERT_TELEGRAM_*` |

**A halted portfolio does not restart itself.** A breaker that resets on its own is not a breaker.
Halting is recorded as an event, alerted, and shown at the top of the dashboard; resuming is a
person's decision.

---

## 8. Backups

The database is the product's memory: positions, the execution ledger, the decision log. Losing it
does not lose money — reconciliation rebuilds holdings from the chain at the next cycle — but it
does lose the record, and the record is most of what makes this auditable.

Use your provider's point-in-time recovery. The two tables that cannot be reconstructed from
anywhere else are `executions` and `decisions`.
