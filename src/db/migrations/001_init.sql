-- Rivo's durable state.
--
-- Four rules this schema exists to enforce, rather than describe:
--
--   1. ISOLATION. Every row that belongs to a portfolio carries `portfolio_id`
--      and cascades from it. There is no table a query can reach without naming
--      whose portfolio it is asking about.
--   2. PERMANENCE. `executions` is the transaction record. Rows may move forward
--      through their state machine and may never be deleted or rewritten — see
--      the trigger at the bottom, which is the actual guarantee. The file-based
--      predecessor kept a tx hash on the OPEN position and dropped it when the
--      position closed, so a finished portfolio could show 208 positions and ten
--      hashes. That is the defect this table exists to make impossible.
--   3. IDEMPOTENCY. `executions.idempotency_key` is unique per portfolio. An
--      intent is written BEFORE anything is signed, so a crash mid-flight leaves
--      a row to recover against rather than a silence to guess at.
--   4. SINGLE WRITER. `portfolio_leases` is the lock. One row per portfolio, a
--      fencing token that only ever increases, and an expiry so a dead worker
--      releases what it was holding without anyone intervening.

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Privy's decentralised identifier. The only identity Rivo stores; there is
  -- no password, no session secret and no key of the user's here.
  privy_did    text NOT NULL UNIQUE,
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Wallets a user has. Two kinds, and the distinction matters to the product:
--
--   portfolio — the Privy wallet Rivo trades. Delegated, revocable, and the only
--               one Rivo ever asks to sign.
--   external  — a wallet the user connected for identity or funding. Rivo reads
--               its balance and never asks it for anything else.
CREATE TABLE wallets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address         text NOT NULL,
  -- Privy's id for the wallet. Required to sign; null for an external wallet,
  -- which is exactly the shape of "Rivo cannot ask this one for a signature".
  privy_wallet_id text,
  kind            text NOT NULL CHECK (kind IN ('portfolio', 'external')),
  chain_type      text NOT NULL DEFAULT 'ethereum',
  -- Whether the user has granted Rivo server-side signing authority over this
  -- wallet, and when. Revoking sets `delegated` false and is what switches
  -- Autopilot off for real rather than in the UI only.
  delegated       boolean NOT NULL DEFAULT false,
  delegated_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (address = lower(address)),
  CHECK (kind <> 'portfolio' OR privy_wallet_id IS NOT NULL),
  UNIQUE (user_id, address)
);
CREATE INDEX wallets_user ON wallets(user_id);
CREATE UNIQUE INDEX wallets_address_portfolio ON wallets(address) WHERE kind = 'portfolio';

-- A portfolio is the unit of everything: capital, risk, isolation, scheduling.
-- `policy` holds the same PortfolioPolicy overrides the engine already reads, so
-- the risk layer needs no knowledge that a database exists.
CREATE TABLE portfolios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id      uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  network        text NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  capital        numeric(30,10) NOT NULL CHECK (capital >= 0),
  profile        text NOT NULL CHECK (profile IN ('conservative', 'balanced', 'active')),
  mode           text NOT NULL CHECK (mode IN ('shadow', 'autopilot')),
  state          text NOT NULL CHECK (state IN ('idle', 'running', 'paused', 'stopped', 'halted')),
  overrides      jsonb NOT NULL DEFAULT '{}'::jsonb,
  stopped_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- When the scheduler should next consider this portfolio. Indexed, because
  -- "which portfolios are due" is the query the whole fleet runs.
  next_run_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portfolios_user ON portfolios(user_id);
CREATE INDEX portfolios_due ON portfolios(next_run_at) WHERE state = 'running';

