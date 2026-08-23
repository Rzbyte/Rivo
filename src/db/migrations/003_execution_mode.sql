-- Execution mode replaces the Autopilot boolean.
--
-- `mode` had two values, and the pair could not express the thing this
-- deployment actually needs: run a strategy that FAILED economic validation
-- against a testnet, deliberately, for research — without that ever being one
-- flag away from doing the same to real money. Three named modes can:
--
--   shadow                decide and record, spend nothing
--   experimental_testnet  spend, on an approved testnet, on a strategy that is
--                         not validated, because somebody chose that explicitly
--   validated_autopilot   spend, anywhere, only behind a VALIDATED strategy
--
-- THE MIGRATION OF EXISTING ROWS IS THE PART THAT MATTERS.
--
-- Every existing `autopilot` row was written by a build that had no idea
-- whether the strategy it was running had ever been shown to make money — the
-- verdict existed, in docs/ALPHA-RESEARCH.md, and nothing on the execution path
-- read it. Mapping those rows to `validated_autopilot` would take a permission
-- granted under one meaning and silently reissue it under a stronger one.
--
-- So they become `shadow`, and their owners re-enable deliberately. That stops
-- live portfolios mid-flight, which is the correct cost: a portfolio that stops
-- trading until somebody clicks is recoverable, and a portfolio that keeps
-- trading under a permission nobody actually gave is not.
--
-- The previous value is kept, per row, so the UI can say what happened rather
-- than presenting a portfolio that mysteriously went quiet.

ALTER TABLE portfolios DROP CONSTRAINT IF EXISTS portfolios_mode_check;

-- Remember what the row said before this migration touched it. Null for rows
-- created afterwards, which is how "was never migrated" stays distinguishable
-- from "was migrated from shadow".
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS mode_before_migration text;

UPDATE portfolios
   SET mode_before_migration = 'autopilot',
       mode = 'shadow',
       updated_at = now()
 WHERE mode = 'autopilot';

ALTER TABLE portfolios
  ADD CONSTRAINT portfolios_mode_check
  CHECK (mode IN ('shadow', 'experimental_testnet', 'validated_autopilot'));

-- An audit line per demoted portfolio, in the table the UI already reads, so
-- the owner is told why rather than left to notice.
INSERT INTO events (portfolio_id, kind, severity, message, data)
SELECT id,
       'autopilot.demoted',
       'warn',
       'Autopilot was switched off by an upgrade. Rivo now checks whether a strategy has passed '
       || 'economic validation before it may spend, and the strategy running here has not. Re-enable '
       || 'it as Experimental Testnet to keep trading test funds, or leave it in Shadow Mode.',
       jsonb_build_object('from', 'autopilot', 'to', 'shadow', 'migration', '003_execution_mode')
  FROM portfolios
 WHERE mode_before_migration = 'autopilot';
