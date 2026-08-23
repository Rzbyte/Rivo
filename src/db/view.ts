// What a user is shown about their portfolio.
//
// Assembled server-side, in one place, because the dashboard's job is to make a
// specific thing obvious and that thing is not "here are your trades". It is:
//
//   Rivo saw four positive-edge opportunities and took one, and here is the
//   constraint that stopped the other three.
//
// So the view leads with exposure against limits and with SKIP decisions
// alongside the constraint that bound them. A view that led with fills would be
// a trade blotter, and a trade blotter for a portfolio manager tells you what it
// did without ever telling you what it declined — which is the half that makes
// it a portfolio manager rather than a bot.

import { num, one, query, secs } from "./pool.js";
import { limitsOf, type PolicyLimits } from "../portfolio/policy.js";
import { riskOf, type Position } from "../portfolio/risk.js";
import { permissionFor, type Portfolio } from "./portfolios.js";
import type { ExecutionMode } from "../runtime/permission.js";
import { PRODUCTION_STRATEGY } from "../research/gating.js";
import { modeIntendsExecution } from "../runtime/permission.js";
import { PostgresExecutionLedger } from "../ledger/postgres.js";
import type { ExecutionRecord } from "../ledger/types.js";
import { liveWorkers } from "./leases.js";
import { recent, type RivoEvent } from "./events.js";
import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";
import type { DecisionRecord } from "../runtime/state.js";
import { PostgresDecisionLog } from "../store/postgres.js";

export interface OpenPositionView extends Position {
  id: string;
  openedAt: number;
  fairAtEntry: number;
  adopted: boolean;
}

export interface ClosedPositionView {
  id: string;
  marketId: string;
  asset: Asset;
  intervalSec: number;
  leg: Leg;
  shares: number;
  entryPrice: number;
  cost: number;
  openedAt: number;
  closedAt: number;
  won: boolean;
  proceeds: number;
  exit: string;
  /** Every chain action that touched this position. This is the audit trail. */
  txHashes: string[];
}

export interface ExposureView {
  asset: Asset;
  /** Signed collateral per 1% move in the underlying. */
  delta: number;
  cap: number;
  /** Fraction of the cap used, by absolute exposure. */
  used: number;
  /** Collateral committed to this underlying. */
  deployed: number;
}

export interface AutopilotView {
  mode: ExecutionMode;
  state: string;
  /** Whether the user's grant to sign currently stands. */
  delegated: boolean;
  /** Whether real orders can be sent right now. */
  live: boolean;
  /** Why not, when not. Null when it is live. */
  blocker: string | null;
  stoppedReason: string | null;
}

/**
 * What the dashboard needs to tell the truth about permission.
 *
 * Derived server-side rather than assembled in the browser: the sentence "this
 * strategy failed economic validation" has to come from the same place the
 * execution gate reads, or the two can disagree and the UI becomes the more
 * persuasive of the two.
 */
export interface StrategyView {
  id: string;
  label: string;
  /** UNVALIDATED | SHADOW_ONLY | VALIDATED | REJECTED. */
  state: string;
  /** Forecast quality. Deliberately reported next to the economics, not instead of it. */
  auc: number;
  /** Out-of-sample return on stake. Negative for the incumbent. */
  returnOnStake: number;
  /** Where the verdict came from. */
  evidence: string;
  /** One sentence a reader can act on. */
  note: string;
  /** What this state plus this mode plus this network actually allows. */
  eligibility: string;
  /** Empty when capital may move. */
  blockedBy: string[];
}