-- The mutable half of RivoState. Positions live in their own table; this is
-- everything else the cycle carries between passes.
--
-- One row per portfolio, created with it. `version` is an optimistic-concurrency
-- counter: a writer that read version N may only write version N+1, so two
-- workers that somehow bypassed the lease still cannot silently interleave.
CREATE TABLE portfolio_runtime (
  portfolio_id        uuid PRIMARY KEY REFERENCES portfolios(id) ON DELETE CASCADE,
  cash                numeric(30,10) NOT NULL DEFAULT 0,
  realized_pnl        numeric(30,10) NOT NULL DEFAULT 0,
  -- Value of positions ADOPTED from the chain that Rivo never bought. Kept apart
  -- from capital on purpose: folding it in would let a stray token found on the
  -- wallet quietly raise Rivo's own risk limits.
  contributed         numeric(30,10) NOT NULL DEFAULT 0,
  cycles              bigint NOT NULL DEFAULT 0,
  peak_equity         numeric(30,10) NOT NULL DEFAULT 0,
  halted              text,
  dry_run             boolean NOT NULL DEFAULT true,
  -- The account this portfolio was actually traded from, learned on the first
  -- live cycle. Without it, anything reading the record afterwards has to assume
  -- the wallet configured NOW is the wallet that produced THEN.
  traded_by           text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  last_cycle_at       timestamptz,
  last_claim_sweep_at timestamptz,
  -- Cooldown and failure bookkeeping, keyed `marketId:leg`. Small, hot, and
  -- meaningless outside a cycle, so it stays denormalised rather than becoming
  -- two more tables the scheduler would have to join.
  leg_state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  version             bigint NOT NULL DEFAULT 0
);

CREATE TABLE positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id    uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  market_id       text NOT NULL,
  asset           text NOT NULL CHECK (asset IN ('BTC', 'ETH')),
  interval_sec    integer NOT NULL,
  leg             text NOT NULL CHECK (leg IN ('UP', 'DOWN')),
  shares          numeric(30,10) NOT NULL,
  entry_price     numeric(30,10) NOT NULL,
  cost            numeric(30,10) NOT NULL,
  fair_at_entry   numeric(30,10) NOT NULL,
  delta_per_share numeric(30,10) NOT NULL DEFAULT 0,
  expiry          timestamptz NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- Set when the position was found on-chain rather than opened by Rivo. Its
  -- entry price is an ESTIMATE — nothing on-chain records what was paid — and
  -- every report that touches it has to say so.
  adopted         boolean NOT NULL DEFAULT false,
  closed_at       timestamptz,
  won             boolean,
  proceeds        numeric(30,10),
  -- 'dropped' is not the same as 'voided'. A voided market paid nobody; a
  -- dropped position is one RECONCILIATION removed because the chain says the
  -- wallet never held it. Collapsing the two would hide the only signal that
  -- local state and the chain had diverged.
  exit            text CHECK (exit IN ('settled', 'sold', 'merged', 'voided', 'dropped')),
  CHECK (status = 'open' OR closed_at IS NOT NULL)
);
-- One open position per leg per portfolio. The engine already assumes this; the
-- database is where the assumption becomes true.
CREATE UNIQUE INDEX positions_open_leg ON positions(portfolio_id, market_id, leg) WHERE status = 'open';
CREATE INDEX positions_portfolio ON positions(portfolio_id, status);
CREATE INDEX positions_expiry ON positions(expiry) WHERE status = 'open';

