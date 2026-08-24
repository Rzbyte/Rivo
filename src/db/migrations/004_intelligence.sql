-- Event intelligence and agent validation.
--
-- Three concepts the existing schema genuinely does not cover, and nothing more.
-- `decisions`, `executions`, `positions` and `events` already describe what a
-- deployed portfolio did; duplicating them under new names would give the
-- product two records of the same fact and a future argument about which one is
-- true.
--
--   calibration_reports  a computed answer to "is 67% actually 67%", cached
--   agents               who is being validated, and what state that leaves them in
--   shadow_decisions     what an agent WOULD have done, and what then happened

-- Calibration is expensive: it reads a month of fills across every settled
-- window, which is a background job's work and not a page load's. The whole
-- report is stored as one document because it is consumed as one — every bucket
-- in it shares a sampling basis, a date range and a methodology, and a bucket
-- read apart from those is a number without a claim attached.
CREATE TABLE calibration_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network      text NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  -- What the report is ABOUT: null scope means every asset and tenor.
  asset        text,
  interval_sec integer,
  -- 'window' = one observation per settled contract. 'snapshot' = one per fill,
  -- which is correlated and must be labelled as such wherever it is shown.
  basis        text NOT NULL CHECK (basis IN ('window', 'snapshot')),
  observations integer NOT NULL CHECK (observations >= 0),
  windows      integer NOT NULL CHECK (windows >= 0),
  period_from  timestamptz NOT NULL,
  period_to    timestamptz NOT NULL,
  brier        numeric(12,8) NOT NULL,
  skill        numeric(12,8) NOT NULL,
  report       jsonb NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);
-- "The current report for this scope" is the only query the product runs.
CREATE INDEX calibration_current
  ON calibration_reports (network, asset, interval_sec, basis, computed_at DESC);

-- An agent is a thing that produces decisions and has a standing.
--
-- `state` is the same vocabulary the execution gate reads, deliberately: a
-- product that showed one word and enforced another would be worse than one
-- that showed nothing.
CREATE TABLE agents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  label        text NOT NULL,
  -- 'builtin' is Rivo's own model. 'http' is somebody else's, reached over a
  -- typed endpoint — never uploaded code, which is a sandbox problem this
  -- product has no reason to take on.
  kind         text NOT NULL CHECK (kind IN ('builtin', 'http')),
  endpoint     text,
  owner_user   uuid REFERENCES users(id) ON DELETE CASCADE,
  state        text NOT NULL CHECK (state IN ('UNVALIDATED', 'SHADOW_ONLY', 'VALIDATED', 'REJECTED')),
  -- Where the verdict came from. A state without evidence is an assertion.
  evidence     text,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- An HTTP agent without an endpoint cannot be asked anything.
  CONSTRAINT agents_endpoint_required CHECK (kind <> 'http' OR endpoint IS NOT NULL)
);
CREATE INDEX agents_owner ON agents (owner_user);

-- What an agent would have done, and what then happened.
--
-- Kept apart from `decisions` because they answer different questions and a
-- reader must never have to work out which one they are looking at: a row here
-- NEVER moved capital, and a row there records a portfolio that might have.
-- Mixing them is how "hypothetical P&L" ends up quoted as a result.
CREATE TABLE shadow_decisions (
  id             bigserial PRIMARY KEY,
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  market_id      text NOT NULL,
  asset          text NOT NULL,
  leg            text NOT NULL CHECK (leg IN ('UP', 'DOWN')),
  interval_sec   integer NOT NULL,
  expiry         timestamptz NOT NULL,
  decided_at     timestamptz NOT NULL DEFAULT now(),

  -- What the venue said at the moment of the decision.
  market_price   numeric(12,8) NOT NULL CHECK (market_price >= 0 AND market_price <= 1),
  -- What the agent said. Null when it declined to have an opinion.
  agent_price    numeric(12,8) CHECK (agent_price IS NULL OR (agent_price >= 0 AND agent_price <= 1)),
  confidence     numeric(12,8),
  action         text NOT NULL,
  reason         text,

  -- The trade it did NOT place. Named `hypothetical_` throughout so no query
  -- can select it into a report that reads as executed.
  hypothetical_size  numeric(30,10),
  hypothetical_entry numeric(12,8),

  -- Filled in when the contract settles, by the same reconciler that resolves
  -- real positions. Null means not yet settled, which is different from zero.
  settled_at     timestamptz,
  outcome        smallint CHECK (outcome IN (0, 1)),
  hypothetical_pnl numeric(30,10),

  CONSTRAINT shadow_settled_together CHECK (
    (settled_at IS NULL AND outcome IS NULL) OR (settled_at IS NOT NULL AND outcome IS NOT NULL)
  )
);
CREATE INDEX shadow_agent ON shadow_decisions (agent_id, decided_at DESC);
-- The resolver's query: everything past expiry that has not been settled yet.
CREATE INDEX shadow_unsettled ON shadow_decisions (expiry) WHERE settled_at IS NULL;

-- Rivo V1 as its own first case study, with the verdict the research produced.
INSERT INTO agents (slug, label, kind, state, evidence, summary)
VALUES (
  'rivo-v1',
  'Rivo V1 · Diffusion Taker',
  'builtin',
  'REJECTED',
  'docs/ALPHA-RESEARCH.md',
  jsonb_build_object(
    'auc', 0.8158,
    'returnOnStake', -0.0649,
    'tStat', -0.5,
    'note', 'Predictive accuracy is not sufficient for live-capital deployment. This strategy failed out-of-sample economic validation.'
  )
)
ON CONFLICT (slug) DO NOTHING;
