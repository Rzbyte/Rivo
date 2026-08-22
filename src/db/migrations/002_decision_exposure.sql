-- What the decision cost in correlated exposure, not just in collateral.
--
-- The decision log already records WHY a leg was refused — the binding
-- constraint, in words. What it could not show is the arithmetic behind the most
-- important refusal Rivo makes: that a second positive-edge window on the same
-- underlying would push correlated exposure past its budget.
--
-- Without these three numbers the product's central claim is a sentence a user
-- has to take on trust. With them it is a meter: "BTC exposure 1.80 → 2.50 of a
-- 2.50 budget" beside a leg that was refused, in the same cycle as the leg that
-- was taken.
--
-- Nullable, because a decision reached before the delta budget was consulted —
-- a leg with no offer, a window inside its expiry headroom — genuinely has no
-- exposure arithmetic to report, and zero would be a lie about that.
ALTER TABLE decisions
  ADD COLUMN exposure_before numeric(30,10),
  ADD COLUMN exposure_after  numeric(30,10),
  ADD COLUMN exposure_cap    numeric(30,10);

COMMENT ON COLUMN decisions.exposure_before IS
  'Signed collateral-per-1% exposure to this leg''s underlying, across every tenor, before this decision.';
COMMENT ON COLUMN decisions.exposure_after IS
  'The same figure after it — equal to exposure_before for a refusal, which is the point.';
COMMENT ON COLUMN decisions.exposure_cap IS
  'The portfolio''s budget for that underlying at the time, in the same units.';
