// Everything the cockpit renders, assembled server-side.
//
// The client stays deliberately dumb: it fetches one JSON document and draws it.
// That keeps the charts honest — every number on screen is computed from the same
// state the runtime wrote and the same evidence file the CLIs produce, rather
// than being recomputed in the browser where it could quietly drift.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROFILES } from "../portfolio/profiles.js";
import { riskOf, type Position } from "../portfolio/risk.js";
import {
  DecisionLog,
  decisionLogPath,
  equityOf,
  statePath,
  type DecisionRecord,
  type RivoState,
} from "../runtime/state.js";

/** A runtime is considered alive if it wrote a cycle this recently. */
export const LIVENESS_WINDOW_SEC = 180;

export interface ChartPoint {
  t: number;
  v: number;
}

export interface TermStructureRow {
  label: string;
  asset: string;
  tenorMinutes: number;
  leg: "UP" | "DOWN";
  /** What Rivo's model says this leg is worth. */
  fair: number;
  /** What the book charges for it. */
  ask: number | null;
  edge: number | null;
  action: string;
  binding: string;
}

export interface ReliabilityBinView {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  freq: number;
}

export function readState(dataDir: string): RivoState | null {
  const p = statePath(dataDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RivoState;
  } catch {
    return null;
  }
}

/**
 * Realised P&L over time, reconstructed from closed positions.
 *
 * No new persistence: every close already records `closedAt`, `cost` and
 * `proceeds`, so the curve is a running sum over them. Open positions are held
 * at cost, which is the honest mark — a binary has no mid until it settles, and
 * marking to the model would draw a curve out of an opinion.
 */
