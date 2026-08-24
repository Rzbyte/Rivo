// One user's portfolio policy.
//
// Rivo is a platform, not a bot with a config file: two people pointing it at
// the same venue on the same afternoon should get genuinely different portfolios,
// because they told it different things about what they are willing to hold.
//
// A policy is a named risk profile plus that user's overrides, and it resolves
// into the very `RiskProfile` the allocator consumes. That is the important
// property. If the UI carried its own idea of "capital" and "limits" and the
// engine carried another, the "why this allocation?" panel would eventually
// explain a constraint that was not the one that bound — which is worse than
// showing nothing, because it looks like evidence.
//
// This module is deliberately free of I/O and of Node builtins: the browser runs
// Shadow Mode against it, and the backend runs Autopilot against it, and neither
// is allowed a private copy.
//
// ISOLATION. A policy is keyed by wallet address, and every number in it is
// scoped to that key. Nothing here is global, so one backend process can hold
// many policies at once without them seeing each other. That is why the shape is
// a value rather than module state — no user needs their own machine.

import { PROFILES, profile as baseProfile, type ProfileName, type RiskProfile } from "./profiles.js";
import { TRADEABLE_CADENCES, tenorLabel } from "../core/venue.js";

/**
 * How autonomously Rivo is allowed to act for this user.
 *
 * Three modes rather than the `shadow | autopilot` pair this used to be. The
 * pair could not express the case this deployment actually has — run a strategy
 * that FAILED economic validation, against a testnet, deliberately — without
 * that being one flag away from doing it to real money. The semantics live in
 * `runtime/permission.ts`; this is the same union under the name the policy has
 * always used.
 */
export type { ExecutionMode as RunMode } from "../runtime/permission.js";
import type { ExecutionMode } from "../runtime/permission.js";
import { isExecutionMode } from "../runtime/permission.js";

/** Where a portfolio is in its lifecycle. Pause and stop differ, see `RunState`. */
export type RunState = "idle" | "running" | "paused" | "stopped" | "halted";

/**
 * Optional limits a user may tighten beyond their profile.
 *
 * Every field is a TIGHTENING only — `resolvePolicy` takes the stricter of the
 * profile and the override. A UI that could loosen a Conservative profile into
 * Active limits while still displaying "Conservative" would make the label
 * meaningless, and the label is what the user is actually choosing.
 */
export interface PolicyOverrides {
  /** Ceiling on deployed capital, as a fraction of allocated. */
  maxDeployed?: number;
  /** Ceiling on one leg, as a fraction of allocated. */
  maxPerPosition?: number;
  /** Per-underlying delta ceiling, collateral per 1% move, as a fraction of allocated. */
  maxAssetDeltaPer1Pct?: number;
  /** Combined BTC+ETH delta ceiling through rho. */
  maxCombinedDeltaPer1Pct?: number;
  /** Ceiling on capital settling in one 15-minute expiry bucket. */
  maxPerExpiryBucket?: number;
  /** Minimum edge per share before crossing a spread. */
  minEdge?: number;
  /** Cash never deployed, as a fraction of allocated. */
  cashFloor?: number;
  /**
   * Per-tenor ceilings, keyed by cadence in seconds, as a fraction of allocated.
   *
   * Distinct from the expiry bucket, which groups whatever happens to settle at
   * the same moment. This is a view about the horizon itself — a user who thinks
   * 15-minute windows are noise can cap them without touching anything else.
   */
  maxPerTenor?: Partial<Record<number, number>>;
}

export interface PortfolioPolicy {
  /** The wallet this portfolio belongs to. Lowercase, and the isolation key. */
  owner: `0x${string}`;
  /** Collateral the user has committed to Rivo. */
  capital: number;
  profile: ProfileName;
  mode: ExecutionMode;
  state: RunState;
  overrides: PolicyOverrides;
  /** Unix seconds. */
  createdAt: number;
  updatedAt: number;
  /** Set when a breaker or the user stopped it, for display. */
  stoppedReason?: string;
}

// A `POLICY_VERSION = 1` lived here and was never written anywhere or compared
// to anything. The schema does have a version — `portfolios.version`, the
// optimistic-concurrency counter in 001_init.sql — and a second, unrelated
// notion of "version" beside a real one is worse than none: it reads as though
// policies are versioned when nothing versions them.

