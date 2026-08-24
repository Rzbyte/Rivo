// The background half of the product loop.
//
// Shadow decisions, settlement resolution and calibration refresh are periodic
// work, not request work — and they were CLI commands, which means they ran when
// somebody remembered. A product whose central claim is "every settled Event
// Contract becomes new evidence" cannot depend on a terminal window staying
// open.
//
// This runs inside the existing worker rather than beside it. The worker already
// has a loop, a heartbeat, a health endpoint and a lease table; a second service
// would duplicate all four to do less.
//
// EXACTLY ONE WORKER DOES THIS AT A TIME. Portfolios are shared out by lease so
// several workers are more throughput; this is different — two processes both
// recording shadow decisions for the same market at the same instant would
// double the evidence rather than deepen it, and two recomputing calibration
// would race for the same rows. A Postgres advisory lock is the whole
// coordination mechanism: whoever holds it does the work, everyone else skips
// the pass and keeps trading.

import { query } from "../db/pool.js";
import { Indexer } from "../core/indexer.js";
import { snapshot } from "../engine/scan.js";
import { askAgent, referenceAgent, type EventContext } from "../intel/agent.js";
import { recordShadow, pendingShadow, resolveShadow, payout, hypotheticalPnl } from "../intel/shadow.js";
import { calibrate, cohortsOf } from "../intel/calibration.js";
import { buildObservations } from "../research/dataset.js";
import { network } from "../core/config.js";
import type { Leg } from "../engine/book.js";

/** Arbitrary, constant, and this task's alone. Distinct from the migration lock. */
const INTEL_LOCK = 0x52_49_4e_54; // "RINT"

export interface IntelligenceOptions {
  /** Seconds between shadow passes. */
  shadowEverySec?: number;
  /** Seconds between calibration recomputes. Expensive; hours, not minutes. */
  calibrateEverySec?: number;
  /** Days of history each calibration pass reads. */
  calibrationDays?: number;
  /** Collateral an agent may ask for on one leg. */
  maxNotional?: number;
  out?: (s: string) => void;
}

const DEFAULTS = {
  shadowEverySec: 90,
  calibrateEverySec: 3 * 60 * 60,
  calibrationDays: 90,
  maxNotional: 5,
} as const;

interface AgentRow {
  id: string; slug: string; kind: string; endpoint: string | null; auth_header: string | null; state: string;
}

export interface IntelligenceHealth {
  shadowPasses: number;
  shadowDecisions: number;
  shadowResolved: number;
  calibrationRuns: number;
  lastShadowAt: number;
  lastCalibrationAt: number;
  lastError: string | null;
  /** False when another worker holds the lock — normal, not a fault. */
  leading: boolean;
}

/**
 * Periodic intelligence work, driven by the worker's own loop.
 *
 * `tick` is cheap and idempotent: it checks the clock, takes the lock only when
 * something is actually due, and returns immediately otherwise. The worker calls
 * it every pass without thinking about cadence.
 */
export class Intelligence {
  readonly health: IntelligenceHealth = {
    shadowPasses: 0, shadowDecisions: 0, shadowResolved: 0, calibrationRuns: 0,
    lastShadowAt: 0, lastCalibrationAt: 0, lastError: null, leading: false,
  };

  private readonly opts: Required<Omit<IntelligenceOptions, "out">> & { out: (s: string) => void };
  private readonly idx = new Indexer();
  /** Deployment per agent, refreshed with the agent list. */
  private readonly deployments = new Map<string, string | null>();

  constructor(o: IntelligenceOptions = {}) {
    this.opts = {
      shadowEverySec: o.shadowEverySec ?? DEFAULTS.shadowEverySec,
      calibrateEverySec: o.calibrateEverySec ?? DEFAULTS.calibrateEverySec,
      calibrationDays: o.calibrationDays ?? DEFAULTS.calibrationDays,
      maxNotional: o.maxNotional ?? DEFAULTS.maxNotional,
      out: o.out ?? (() => {}),
    };
  }

  /** Call once per worker pass. Does nothing unless something is due. */
  async tick(now = Math.floor(Date.now() / 1000)): Promise<void> {
    const shadowDue = now - this.health.lastShadowAt >= this.opts.shadowEverySec;
    const calibrationDue = now - this.health.lastCalibrationAt >= this.opts.calibrateEverySec;
    if (!shadowDue && !calibrationDue) return;

    // Non-blocking: a worker that cannot get the lock is not behind, it is
    // simply not the one doing this. Blocking here would stall its portfolios.
    const [lock] = await query<{ got: boolean }>(`SELECT pg_try_advisory_lock($1) AS got`, [INTEL_LOCK]);
    this.health.leading = lock?.got === true;
    if (!this.health.leading) return;

    try {
      if (shadowDue) await this.shadowPass(now);
      if (calibrationDue) await this.calibrationPass(now);
      this.health.lastError = null;
    } catch (e) {
      // One bad pass must not end the worker. The venue is somebody else's
      // service and the indexer is somebody else's database.
      this.health.lastError = e instanceof Error ? e.message : String(e);
      this.opts.out(`  intelligence pass failed: ${this.health.lastError}`);
    } finally {
      await query(`SELECT pg_advisory_unlock($1)`, [INTEL_LOCK]).catch(() => undefined);
    }
  }