export interface PortfolioView {
  id: string;
  address: `0x${string}`;
  network: string;
  profile: string;
  autopilot: AutopilotView;
  /** The forecast being run, its standing, and what that permits. */
  strategy: StrategyView;
  limits: PolicyLimits;
  capital: number;
  cash: number;
  deployed: number;
  equity: number;
  realizedPnl: number;
  contributed: number;
  /** Fraction of the deployable budget in use. */
  utilisation: number;
  exposure: ExposureView[];
  expiryBuckets: { bucket: string; committed: number; cap: number }[];
  positions: OpenPositionView[];
  runtime: {
    cycles: number;
    startedAt: number;
    lastCycleAt: number | null;
    /** Seconds since the last completed cycle, or null if there has not been one. */
    sinceLastCycleSec: number | null;
    halted: string | null;
    dryRun: boolean;
    tradedBy: string | null;
  };
  worker: {
    alive: number;
    healthy: boolean;
    /** Unix seconds of the most recent heartbeat in the fleet, or null. */
    lastHeartbeatAt: number | null;
    /** Seconds since that heartbeat. Null when no worker has ever reported. */
    sinceHeartbeatSec: number | null;
  };
  /**
   * What the chain and Rivo disagreed about, and what is still in flight.
   *
   * Separate from `events` because these are STATES rather than occurrences: how
   * many positions came from the chain rather than from a fill, and how many
   * executions are unresolved right now. An operator reading a log of past
   * events cannot answer either.
   */
  reconciliation: {
    /** Positions found on-chain that Rivo did not open. Cost basis is estimated. */
    adopted: number;
    /** Reconciliation findings recorded, ever. */
    events: number;
    lastAt: number | null;
    /** Executions written but not yet resolved — intended or submitted. */
    pendingExecutions: number;
    /** Executions that failed in the last hour. Lifetime totals live in the ledger. */
    failedExecutions: number;
    /** Submitted, and no receipt could be found. Not the same as failed. */
    orphanedExecutions: number;
  };
  counts: { decisions: number; executions: number; onChain: number; openPositions: number; closedPositions: number };
  /**
   * When the portfolio was created, and when its policy was last changed.
   *
   * The onboarding indicator needs to tell "has a capital figure" from "the user
   * chose one". A portfolio is created with a sensible default, so capital is
   * non-zero from the first instant — and the step marked "Configured" was
   * ticked before the user had done anything, which makes the whole progress
   * indicator untrustworthy.
   */
  createdAt: number;
  updatedAt: number;
}

/** Correlation used for the combined-delta figure when no cycle has measured one. */
const ASSUMED_RHO = 0.8;

/**
 * Why Autopilot is not sending orders, in the user's terms.
 *
 * Ordered by what the user would have to do about it, most actionable first. A
 * list of every reason at once would be technically complete and useless: the
 * question being answered is "what do I click".
 */
export function autopilotBlocker(p: Portfolio, halted: string | null): string | null {
  if (halted) return `Trading is halted: ${halted}. Review and restart it yourself — Rivo will not restart on its own.`;
  if (p.policy.state === "stopped") return "Autopilot is switched off.";
  if (p.policy.state === "paused") return "Autopilot is paused.";
  if (!modeIntendsExecution(p.policy.mode)) return "This portfolio is in Shadow Mode — it decides but does not trade.";
  if (!p.privyWalletId) return "This portfolio has no Rivo wallet yet.";
  if (!p.delegated) return "Rivo does not have permission to sign for this wallet. Enable Autopilot to grant it.";
  if (p.policy.state !== "running") return "Autopilot has not been started.";
  return null;
}

