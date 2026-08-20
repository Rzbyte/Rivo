// Rivo's decision pipeline, running in the browser.
//
// This is not a reimplementation for display. It imports `snapshot`, `allocate`
// and `riskOf` — the same modules the Node runtime calls — so the allocation a
// visitor sees, and the reason attached to every rejected leg, are produced by
// the code that was backtested and is running live. That is the only version of
// this page worth shipping: a mock would drift from the engine within a week and
// nobody would notice, because a mock always looks right.
//
// It is possible because the engine has no Node dependencies. Discovery,
// pricing, allocation and risk are `fetch` plus arithmetic; only signing and
// persistence need a machine. So Shadow Mode — the full portfolio loop with
// paper fills — runs from a static page with no backend, no key and no install,
// and Autopilot is exactly the same pipeline with a live executor attached at
// the far end.
//
// WHAT IS SIMULATED HERE, stated plainly because the UI repeats it: fills are
// walked against real depth from the live book, but no order is sent, so nothing
// here moves a price or pays a spread it did not choose to pay. Settlement is
// real — positions resolve against the venue's own oracle outcome.

import { Indexer } from "../core/indexer.js";
import { snapshot, type Snapshot } from "../engine/scan.js";
import { allocate, type Decision } from "../portfolio/allocator.js";
import { measureCorrelation, riskOf, expiryBucket, type Position, type RiskState } from "../portfolio/risk.js";
import { limitsOf, resolvePolicy, mayOpen, type PolicyLimits, type PortfolioPolicy } from "../portfolio/policy.js";
import { tenorLabel, type Asset } from "../core/venue.js";
import type { Leg } from "../engine/book.js";

/** A position held by a shadow portfolio. Mirrors HeldPosition without the Node state file. */
export interface ShadowPosition extends Position {
  openedAt: number;
  fairAtEntry: number;
}

export interface ShadowClosed {
  marketId: string;
  asset: Asset;
  intervalSec: number;
  leg: Leg;
  shares: number;
  entryPrice: number;
  cost: number;
  openedAt: number;
  closedAt: number;
  won: 0 | 1;
  proceeds: number;
  /** Voided windows return the premium rather than paying out. */
  exit: "settled" | "voided";
}

/** The portfolio a policy owns, as it evolves cycle to cycle. */
export interface ShadowPortfolio {
  owner: string;
  cash: number;
  realizedPnl: number;
  open: ShadowPosition[];
  closed: ShadowClosed[];
  cycles: number;
  startedAt: number;
  lastCycleAt: number;
}

export function emptyPortfolio(policy: PortfolioPolicy): ShadowPortfolio {
  return {
    owner: policy.owner,
    cash: policy.capital,
    realizedPnl: 0,
    open: [],
    closed: [],
    cycles: 0,
    startedAt: Math.floor(Date.now() / 1000),
    lastCycleAt: 0,
  };
}

/** One line of the activity feed. */
export interface Activity {
  at: number;
  kind: "scan" | "buy" | "skip" | "settle" | "halt" | "info";
  text: string;
}

/** An opportunity as the UI needs it: priced, decided, and with the reason kept. */
export interface DecisionView {
  marketId: string;
  asset: Asset;
  intervalSec: number;
  tenor: string;
  leg: Leg;
  label: string;
  fair: number;
  ask: number | null;
  edge: number | null;
  action: "BUY" | "SKIP";
  shares: number;
  cost: number;
  binding: string;
  /** Every constraint considered, cheapest-first — the full "why". */
  limits: { name: string; allowedCost: number; binding: boolean }[];
  kellyFull: number;
  kellyTarget: number;
  minutesLeft: number;
  deltaPer1PctPerShare: number;
}

export interface Exposure {
  asset: Asset;
  delta: number;
  cap: number;
  cost: number;
}