  /** Ask every agent about every live leg, and record what they would do. */
  private async shadowPass(now: number): Promise<void> {
    this.health.lastShadowAt = now;
    this.health.shadowPasses++;

    const agents = await query<AgentRow>(
      `SELECT id, slug, kind, endpoint, auth_header, state FROM agents ORDER BY created_at`,
    );
    if (agents.length === 0) return;

    for (const a of agents) {
      if (!this.deployments.has(a.id)) {
        const [row] = await query<{ id: string }>(
          `SELECT id FROM portfolios WHERE agent_id = $1 ORDER BY created_at LIMIT 1`,
          [a.id],
        );
        this.deployments.set(a.id, row?.id ?? null);
      }
    }

    const snap = await snapshot(this.idx);
    const rivo = referenceAgent();
    let recorded = 0;

    for (const a of agents) {
      for (const o of snap.opportunities) {
        // Skip a leg the engine could not price at all: there is nothing to ask
        // an agent about, and a decision recorded against a null price would be
        // evidence about nothing.
        if (o.blocked && !o.blocked.startsWith("edge")) continue;

        const ctx: EventContext = {
          market: {
            marketId: o.marketId, asset: o.asset, leg: o.leg as Leg,
            intervalSec: o.intervalSec, expiry: o.expiry,
            secondsLeft: Math.max(0, o.expiry - snap.at),
          },
          price: { bid: o.bid, ask: o.ask, depth: o.depthAtFair },
          reference: {
            spot: snap.assets.get(o.asset)?.spot ?? null,
            probability: Number.isFinite(o.fair) ? o.fair : null,
          },
          limits: { maxNotional: this.opts.maxNotional },
        };

        const d =
          a.kind === "http" && a.endpoint
            ? await askAgent(a.endpoint, ctx, {
                headers: a.auth_header ? { authorization: a.auth_header } : undefined,
              })
            : rivo(ctx);

        await recordShadow({
          agentId: a.id,
          portfolioId: this.deployments.get(a.id) ?? null,
          marketId: o.marketId, asset: o.asset, leg: o.leg as Leg,
          intervalSec: o.intervalSec, expiry: o.expiry,
          marketPrice: o.ask ?? o.mid ?? 0,
          agentPrice: d.probability, confidence: d.confidence,
          action: d.action, reason: d.reason,
          hypotheticalSize: d.action === "ENTER" ? d.notional : null,
          hypotheticalEntry: d.action === "ENTER" ? o.ask : null,
        });
        recorded++;
      }
    }
    this.health.shadowDecisions += recorded;

    const resolved = await this.resolvePass();
    this.opts.out(`  intelligence: ${recorded} shadow decision(s), ${resolved} resolved`);
  }

  /** Write settled outcomes onto shadow rows whose contract has finalised. */
  private async resolvePass(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const pending = await pendingShadow(now);
    if (pending.length === 0) return 0;

    const outcomes = await this.idx.outcomes([...new Set(pending.map((p) => p.marketId))]);
    let done = 0;
    for (const p of pending) {
      const o = outcomes.get(p.marketId.toLowerCase()) ?? outcomes.get(p.marketId);
      if (!o || !o.finalized) continue; // expiry is not finalisation
      const settled = payout(p.leg, o.winningOutcome, o.voided);
      if (settled === null) continue; // voided: no outcome to record
      if (await resolveShadow(p.id, settled, hypotheticalPnl(settled, p.hypotheticalEntry, p.hypotheticalSize))) done++;
    }
    this.health.shadowResolved += done;
    return done;
  }

  /**
   * Recompute calibration from everything that has settled.
   *
   * Expensive — it reads a month of fills across every settled window — which is
   * why it runs on a multi-hour cadence and why it was a manual command until
   * now. Writing a new row per cohort rather than updating in place keeps the
   * history: a calibration claim is a claim as of a date, and overwriting the
   * previous one destroys the ability to say what was known when.
   */
  private async calibrationPass(now: number): Promise<void> {
    this.health.lastCalibrationAt = now;
    const built = await buildObservations(this.idx, { days: this.opts.calibrationDays, keepBothLegs: true });
    const executable = built.rows.filter((r) => r.executable);
    if (executable.length === 0) return;

    let stored = 0;
    for (const [, { cohort, rows }] of cohortsOf(executable)) {
      const rep = calibrate(rows, { basis: "window" });
      await query(
        `INSERT INTO calibration_reports
           (network, asset, interval_sec, basis, observations, windows, period_from, period_to, brier, skill, report)
         VALUES ($1, $2, $3, 'window', $4, $5, to_timestamp($6), to_timestamp($7), $8, $9, $10)`,
        [network(), cohort.asset, cohort.intervalSec, rep.n, rep.windows, rep.from, rep.to, rep.brier, rep.skill, JSON.stringify(rep)],
      );
      stored++;
    }
    this.health.calibrationRuns++;
    this.opts.out(`  intelligence: recomputed ${stored} calibration cohort(s) from ${built.windows} settled windows`);
  }
}