export async function buildView(portfolio: Portfolio): Promise<PortfolioView> {
  const rt = await one<{
    cash: string;
    realized_pnl: string;
    contributed: string;
    cycles: string;
    halted: string | null;
    dry_run: boolean;
    traded_by: string | null;
    started_at: Date;
    last_cycle_at: Date | null;
  }>(
    `SELECT cash, realized_pnl, contributed, cycles, halted, dry_run, traded_by, started_at, last_cycle_at
       FROM portfolio_runtime WHERE portfolio_id = $1`,
    [portfolio.id],
  );

  const openRows = await query<{
    id: string;
    market_id: string;
    asset: string;
    interval_sec: number;
    leg: string;
    shares: string;
    entry_price: string;
    cost: string;
    fair_at_entry: string;
    delta_per_share: string;
    expiry: Date;
    opened_at: Date;
    adopted: boolean;
  }>(
    `SELECT id, market_id, asset, interval_sec, leg, shares, entry_price, cost, fair_at_entry,
            delta_per_share, expiry, opened_at, adopted
       FROM positions WHERE portfolio_id = $1 AND status = 'open' ORDER BY expiry`,
    [portfolio.id],
  );

  const positions: OpenPositionView[] = openRows.map((r) => ({
    id: r.id,
    marketId: r.market_id,
    asset: r.asset as Asset,
    intervalSec: r.interval_sec,
    leg: r.leg as Leg,
    shares: num(r.shares),
    entryPrice: num(r.entry_price),
    cost: num(r.cost),
    expiry: secs(r.expiry),
    deltaPer1PctPerShare: num(r.delta_per_share),
    openedAt: secs(r.opened_at),
    fairAtEntry: num(r.fair_at_entry),
    adopted: r.adopted,
  }));

  const limits = limitsOf(portfolio.policy);
  const risk = riskOf(positions, ASSUMED_RHO);
  const deployed = risk.capitalAtRisk;
  const cash = num(rt.cash);
  const halted = rt.halted;

  const deployedByAsset = new Map<Asset, number>();
  for (const p of positions) deployedByAsset.set(p.asset, (deployedByAsset.get(p.asset) ?? 0) + p.cost);

  const exposure: ExposureView[] = (["BTC", "ETH"] as Asset[]).map((asset) => {
    const delta = risk.assetDelta.get(asset) ?? 0;
    return {
      asset,
      delta,
      cap: limits.assetDeltaCap,
      used: limits.assetDeltaCap > 0 ? Math.abs(delta) / limits.assetDeltaCap : 0,
      deployed: deployedByAsset.get(asset) ?? 0,
    };
  });

  const counts = await one<{
    decisions: string; executions: string; closed: string; adopted: string;
    pending: string; failed: string; orphaned: string; onchain: string;
  }>(
    `SELECT (SELECT count(*) FROM decisions WHERE portfolio_id = $1)::text AS decisions,
            (SELECT count(*) FROM executions WHERE portfolio_id = $1)::text AS executions,
            (SELECT count(*) FROM positions WHERE portfolio_id = $1 AND status = 'closed')::text AS closed,
            (SELECT count(*) FROM positions WHERE portfolio_id = $1 AND status = 'open' AND adopted)::text AS adopted,
            (SELECT count(*) FROM executions WHERE portfolio_id = $1 AND status IN ('intended','submitted'))::text AS pending,
            -- RECENT failures, not lifetime.
            --
            -- The panel reads as a current condition, so counting every failure
            -- a portfolio ever had turns a bug that was fixed hours ago into a
            -- permanent alarm. One live portfolio showed "FAILED 1227" from a
            -- signing misconfiguration that had been corrected — frightening, and
            -- about nothing the user could act on.
            (SELECT count(*) FROM executions
              WHERE portfolio_id = $1 AND status = 'failed' AND created_at > now() - interval '1 hour')::text AS failed,
            (SELECT count(*) FROM executions WHERE portfolio_id = $1 AND status = 'orphaned')::text AS orphaned,
            -- Attempts that actually reached the chain.
            --
            -- Kept apart from the attempt count because the difference is the
            -- honesty of the tab. Every considered order is recorded before
            -- anything is signed, so the attempt count runs into the thousands
            -- while the number of transactions is small. A tab reading
            -- "Transactions (1288)" over four real ones is a claim, not a label.
            (SELECT count(*) FROM executions WHERE portfolio_id = $1 AND tx_hash IS NOT NULL)::text AS onchain`,
    [portfolio.id],
  );

  const reconEvents = await one<{ n: string; last_at: Date | null }>(
    `SELECT count(*)::text AS n, max(at) AS last_at FROM events
      WHERE portfolio_id = $1 AND kind LIKE 'reconcile.%'`,
    [portfolio.id],
  );

  const fleet = await liveWorkers();
  // The freshest heartbeat in the fleet. "Is Rivo alive" is a question about the
  // fleet, not about whichever worker happens to hold this portfolio right now —
  // a portfolio between leases is still being managed.
  const heartbeat = fleet.length > 0 ? Math.max(...fleet.map((w) => w.lastHeartbeatAt)) : null;
  const lastCycleAt = rt.last_cycle_at ? secs(rt.last_cycle_at) : null;
  const now = Math.floor(Date.now() / 1000);

  return {
    id: portfolio.id,
    address: portfolio.address,
    network: portfolio.network,
    profile: portfolio.policy.profile,
    strategy: strategyView(portfolio),
    autopilot: {
      mode: portfolio.policy.mode,
      state: portfolio.policy.state,
      delegated: portfolio.delegated,
      live: permissionFor(portfolio, true).mayMoveCapital && portfolio.policy.state === "running" && !halted,
      blocker: autopilotBlocker(portfolio, halted),
      stoppedReason: portfolio.policy.stoppedReason ?? null,
    },
    limits,
    capital: portfolio.policy.capital,
    cash,
    deployed,
    equity: cash + deployed,
    realizedPnl: num(rt.realized_pnl),
    contributed: num(rt.contributed),
    utilisation: limits.deployedCap > 0 ? deployed / limits.deployedCap : 0,
    exposure,
    expiryBuckets: [...risk.expiryBuckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([bucket, committed]) => ({ bucket, committed, cap: limits.expiryBucketCap })),
    positions,
    runtime: {
      cycles: Number(rt.cycles),
      startedAt: secs(rt.started_at),
      lastCycleAt,
      sinceLastCycleSec: lastCycleAt === null ? null : now - lastCycleAt,
      halted,
      dryRun: rt.dry_run,
      tradedBy: rt.traded_by,
    },
    worker: {
      alive: fleet.length,
      healthy: fleet.length > 0,
      lastHeartbeatAt: heartbeat,
      sinceHeartbeatSec: heartbeat === null ? null : now - heartbeat,
    },
    reconciliation: {
      adopted: Number(counts.adopted),
      events: Number(reconEvents.n),
      lastAt: reconEvents.last_at ? secs(reconEvents.last_at) : null,
      pendingExecutions: Number(counts.pending),
      failedExecutions: Number(counts.failed),
      orphanedExecutions: Number(counts.orphaned),
    },
    createdAt: portfolio.createdAt,
    updatedAt: portfolio.updatedAt,
    counts: {
      decisions: Number(counts.decisions),
      executions: Number(counts.executions),
      onChain: Number(counts.onchain),
      openPositions: positions.length,
      closedPositions: Number(counts.closed),
    },
  };
}