-- THE EXECUTION LEDGER.
--
-- Every action that touches the chain gets a row here BEFORE it is signed, and
-- that row is never deleted. A closed position is traceable to the executions
-- that opened and ended it, because those rows outlive it.
--
-- The status column is a state machine, and the order is the whole point:
--
--   intended  -> row written, nothing signed. A crash here costs nothing.
--   submitted -> handed to the chain, tx hash recorded. A crash here is the
--                dangerous one, and is exactly what recovery reads.
--   confirmed -> receipt seen, fill known.
--   failed    -> reverted, rejected, or abandoned, with the reason.
--   orphaned  -> submitted, and no receipt could be found within the recovery
--                window. Deliberately NOT 'failed': we do not know that it
--                failed, and saying so would be a guess in the direction that
--                causes a duplicate trade.
CREATE TABLE executions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id     uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  -- Derived from (portfolio, market, leg, action, cycle) by the caller. Unique,
  -- so a retry after an ambiguous crash collides instead of double-spending.
  idempotency_key  text NOT NULL,
  cycle            bigint NOT NULL DEFAULT 0,
  market_id        text NOT NULL,
  action           text NOT NULL CHECK (action IN ('BUY', 'SELL', 'REDUCE', 'EXIT', 'CLAIM', 'MINT_SET', 'MERGE_SET', 'APPROVE', 'CANCEL')),
  leg              text CHECK (leg IN ('UP', 'DOWN')),
  requested_qty    numeric(30,10),
  requested_price  numeric(30,10),
  filled_qty       numeric(30,10),
  filled_price     numeric(30,10),
  cost             numeric(30,10),
  tx_hash          text,
  block_number     bigint,
  status           text NOT NULL CHECK (status IN ('intended', 'submitted', 'confirmed', 'failed', 'orphaned')),
  error            text,
  -- Free-form provenance the ledger should keep but nothing queries on: the
  -- pool that was approved, the order id that rested, the reason a size moved.
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  confirmed_at     timestamptz,
  UNIQUE (portfolio_id, idempotency_key)
);
CREATE INDEX executions_portfolio ON executions(portfolio_id, created_at DESC);
CREATE INDEX executions_open ON executions(portfolio_id) WHERE status IN ('intended', 'submitted');
CREATE INDEX executions_tx ON executions(tx_hash) WHERE tx_hash IS NOT NULL;

-- Which executions produced which position. A position can be opened by one
-- execution and ended by several (a reduce, then an exit, then a claim), so the
-- relation is many-to-many and lives in its own table rather than as a column
-- that could only ever hold the last one.
CREATE TABLE position_executions (
  position_id  uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  role         text NOT NULL CHECK (role IN ('open', 'increase', 'reduce', 'close', 'claim')),
  PRIMARY KEY (position_id, execution_id, role)
);

-- The forward-test record: every leg considered, priced, and accepted or
-- refused, with the constraint that bound. This is not diagnostics — it is the
-- evidence that the portfolio layer behaves the way the backtest says it does,
-- on data nobody could have fitted to.
CREATE TABLE decisions (
  id           bigserial PRIMARY KEY,
  portfolio_id uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  cycle        bigint NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  market_id    text NOT NULL,
  asset        text NOT NULL,
  interval_sec integer NOT NULL,
  leg          text NOT NULL,
  action       text NOT NULL,
  fair         numeric(30,10),
  ask          numeric(30,10),
  edge         numeric(30,10),
  shares       numeric(30,10),
  cost         numeric(30,10),
  binding      text NOT NULL
);
CREATE INDEX decisions_portfolio ON decisions(portfolio_id, at DESC);
CREATE INDEX decisions_cycle ON decisions(portfolio_id, cycle);

-- Anything an operator or a user should be told about: a breaker firing, a
-- reconciliation mismatch, a claim that would not settle, a run of RPC errors.
-- Normal SKIP decisions are NOT events; they are decisions, above.
CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  portfolio_id uuid REFERENCES portfolios(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  message      text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set once an alert for this event has actually been delivered, so a restart
  -- does not re-send every warning the portfolio has ever produced.
  notified_at  timestamptz
);
CREATE INDEX events_portfolio ON events(portfolio_id, at DESC);
CREATE INDEX events_undelivered ON events(at) WHERE notified_at IS NULL AND severity <> 'info';

-- The fleet. A worker announces itself and heartbeats; a worker whose heartbeat
-- has gone stale is treated as gone, and its leases expire on their own.
CREATE TABLE workers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname          text NOT NULL,
  pid               integer NOT NULL,
  version           text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  cycles            bigint NOT NULL DEFAULT 0,
  note              text
);
CREATE INDEX workers_heartbeat ON workers(last_heartbeat_at DESC);