export function equityCurve(state: RivoState, maxPoints = 240): ChartPoint[] {
  const closed = [...state.closed].sort((a, b) => a.closedAt - b.closedAt);
  const points: ChartPoint[] = [{ t: state.startedAt, v: state.capital }];
  let equity = state.capital;
  for (const c of closed) {
    equity += c.proceeds - c.cost;
    points.push({ t: c.closedAt, v: equity });
  }
  points.push({ t: Math.floor(Date.now() / 1000), v: equityOf(state) });
  if (points.length <= maxPoints) return points;
  // Thin evenly, always keeping the first and last so the shape and the current
  // value both survive.
  const step = (points.length - 1) / (maxPoints - 1);
  const out: ChartPoint[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/**
 * The hero panel: model against book, across the whole term structure.
 *
 * Built from the most recent cycle's decisions rather than a fresh scan, so what
 * the chart shows is exactly what the allocator saw when it decided. A panel
 * drawn from a newer scan would disagree with the reasons printed beside it.
 */
export function termStructure(decisions: DecisionRecord[]): TermStructureRow[] {
  if (decisions.length === 0) return [];
  const last = Math.max(...decisions.map((d) => d.cycle));
  return decisions
    .filter((d) => d.cycle === last)
    .map((d) => ({
      label: `${d.asset}-${tenorLabel(d.intervalSec)}`,
      asset: d.asset,
      tenorMinutes: Math.round(d.intervalSec / 60),
      leg: d.leg,
      fair: d.fair,
      ask: d.ask,
      edge: d.edge,
      action: d.action,
      binding: d.binding,
    }))
    .sort((a, b) => a.asset.localeCompare(b.asset) || a.tenorMinutes - b.tenorMinutes || a.leg.localeCompare(b.leg));
}

const tenorLabel = (sec: number): string => {
  const m = Math.round(sec / 60);
  return m >= 1440 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
};

/** The calibration evidence, if the file the CLIs write is present. */
export function calibration(repoRoot: string): {
  bins: ReliabilityBinView[];
  auc: number;
  brier: number;
  brierCoin: number;
  n: number;
  forecasts: number;
  windows: number;
} | null {
  const p = join(repoRoot, "docs", "evidence", "calibration.json");
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as {
      reliability?: ReliabilityBinView[];
      holdout?: { n: number; auc: number; brier: number; brierCoin: number } | null;
      sample?: { forecasts: number; marketsUsed: number };
    };
    if (!d.reliability || !d.holdout) return null;
    return {
      bins: d.reliability,
      auc: d.holdout.auc,
      brier: d.holdout.brier,
      brierCoin: d.holdout.brierCoin,
      n: d.holdout.n,
      forecasts: d.sample?.forecasts ?? 0,
      windows: d.sample?.marketsUsed ?? 0,
    };
  } catch {
    return null;
  }
}

export interface RuntimeStatus {
  running: boolean;
  /** True when this server started it and can therefore stop it. */
  owned: boolean;
  /** Seconds since the last completed cycle, or null when nothing has run. */
  sinceLastCycleSec: number | null;
}

/**
 * Whether a runtime is alive, and whether this process may stop it.
 *
 * Liveness comes from the state file rather than a PID, so a runtime started
 * from a terminal is still visible here. But the Stop button only appears for a
 * child this server spawned — offering to kill a process we do not own would be
 * a lie about what the button does.
 */
export function runtimeStatus(state: RivoState | null, ownedAlive: boolean): RuntimeStatus {
  if (!state || !state.lastCycleAt) return { running: ownedAlive, owned: ownedAlive, sinceLastCycleSec: null };
  const since = Math.floor(Date.now() / 1000) - state.lastCycleAt;
  return { running: ownedAlive || since <= LIVENESS_WINDOW_SEC, owned: ownedAlive, sinceLastCycleSec: since };
}

export interface CockpitView {
  error?: string;
  status: RuntimeStatus;
  mode: "LIVE" | "SHADOW";
  profile: string;
  profiles: string[];
  kelly: number;
  capital: number;
  cash: number;
  deployed: number;
  equity: number;
  realizedPnl: number;
  cycles: number;
  startedAt: number;
  lastCycleAt: number;
  halted: string | null;
  positions: {
    label: string;
    asset: string;
    leg: string;
    shares: number;
    entryPrice: number;
    cost: number;
    expiry: number;
    delta: number;
    adopted: boolean;
  }[];
  risk: {
    assetDelta: { asset: string; delta: number; budget: number }[];
    combined: number;
    combinedBudget: number;
    maxLoss: number;
    buckets: { bucket: string; cost: number; budget: number }[];
  };
  settled: { count: number; wins: number; staked: number; returned: number; returnOnStake: number };
  evaluations: number;
  equityCurve: ChartPoint[];
  termStructure: TermStructureRow[];
  calibration: ReturnType<typeof calibration>;
  declineReasons: { reason: string; n: number }[];
}

/** Assemble the whole document. */
export function buildView(dataDir: string, repoRoot: string, ownedAlive: boolean): CockpitView | { error: string } {
  const state = readState(dataDir);
  if (!state) {
    return { error: `No state at ${statePath(dataDir)}. Press Start, or run \`npm start\`.` };
  }
  const log = new DecisionLog(decisionLogPath(dataDir));
  const decisions = log.read(2_000);
  const prof = PROFILES[state.profile as keyof typeof PROFILES] ?? PROFILES.balanced;
  const equity = equityOf(state);
  const rho = 0.8; // display-only; the runtime measures it fresh every cycle
  const risk = riskOf(state.open as Position[], rho);

  const reasons = new Map<string, number>();
  for (const d of decisions.filter((x) => x.action === "SKIP")) {
    const key = d.binding
      .replace(/±[\d.]+\/1%/, "±budget")
      .replace(/expiry bucket \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "expiry-bucket concentration")
      .replace(/\(rho [\d.]+\)/, "")
      .replace(/\(\d+s left\)/, "(near expiry)")
      .replace(/[+-]?\d+\.\d+/g, "N")
      .trim();
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  const settled = state.closed.filter((c) => c.exit === "settled");
  const staked = settled.reduce((n, c) => n + c.cost, 0);
  const returned = settled.reduce((n, c) => n + c.proceeds, 0);

  return {
    status: runtimeStatus(state, ownedAlive),
    mode: state.dryRun ? "SHADOW" : "LIVE",
    profile: state.profile,
    profiles: Object.keys(PROFILES),
    kelly: prof.kellyFraction,
    capital: state.capital,
    cash: state.cash,
    deployed: equity - state.cash,
    equity,
    realizedPnl: state.realizedPnl,
    cycles: state.cycles,
    startedAt: state.startedAt,
    lastCycleAt: state.lastCycleAt,
    halted: state.halted,
    positions: state.open.map((p) => ({
      label: `${p.asset}-${tenorLabel(p.intervalSec)}`,
      asset: p.asset,
      leg: p.leg,
      shares: p.shares,
      entryPrice: p.entryPrice,
      cost: p.cost,
      expiry: p.expiry,
      delta: p.shares * p.deltaPer1PctPerShare,
      adopted: Boolean(p.adopted),
    })),
    risk: {
      assetDelta: [...risk.assetDelta].map(([asset, delta]) => ({
        asset,
        delta,
        budget: state.capital * prof.maxAssetDeltaPer1Pct,
      })),
      combined: risk.combinedDelta,
      combinedBudget: state.capital * prof.maxCombinedDeltaPer1Pct,
      maxLoss: risk.maxLoss,
      buckets: [...risk.expiryBuckets].map(([bucket, cost]) => ({
        bucket,
        cost,
        budget: state.capital * prof.maxPerExpiryBucket,
      })),
    },
    settled: {
      count: settled.length,
      wins: settled.filter((c) => c.won === 1).length,
      staked,
      returned,
      returnOnStake: staked > 0 ? (returned - staked) / staked : 0,
    },
    evaluations: log.count(),
    equityCurve: equityCurve(state),
    termStructure: termStructure(decisions),
    calibration: calibration(repoRoot),
    declineReasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, n]) => ({ reason, n })),
  };
}
