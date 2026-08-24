-- Which agent a deployment is running.
--
-- Without this there is no way to scope evidence to a run. The proof endpoint
-- was counting every shadow decision from every agent and presenting the total
-- inside a portfolio-specific object — so a reader looking at one deployment saw
-- another agent's numbers attributed to it. That is not an impressive statistic,
-- it is a wrong one, and evidence integrity is the whole product.
--
-- Nullable, because every portfolio that exists today predates agents and runs
-- the built-in model. A null means "the built-in reference agent", which is
-- true, rather than a backfill that would assert a link nobody made.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS portfolios_agent ON portfolios (agent_id);

-- Attach the existing portfolios to the agent they have in fact been running:
-- Rivo V1 is the model behind every decision the engine has ever recorded.
UPDATE portfolios
   SET agent_id = (SELECT id FROM agents WHERE slug = 'rivo-v1')
 WHERE agent_id IS NULL;

-- Scope a shadow decision to a deployment as well as to an agent.
--
-- An agent can run in more than one place — a shadow deployment and an
-- experimental testnet deployment at the same time — and the whole point of the
-- Proof surface is that a reader can tell which run produced which evidence.
ALTER TABLE shadow_decisions ADD COLUMN IF NOT EXISTS portfolio_id uuid REFERENCES portfolios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS shadow_portfolio ON shadow_decisions (portfolio_id, decided_at DESC);