/**
 * One cycle's decisions, grouped so the refusals are visible next to the entry.
 *
 * This is the shape the dashboard's central panel wants: a cycle took a view
 * across the whole term structure and chose ONE leg out of several that all
 * looked good on their own. Returned by cycle, newest first.
 */
export interface DecisionGroup {
  cycle: number;
  at: number;
  entered: DecisionRecord[];
  skipped: DecisionRecord[];
  managed: DecisionRecord[];
  /** The constraints that bound at least one refusal this cycle, most common first. */
  bindings: { binding: string; count: number }[];
}

export async function decisionGroups(portfolioId: string, cycles = 8): Promise<DecisionGroup[]> {
  const rows = await new PostgresDecisionLog(portfolioId).read(cycles * 32);
  const byCycle = new Map<number, DecisionRecord[]>();
  for (const r of rows) byCycle.set(r.cycle, [...(byCycle.get(r.cycle) ?? []), r]);

  return [...byCycle.entries()]
    .sort(([a], [b]) => b - a)
    .slice(0, cycles)
    .map(([cycle, records]) => {
      const entered = records.filter((r) => r.action === "ENTER" || r.action === "BUY");
      const skipped = records.filter((r) => r.action === "SKIP");
      const managed = records.filter((r) => !["ENTER", "BUY", "SKIP"].includes(r.action));
      const counts = new Map<string, number>();
      for (const r of skipped) counts.set(r.binding, (counts.get(r.binding) ?? 0) + 1);
      return {
        cycle,
        at: Math.max(...records.map((r) => r.at)),
        entered,
        skipped,
        managed,
        bindings: [...counts.entries()]
          .map(([binding, count]) => ({ binding, count }))
          .sort((a, b) => b.count - a.count),
      };
    });
}

