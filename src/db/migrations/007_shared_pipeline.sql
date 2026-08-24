-- What the shared pre-execution pipeline decided, on the shadow side.
--
-- Shadow used to record the agent's answer and nothing else: no market
-- eligibility, no venue lot, no risk ceiling, no strategy gate. So it could
-- write down a hypothetical trade that real Rivo would have refused — and a
-- shadow record of a trade that could not have happened is not weak evidence,
-- it is evidence pointing the wrong way.
--
-- Both paths run src/runtime/pipeline.ts now. These columns are what it said,
-- stored so a reader can group by it rather than parse a sentence:
--
--   intent_outcome   SKIP | REFUSED | EXECUTE
--   intent_stage     SCHEMA | ELIGIBILITY | POLICY | RISK | VENUE | INTENT
--   intent_code      NORMALIZED_SIZE_ZERO, BELOW_VENUE_MINIMUM, RISK_LIMIT, …
--   normalized_size  shares after the venue's lot, which is what would be sent
--
-- Nullable throughout: every row written before this migration was recorded
-- without a pipeline verdict, and inventing one for them would be a backfill
-- that asserts a check nobody ran.
ALTER TABLE shadow_decisions ADD COLUMN IF NOT EXISTS intent_outcome  text;
ALTER TABLE shadow_decisions ADD COLUMN IF NOT EXISTS intent_stage    text;
ALTER TABLE shadow_decisions ADD COLUMN IF NOT EXISTS intent_code     text;
ALTER TABLE shadow_decisions ADD COLUMN IF NOT EXISTS normalized_size numeric(30,10);

-- Grouping refusals by cause is the query the evidence surface runs.
CREATE INDEX IF NOT EXISTS shadow_intent ON shadow_decisions (agent_id, intent_outcome, decided_at DESC);

-- The same verdict, on the real side.
--
-- A size that rounded to zero at the venue's lot arrived here as an execution
-- FAILURE, indistinguishable in the counts from a transaction that actually
-- reverted on Somnia. The totals said the system was failing constantly; what
-- it had done was decline, deterministically and correctly, before sending
-- anything. Cleaner evidence, not hidden errors: a genuine revert still
-- records as failed.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS code text;