export interface PortfolioView {
  at: number;
  policy: PortfolioPolicy;
  /**
   * The policy's ceilings in collateral, resolved once.
   *
   * On the view rather than recomputed by each consumer so that the number in a
   * progress bar and the number in the sentence explaining it are the same
   * number — the fastest way to lose a user's trust is two panels disagreeing
   * about the same limit.
   */
  limits: PolicyLimits;
  cycles: number;
  capital: number;
  deployed: number;
  cash: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  capitalAtRisk: number;
  risk: RiskState;
  exposures: Exposure[];
  combined: { delta: number; cap: number };
  expiry: { bucket: string; cost: number; cap: number }[];
  tenor: { intervalSec: number; label: string; cost: number; cap: number | null }[];
  positions: (ShadowPosition & { mark: number | null; value: number; label: string })[];
  accepted: DecisionView[];
  skipped: DecisionView[];
  closed: ShadowClosed[];
  spot: Record<string, number>;
  rho: number;
  unpriced: { marketId: string; asset: string; intervalSec: number; reason: string }[];
  activity: Activity[];
}

const legLabel = (asset: Asset, intervalSec: number, leg: Leg): string =>
  `${asset} ${tenorLabel(intervalSec)} ${leg === "UP" ? "UP" : "DOWN"}`;

/**
 * Resolve positions whose windows have settled.
 *
 * Runs before allocation, for the same reason the Node loop does it in that
 * order: capital returned by a settlement is spendable this cycle, and a
 * portfolio that only frees capital on the following pass systematically
 * under-deploys, which would show up in the forward test as a constraint that
 * was never really binding.
 */
export async function settleShadow(
  idx: Indexer,
  pf: ShadowPortfolio,
  now: number,
  log: (a: Activity) => void,
): Promise<void> {
  const due = pf.open.filter((p) => p.expiry <= now);
  if (due.length === 0) return;
  const outcomes = await idx.outcomes([...new Set(due.map((p) => p.marketId))]);
  const remaining: ShadowPosition[] = [];
  for (const p of pf.open) {
    if (p.expiry > now) {
      remaining.push(p);
      continue;
    }
    const o = outcomes.get(p.marketId.toLowerCase());
    // Not finalized yet is the normal state for a minute or two after expiry.
    // Holding the position is right: forcing a result would invent one.
    if (!o || (!o.finalized && !o.voided)) {
      remaining.push(p);
      continue;
    }
    if (o.voided) {
      pf.cash += p.cost;
      pf.closed.push({ ...strip(p), closedAt: now, won: 0, proceeds: p.cost, exit: "voided" });
      log({ at: now, kind: "settle", text: `${legLabel(p.asset, p.intervalSec, p.leg)} voided — ${p.cost.toFixed(2)} premium returned` });
      continue;
    }
    // winningOutcome 0 = Up, 1 = Down, matching the venue's own encoding.
    const won: 0 | 1 = (o.winningOutcome === 0 ? "UP" : "DOWN") === p.leg ? 1 : 0;
    const proceeds = won ? p.shares : 0;
    pf.cash += proceeds;
    pf.realizedPnl += proceeds - p.cost;
    pf.closed.push({ ...strip(p), closedAt: now, won, proceeds, exit: "settled" });
    log({
      at: now,
      kind: "settle",
      text: `${legLabel(p.asset, p.intervalSec, p.leg)} settled ${won ? "WON" : "LOST"} — ${(proceeds - p.cost >= 0 ? "+" : "")}${(proceeds - p.cost).toFixed(2)} collateral`,
    });
  }
  pf.open = remaining;
}

const strip = (p: ShadowPosition) => ({
  marketId: p.marketId,
  asset: p.asset,
  intervalSec: p.intervalSec,
  leg: p.leg,
  shares: p.shares,
  entryPrice: p.entryPrice,
  cost: p.cost,
  openedAt: p.openedAt,
});

export interface CycleOptions {
  now?: number;
  /** Skip opening new positions even when the policy would allow it. */
  readOnly?: boolean;
}