export function newPolicy(owner: string, capital: number, profile: ProfileName, mode: ExecutionMode = "shadow"): PortfolioPolicy {
  const now = Math.floor(Date.now() / 1000);
  return {
    owner: owner.toLowerCase() as `0x${string}`,
    capital,
    profile,
    mode,
    state: "idle",
    overrides: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Take the stricter of two ceilings, ignoring an override that is absent or not a number. */
const tighter = (base: number, override: number | undefined): number =>
  typeof override === "number" && Number.isFinite(override) ? Math.min(base, override) : base;

/** Take the stricter of two FLOORS — for minEdge and cashFloor, stricter means larger. */
const higher = (base: number, override: number | undefined): number =>
  typeof override === "number" && Number.isFinite(override) ? Math.max(base, override) : base;

/**
 * The `RiskProfile` the allocator should run under for this user.
 *
 * This is the only bridge between what a user chose and what the engine enforces,
 * which is why it is a pure function of the policy: the same policy always
 * resolves to the same constraints, so a decision can be replayed and audited
 * long after the fact.
 */
export function resolvePolicy(policy: PortfolioPolicy): RiskProfile {
  const base = baseProfile(policy.profile);
  const o = policy.overrides;
  return {
    ...base,
    maxDeployed: tighter(base.maxDeployed, o.maxDeployed),
    maxPerPosition: tighter(base.maxPerPosition, o.maxPerPosition),
    maxAssetDeltaPer1Pct: tighter(base.maxAssetDeltaPer1Pct, o.maxAssetDeltaPer1Pct),
    maxCombinedDeltaPer1Pct: tighter(base.maxCombinedDeltaPer1Pct, o.maxCombinedDeltaPer1Pct),
    maxPerExpiryBucket: tighter(base.maxPerExpiryBucket, o.maxPerExpiryBucket),
    minEdge: higher(base.minEdge, o.minEdge),
    cashFloor: higher(base.cashFloor, o.cashFloor),
    maxPerTenor: resolveTenorCaps(o.maxPerTenor),
  };
}

/** Normalise tenor caps to the cadences the venue actually lists. */
function resolveTenorCaps(caps: PolicyOverrides["maxPerTenor"]): Record<number, number> | undefined {
  if (!caps) return undefined;
  const out: Record<number, number> = {};
  for (const cadence of TRADEABLE_CADENCES) {
    const v = caps[cadence];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[cadence] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Whether the runtime may open new positions for this user right now.
 *
 * Pause and stop are different promises and the difference is the whole reason
 * both exist. Paused stops NEW risk and keeps managing what is open, so
 * settlements still resolve and claims still sweep. Stopped means the user is
 * done. Neither dumps open positions into a thin bid to make a status line
 * change colour — that realises the spread on top of whatever the loss already
 * was, which is precisely the wrong thing to do on a venue this thin.
 */
export const mayOpen = (p: PortfolioPolicy): boolean => p.state === "running";

/** Whether the runtime should still manage open positions — settle, claim, reconcile. */
export const mayManage = (p: PortfolioPolicy): boolean => p.state !== "stopped";

/** Human-readable summary of the binding limits, in collateral, for the UI. */
export interface PolicyLimits {
  deployedCap: number;
  perPositionCap: number;
  assetDeltaCap: number;
  combinedDeltaCap: number;
  expiryBucketCap: number;
  cashFloor: number;
  minEdge: number;
  kellyFraction: number;
  tenorCaps: { intervalSec: number; label: string; cap: number }[];
}

export function limitsOf(policy: PortfolioPolicy): PolicyLimits {
  const r = resolvePolicy(policy);
  const c = policy.capital;
  return {
    deployedCap: c * r.maxDeployed,
    perPositionCap: c * r.maxPerPosition,
    assetDeltaCap: c * r.maxAssetDeltaPer1Pct,
    combinedDeltaCap: c * r.maxCombinedDeltaPer1Pct,
    expiryBucketCap: c * r.maxPerExpiryBucket,
    cashFloor: c * r.cashFloor,
    minEdge: r.minEdge,
    kellyFraction: r.kellyFraction,
    tenorCaps: Object.entries(r.maxPerTenor ?? {}).map(([sec, frac]) => ({
      intervalSec: Number(sec),
      label: tenorLabel(Number(sec)),
      cap: c * frac,
    })),
  };
}

/**
 * Validate and normalise a policy arriving from the network.
 *
 * The backend accepts these over HTTP, so this is a trust boundary: a capital
 * figure of NaN or a negative ceiling would propagate straight into sizing. It
 * throws rather than silently coercing, because a policy that is not what the
 * user set is worse than a rejected request.
 */
export function parsePolicy(input: unknown): PortfolioPolicy {
  const o = input as Partial<PortfolioPolicy>;
  const owner = String(o?.owner ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new Error("policy.owner must be a wallet address");
  const capital = Number(o?.capital);
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("policy.capital must be a positive number");
  const profileName = String(o?.profile ?? "balanced") as ProfileName;
  if (!(profileName in PROFILES)) throw new Error(`policy.profile must be one of ${Object.keys(PROFILES).join(", ")}`);
  // A stored `autopilot` is pre-upgrade data, and it becomes SHADOW rather
  // than `validated_autopilot`. It was written by a build that never checked
  // whether the strategy had passed economic validation, so honouring it as
  // live execution would reissue a permission under a stronger meaning than
  // the one it was granted with. The database migration makes the same choice.
  const mode: ExecutionMode = isExecutionMode(o?.mode) ? o.mode : "shadow";
  const state: RunState = (["idle", "running", "paused", "stopped", "halted"] as const).includes(o?.state as RunState)
    ? (o!.state as RunState)
    : "idle";
  const now = Math.floor(Date.now() / 1000);
  return {
    owner: owner as `0x${string}`,
    capital,
    profile: profileName,
    mode,
    state,
    overrides: parseOverrides(o?.overrides),
    createdAt: Number.isFinite(Number(o?.createdAt)) ? Number(o!.createdAt) : now,
    updatedAt: now,
    ...(o?.stoppedReason ? { stoppedReason: String(o.stoppedReason).slice(0, 240) } : {}),
  };
}

/** Fractions must be in [0,1]; anything else is dropped rather than clamped silently. */
function parseOverrides(input: unknown): PolicyOverrides {
  const o = (input ?? {}) as Record<string, unknown>;
  const out: PolicyOverrides = {};
  const fractions = [
    "maxDeployed", "maxPerPosition", "maxAssetDeltaPer1Pct",
    "maxCombinedDeltaPer1Pct", "maxPerExpiryBucket", "minEdge", "cashFloor",
  ] as const;
  for (const k of fractions) {
    const v = Number(o[k]);
    if (Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
  }
  const tenor = o.maxPerTenor as Record<string, unknown> | undefined;
  if (tenor && typeof tenor === "object") {
    const caps: Partial<Record<number, number>> = {};
    for (const cadence of TRADEABLE_CADENCES) {
      const v = Number(tenor[String(cadence)]);
      if (Number.isFinite(v) && v >= 0 && v <= 1) caps[cadence] = v;
    }
    if (Object.keys(caps).length > 0) out.maxPerTenor = caps;
  }
  return out;
}