-- THE LOCK.
--
-- One row per portfolio. Acquiring is a conditional UPDATE, so two workers
-- racing produce one winner and one zero-row result rather than two owners.
--
-- `fence` only ever increases. A worker that stalls past its expiry, loses the
-- lease, and then wakes up still believing it holds one will present a fence
-- lower than the current holder's, and every write it attempts is rejected. That
-- is the difference between a lease and a lock you hope nobody outlived.
CREATE TABLE portfolio_leases (
  portfolio_id uuid PRIMARY KEY REFERENCES portfolios(id) ON DELETE CASCADE,
  worker_id    uuid REFERENCES workers(id) ON DELETE SET NULL,
  fence        bigint NOT NULL DEFAULT 0,
  acquired_at  timestamptz,
  expires_at   timestamptz,
  released_at  timestamptz
);
CREATE INDEX leases_expiry ON portfolio_leases(expires_at) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- The append-only guarantee, enforced rather than promised.
-- ---------------------------------------------------------------------------
--
-- Application code is not what makes a ledger permanent — the ledger's own rules
-- are. A DELETE is refused outright. An UPDATE may only move `status` forward
-- along the state machine and may not touch anything that describes what was
-- INTENDED, because rewriting the intent is how a record stops being evidence.
CREATE FUNCTION executions_append_only() RETURNS trigger AS $$
DECLARE
  rank_old int;
  rank_new int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- One deliberate exception, and it is a legal one rather than a convenience.
    --
    -- A user may ask for their account to be erased, and honouring that means
    -- the cascade from `users` has to reach this table. So the rule is not "no
    -- deletes ever" — it is "no deletes except inside an erasure a caller has
    -- explicitly declared". `SET LOCAL rivo.erase = 'on'` lasts exactly one
    -- transaction, so the exception cannot leak into the next statement, and it
    -- appears in the code that performs the erasure rather than nowhere.
    IF current_setting('rivo.erase', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'executions is append-only: row % cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.portfolio_id    IS DISTINCT FROM NEW.portfolio_id
  OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
  OR OLD.market_id       IS DISTINCT FROM NEW.market_id
  OR OLD.action          IS DISTINCT FROM NEW.action
  OR OLD.leg             IS DISTINCT FROM NEW.leg
  OR OLD.requested_qty   IS DISTINCT FROM NEW.requested_qty
  OR OLD.requested_price IS DISTINCT FROM NEW.requested_price
  OR OLD.created_at      IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'executions is append-only: the intent of row % cannot be rewritten', OLD.id;
  END IF;

  -- A recorded tx hash is a fact about the chain. It may be filled in once; it
  -- may not be changed into a different one.
  IF OLD.tx_hash IS NOT NULL AND OLD.tx_hash IS DISTINCT FROM NEW.tx_hash THEN
    RAISE EXCEPTION 'executions is append-only: row % already recorded tx %', OLD.id, OLD.tx_hash;
  END IF;

  rank_old := CASE OLD.status WHEN 'intended' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END;
  rank_new := CASE NEW.status WHEN 'intended' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END;
  IF rank_new < rank_old THEN
    RAISE EXCEPTION 'executions is append-only: row % cannot go from % back to %', OLD.id, OLD.status, NEW.status;
  END IF;
  -- Terminal is terminal. 'orphaned' is the one exception: it is an admission of
  -- ignorance, and finding the receipt later must be allowed to resolve it.
  IF rank_old = 2 AND OLD.status <> 'orphaned' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'executions is append-only: row % is already %', OLD.id, OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER executions_append_only
  BEFORE UPDATE OR DELETE ON executions
  FOR EACH ROW EXECUTE FUNCTION executions_append_only();

-- Decisions are the forward-test record. Same reasoning, simpler rule: they are
-- written once and never touched again.
CREATE FUNCTION decisions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('rivo.erase', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'decisions is append-only: row % cannot be % ', OLD.id, lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decisions_immutable
  BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_immutable();