/**
 * One full pass: discover, price, settle, allocate, apply.
 *
 * Returns the view the UI renders AND mutates the portfolio, in that order of
 * importance — the view is derived from the portfolio after the pass, never
 * assembled independently, so what is displayed is what is held.
 */
export async function runCycle(
  idx: Indexer,
  policy: PortfolioPolicy,
  pf: ShadowPortfolio,
  opts: CycleOptions = {},
): Promise<PortfolioView> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const activity: Activity[] = [];
  const log = (a: Activity) => activity.push(a);

  await settleShadow(idx, pf, now, log);

  const snap = await snapshot(idx, { now });
  log({
    at: now,
    kind: "scan",
    text: `scanned ${snap.windows.length} live windows → ${snap.opportunities.length} legs priced${snap.unpriced.length ? `, ${snap.unpriced.length} unpriceable` : ""}`,
  });

  const btc = snap.assets.get("BTC");
  const eth = snap.assets.get("ETH");
  const rho = btc && eth ? measureCorrelation(btc.bars, eth.bars) : 0.8;
  const resolved = resolvePolicy(policy);

  const spotMap = new Map<Asset, number>();
  for (const [asset, st] of snap.assets) spotMap.set(asset, st.spot);

  const alloc = allocate({
    totalCapital: policy.capital,
    freeCash: pf.cash,
    opportunities: snap.opportunities,
    books: snap.books,
    spot: spotMap,
    held: pf.open,
    rho,
    profile: resolved,
  });

  // Apply the allocation only when the policy actually permits new risk. The
  // decisions are computed either way, so a paused portfolio still SHOWS what
  // Rivo would do — which is most of the value of pausing.
  const opening = mayOpen(policy) && !opts.readOnly;
  if (opening) {
    for (const d of alloc.decisions) {
      if (d.action !== "BUY" || d.cost <= 0) continue;
      const o = d.opportunity;
      pf.open.push({
        marketId: o.marketId,
        asset: o.asset,
        intervalSec: o.intervalSec,
        leg: o.leg,
        shares: d.shares,
        entryPrice: d.avgPrice,
        cost: d.cost,
        expiry: o.expiry,
        deltaPer1PctPerShare: o.deltaPerShare * (spotMap.get(o.asset) ?? 0) * 0.01,
        openedAt: now,
        fairAtEntry: o.fair,
      });
      pf.cash -= d.cost;
      log({
        at: now,
        kind: "buy",
        text: `${legLabel(o.asset, o.intervalSec, o.leg)} — ${d.shares.toFixed(2)} shares @ ${d.avgPrice.toFixed(3)} = ${d.cost.toFixed(2)} collateral`,
      });
    }
  } else if (mayOpen(policy) === false && policy.state !== "idle") {
    log({ at: now, kind: "info", text: `portfolio ${policy.state} — showing what Rivo would do, opening nothing` });
  }

  pf.cycles += 1;
  pf.lastCycleAt = now;

  return buildView(policy, pf, snap, alloc.decisions, rho, now, activity, opening);
}

