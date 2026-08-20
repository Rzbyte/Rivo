// Risk profiles.
//
// These are not a size multiplier wearing three hats. Each profile changes WHICH
// constraint binds first, so the same market can be a full position under one and
// no position under another for reasons that have nothing to do with scaling:
// Conservative refuses concentration Active is happy to hold, and Active will
// cross a spread Conservative will not.

export type ProfileName = "conservative" | "balanced" | "active";

export interface RiskProfile {
  name: ProfileName;
  /**
   * Fractional-Kelly multiplier.
   *
   * Full Kelly maximises long-run growth and is far too violent to run
   * unattended: it assumes the probability is exactly right, and ours is a model.
   * The calibration study found the model needs no shrinking out of sample, so
   * this multiplier is the ONLY haircut between the forecast and the position —
   * which is precisely why it should be well under 1.
   */
  kellyFraction: number;
  /** Ceiling on capital deployed at once, as a fraction of total. */
  maxDeployed: number;
  /** Ceiling on one leg, as a fraction of total capital. */
  maxPerPosition: number;
  /**
   * Ceiling on directional exposure to one underlying, expressed as collateral
   * lost per 1% adverse move, as a fraction of total capital. This is the limit
   * that makes two tenors of the same bet count as one bet.
   */
  maxAssetDeltaPer1Pct: number;
  /** Same, for BTC and ETH combined through their measured correlation. */
  maxCombinedDeltaPer1Pct: number;
  /** Ceiling on capital settling inside one expiry bucket, as a fraction of total. */
  maxPerExpiryBucket: number;
  /** Minimum edge per share before crossing a spread is worth it. */
  minEdge: number;
  /** Cash never deployed, as a fraction of total. */
  cashFloor: number;
  /**
   * How much better a replacement must be before rotating out of a held leg.
   *
   * Rotation is exit-then-enter — there is no atomic primitive — so it pays the
   * spread twice. The kit measures that round trip at ~0.024 on a 2-cent book.
   * A band below that cost turns a positive-expectancy portfolio into a machine
   * for donating spread.
   */
  rotationHysteresis: number;
  /**
   * Optional ceiling on capital in one CADENCE, keyed by interval seconds, as a
   * fraction of total capital.
   *
   * Absent from every built-in profile on purpose: it exists for a user who has
   * a view about horizons rather than about risk appetite — "15-minute windows
   * are noise, cap them at 5%" — which is not something a three-way risk dial
   * can express. Set through PortfolioPolicy.overrides; see policy.ts.
   *
   * Distinct from maxPerExpiryBucket, which groups whatever settles at the same
   * moment regardless of cadence.
   */
  maxPerTenor?: Record<number, number>;
}

export const PROFILES: Record<ProfileName, RiskProfile> = {
  conservative: {
    name: "conservative",
    kellyFraction: 0.25,
    maxDeployed: 0.4,
    maxPerPosition: 0.1,
    maxAssetDeltaPer1Pct: 0.02,
    maxCombinedDeltaPer1Pct: 0.025,
    maxPerExpiryBucket: 0.15,
    minEdge: 0.05,
    cashFloor: 0.6,
    rotationHysteresis: 0.05,
  },
  balanced: {
    name: "balanced",
    kellyFraction: 0.5,
    maxDeployed: 0.7,
    maxPerPosition: 0.2,
    maxAssetDeltaPer1Pct: 0.05,
    maxCombinedDeltaPer1Pct: 0.06,
    maxPerExpiryBucket: 0.3,
    minEdge: 0.03,
    cashFloor: 0.3,
    rotationHysteresis: 0.035,
  },
  active: {
    name: "active",
    kellyFraction: 1.0,
    maxDeployed: 0.9,
    maxPerPosition: 0.35,
    maxAssetDeltaPer1Pct: 0.12,
    maxCombinedDeltaPer1Pct: 0.15,
    maxPerExpiryBucket: 0.5,
    minEdge: 0.02,
    cashFloor: 0.1,
    rotationHysteresis: 0.025,
  },
};

export function profile(name: string | undefined): RiskProfile {
  const key = (name ?? "balanced").toLowerCase() as ProfileName;
  return PROFILES[key] ?? PROFILES.balanced;
}