/** The permanent transaction record, newest first. */
export async function executions(portfolioId: string, limit = 100): Promise<ExecutionRecord[]> {
  return new PostgresExecutionLedger().list(portfolioId, limit);
}

/** Closed positions, each carrying the transactions that produced it. */
export async function closedPositions(portfolioId: string, limit = 100): Promise<ClosedPositionView[]> {
  const rows = await query<{
    id: string;
    market_id: string;
    asset: string;
    interval_sec: number;
    leg: string;
    shares: string;
    entry_price: string;
    cost: string;
    opened_at: Date;
    closed_at: Date;
    won: boolean | null;
    proceeds: string | null;
    exit: string | null;
    tx_hashes: string[] | null;
  }>(
    `SELECT p.id, p.market_id, p.asset, p.interval_sec, p.leg, p.shares, p.entry_price, p.cost,
            p.opened_at, p.closed_at, p.won, p.proceeds, p.exit,
            -- Every transaction that touched this position, from the ledger
            -- rather than from the position. That indirection is the whole
            -- point: the ledger outlives the position, so closing one no longer
            -- erases the record of what opened it.
            (SELECT array_agg(DISTINCT e.tx_hash)
               FROM position_executions pe
               JOIN executions e ON e.id = pe.execution_id
              WHERE pe.position_id = p.id AND e.tx_hash IS NOT NULL) AS tx_hashes
       FROM positions p
      WHERE p.portfolio_id = $1 AND p.status = 'closed'
      ORDER BY p.closed_at DESC
      LIMIT $2`,
    [portfolioId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    marketId: r.market_id,
    asset: r.asset as Asset,
    intervalSec: r.interval_sec,
    leg: r.leg as Leg,
    shares: num(r.shares),
    entryPrice: num(r.entry_price),
    cost: num(r.cost),
    openedAt: secs(r.opened_at),
    closedAt: secs(r.closed_at),
    won: r.won === true,
    proceeds: num(r.proceeds),
    exit: r.exit ?? "settled",
    txHashes: r.tx_hashes ?? [],
  }));
}

/** Recent events for this portfolio — breakers, mismatches, orphans. */
export const events = (portfolioId: string, limit = 30): Promise<RivoEvent[]> => recent(portfolioId, limit);

/**
 * The strategy panel's facts.
 *
 * `eligibility` is computed from the same `permissionFor` the worker calls, so
 * a portfolio cannot be told it is Autopilot-eligible by a UI that reasoned
 * about the mode on its own.
 */
export function strategyView(p: Portfolio): StrategyView {
  const permitted = permissionFor(p, true);
  const onTestnetOnly = permissionFor({ ...p, network: "mainnet" as typeof p.network }, true);
  const eligibility =
    PRODUCTION_STRATEGY.state === "VALIDATED"
      ? "Autopilot Eligible"
      : permitted.mayMoveCapital || (!onTestnetOnly.mayMoveCapital && p.policy.mode === "experimental_testnet")
        ? "Experimental Testnet Only"
        : "No live execution";
  return {
    id: PRODUCTION_STRATEGY.id,
    label: PRODUCTION_STRATEGY.label,
    state: PRODUCTION_STRATEGY.state,
    auc: PRODUCTION_STRATEGY.auc,
    returnOnStake: PRODUCTION_STRATEGY.returnOnStake,
    evidence: PRODUCTION_STRATEGY.evidence,
    note: PRODUCTION_STRATEGY.note,
    eligibility,
    blockedBy: permitted.reasons,
  };
}