/** Assemble the view from what is actually held after the pass. */
function buildView(
  policy: PortfolioPolicy,
  pf: ShadowPortfolio,
  snap: Snapshot,
  decisions: Decision[],
  rho: number,
  now: number,
  activity: Activity[],
  opened: boolean,
): PortfolioView {
  const resolved = resolvePolicy(policy);
  const risk = riskOf(pf.open, rho);
  const cap = policy.capital;

  // Mark open positions at the current model fair value rather than the bid.
  // The bid is what a forced exit would realise; the model is what the position
  // is worth to a holder who intends to let it settle, which is what Rivo does.
  const fairByLeg = new Map<string, number>();
  for (const o of snap.opportunities) fairByLeg.set(`${o.marketId}:${o.leg}`, o.fair);

  const positions = pf.open.map((p) => {
    const mark = fairByLeg.get(`${p.marketId}:${p.leg}`) ?? null;
    return {
      ...p,
      mark,
      value: mark === null ? p.cost : mark * p.shares,
      label: legLabel(p.asset, p.intervalSec, p.leg),
    };
  });
  const unrealized = positions.reduce((s, p) => s + (p.value - p.cost), 0);

  const views = decisions.map((d): DecisionView => {
    const o = d.opportunity;
    const min = d.limits.length > 0 ? Math.min(...d.limits.map((l) => l.allowedCost)) : Number.POSITIVE_INFINITY;
    return {
      marketId: o.marketId,
      asset: o.asset,
      intervalSec: o.intervalSec,
      tenor: tenorLabel(o.intervalSec),
      leg: o.leg,
      label: legLabel(o.asset, o.intervalSec, o.leg),
      fair: o.fair,
      ask: o.ask,
      edge: o.edge,
      action: d.action,
      shares: d.shares,
      cost: d.cost,
      binding: d.binding,
      limits: [...d.limits]
        .sort((a, b) => a.allowedCost - b.allowedCost)
        .map((l) => ({ ...l, binding: l.allowedCost <= min + 1e-9 })),
      kellyFull: d.kellyFull,
      kellyTarget: d.kellyTarget,
      minutesLeft: Math.max(0, (o.expiry - now) / 60),
      deltaPer1PctPerShare: o.deltaPerShare * (snap.assets.get(o.asset)?.spot ?? 0) * 0.01,
    };
  });

  const exposures: Exposure[] = (["BTC", "ETH"] as const).map((asset) => ({
    asset,
    delta: risk.assetDelta.get(asset) ?? 0,
    cap: cap * resolved.maxAssetDeltaPer1Pct,
    cost: pf.open.filter((p) => p.asset === asset).reduce((s, p) => s + p.cost, 0),
  }));

  const tenorCost = new Map<number, number>();
  for (const p of pf.open) tenorCost.set(p.intervalSec, (tenorCost.get(p.intervalSec) ?? 0) + p.cost);
  const tenors = [...new Set([...tenorCost.keys(), ...snap.windows.map((w) => w.intervalSec)])]
    .sort((a, b) => a - b)
    .map((intervalSec) => ({
      intervalSec,
      label: tenorLabel(intervalSec),
      cost: tenorCost.get(intervalSec) ?? 0,
      cap: resolved.maxPerTenor?.[intervalSec] !== undefined ? cap * resolved.maxPerTenor[intervalSec]! : null,
    }));

  const spot: Record<string, number> = {};
  for (const [asset, st] of snap.assets) spot[asset] = st.spot;

  if (!opened && pf.cycles > 0 && policy.state === "running") {
    // Nothing to say; a running portfolio that opened nothing is the normal case
    // and the skip list already explains it leg by leg.
  }

  return {
    at: now,
    policy,
    limits: limitsOf(policy),
    cycles: pf.cycles,
    capital: cap,
    deployed: risk.capitalAtRisk,
    cash: pf.cash,
    equity: pf.cash + positions.reduce((s, p) => s + p.value, 0),
    realizedPnl: pf.realizedPnl,
    unrealizedPnl: unrealized,
    capitalAtRisk: risk.capitalAtRisk,
    risk,
    exposures,
    combined: { delta: risk.combinedDelta, cap: cap * resolved.maxCombinedDeltaPer1Pct },
    expiry: [...risk.expiryBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, cost]) => ({ bucket, cost, cap: cap * resolved.maxPerExpiryBucket })),
    tenor: tenors,
    positions: positions.sort((a, b) => a.expiry - b.expiry),
    accepted: views.filter((v) => v.action === "BUY").sort((a, b) => b.cost - a.cost),
    skipped: views.filter((v) => v.action === "SKIP").sort((a, b) => (b.edge ?? -1) - (a.edge ?? -1)),
    closed: [...pf.closed].sort((a, b) => b.closedAt - a.closedAt).slice(0, 50),
    spot,
    rho,
    unpriced: snap.unpriced,
    activity,
  };
}

export { expiryBucket, Indexer };
