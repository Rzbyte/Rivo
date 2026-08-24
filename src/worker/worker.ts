// The execution plane.
//
// A long-running process that manages many portfolios, and the reason the
// architecture has a third tier at all: a trading cycle is not a request. It
// settles, claims, reconciles and allocates on a clock that has nothing to do
// with anybody being logged in, and the whole promise of the product — configure
// once, close the browser, come back later — is that this keeps running when
// nothing else is.
//
// SHAPE, and why it is a pull rather than a push:
//
//   register -> heartbeat -> claim what is due -> run -> release -> repeat
//
// Nothing assigns work to a worker. Each one asks the database for portfolios
// that are due and unleased, and the database's `FOR UPDATE ... SKIP LOCKED`
// makes that a queue rather than a stampede. Adding a worker adds throughput
// with no coordinator to configure and no partition to rebalance; losing one
// costs the leases it held, for as long as they take to expire.
//
// WHAT IT REFUSES TO DO. It never touches a portfolio it does not hold a current
// lease on, it never runs two cycles for one portfolio at once, and it never
// keeps a lease after it stops being able to renew it. Those are the three ways
// a fleet turns into two runtimes on one wallet, which is the failure that was
// measured once here and drained the wallet while every process's ledger still
// looked correct to itself.

import { hostname } from "node:os";
import { Indexer } from "../core/indexer.js";
import { Intelligence } from "./intelligence.js";
import type { Network } from "../core/config.js";
import { claimDue, heartbeat, registerWorker, release, releaseAll, LEASE_TTL_SEC, type Lease } from "../db/leases.js";
import { portfolioById } from "../db/portfolios.js";
import { record, recordOnce } from "../db/events.js";
import { runPortfolioCycle, summarise } from "./cycle.js";
import { migrate } from "../db/migrate.js";
import { closeDb, configured, safeTarget } from "../db/pool.js";
import { alerterFromEnv, type Alerter } from "../runtime/alert.js";
import { privyConfigured } from "../signing/privy.js";
import { undelivered, markNotified } from "../db/events.js";

export interface WorkerOptions {
  /**
   * How a portfolio's pass is run.
   *
   * Overridable so the SCHEDULER can be tested on its own. The properties worth
   * testing here — one portfolio to one worker, a failing cycle not taking the
   * fleet with it, a lease always released, a portfolio always rescheduled —
   * are properties of this file, and none of them should require a live venue,
   * a funded wallet or a signer to exercise.
   */
  runCycle?: typeof runPortfolioCycle;
  /** How often a portfolio is looked at. */
  intervalSec?: number;
  /** How many portfolios one worker will hold at once. */
  concurrency?: number;
  /** How long to wait when nothing is due. */
  idleMs?: number;
  /** Stop after this many scheduler passes. 0 = forever. Tests, and `--once`. */
  maxPasses?: number;
  /**
   * Run the intelligence tasks — shadow, settlement resolution, calibration.
   *
   * Off unless asked, because a test or a `--once` smoke run measures the
   * scheduler, and a pass that reaches the venue and reads a month of fills is
   * not what either is measuring. The deployed worker turns it on.
   */
  intelligence?: boolean;
  out?: (line: string) => void;
}

const DEFAULTS = {
  intervalSec: 45,
  concurrency: 8,
  idleMs: 5_000,
};

export interface WorkerHealth {
  workerId: string | null;
  startedAt: number;
  passes: number;
  cycles: number;
  failures: number;
  holding: number;
  lastPassAt: number;
  lastError: string | null;
  /**
   * The last time a portfolio cycle completed successfully, anywhere in this
   * process.
   *
   * Distinct from `lastPassAt`, and the distinction is the whole point: a
   * scheduler pass that finds nothing due is a healthy tick, and a worker can
   * tick happily for an hour while every cycle it runs fails against a dead
   * indexer. One number says "the process is alive"; this one says "the work is
   * getting done".
   */
  lastSuccessfulCycleAt: number;
  /**
   * Consecutive failed cycles across every portfolio this worker holds.
   *
   * Fleet-wide rather than per portfolio, on purpose. One portfolio failing
   * repeatedly is that portfolio's problem and is recorded against it; EVERY
   * portfolio failing is the venue, the RPC or the network, and it is the shape
   * that deserves waking somebody.
   */
  consecutiveCycleFailures: number;
}

/**
 * How many cycles must fail in a row before the venue is presumed down.
 *
 * High enough that a single bad indexer response is not news — those happen and
 * the Indexer already retries — and low enough that a genuinely dead venue is
 * reported within a few minutes rather than at the end of a shift.
 */
export const VENUE_DOWN_AFTER = 6;

export class Worker {
  private readonly indexers = new Map<Network, Indexer>();
  private readonly opts: Required<Omit<WorkerOptions, "out" | "runCycle">> & { out: (l: string) => void };
  private stopping = false;
  private alerter: Alerter | null = null;
  private readonly runCycle: typeof runPortfolioCycle;
  readonly health: WorkerHealth = {
    workerId: null,
    startedAt: Math.floor(Date.now() / 1000),
    passes: 0,
    cycles: 0,
    failures: 0,
    holding: 0,
    lastPassAt: 0,
    lastError: null,
    lastSuccessfulCycleAt: 0,
    consecutiveCycleFailures: 0,
  };

  constructor(options: WorkerOptions = {}) {
    this.runCycle = options.runCycle ?? runPortfolioCycle;
    this.opts = {
      intervalSec: options.intervalSec ?? DEFAULTS.intervalSec,
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
      idleMs: options.idleMs ?? DEFAULTS.idleMs,
      maxPasses: options.maxPasses ?? 0,
      intelligence: options.intelligence ?? false,
      out: options.out ?? ((l) => console.log(l)),
    };
    this.intel = this.opts.intelligence ? new Intelligence({ out: this.opts.out }) : null;
  }

  /** An Indexer per network, shared across every portfolio on it. */
  private indexer(net: Network): Indexer {
    let idx = this.indexers.get(net);
    if (!idx) {
      idx = new Indexer(net);
      this.indexers.set(net, idx);
    }
    return idx;
  }

  async start(): Promise<void> {
    if (!configured()) {
      throw new Error(
        "the worker needs DATABASE_URL. It is the execution plane for a multi-user product; " +
          "for a single local portfolio, `npm start` is the one you want.",
      );
    }
    const out = this.opts.out;
    out(`RIVO WORKER`);
    out("=".repeat(78));
    out(`database   ${safeTarget()}`);

    // The worker migrates; the web app only checks. Exactly one component may
    // alter a schema, or a deploy that starts both races itself.
    const m = await migrate();
    if (m.applied.length > 0) out(`migrations ${m.applied.join(", ")}`);

    // A signing configuration that is half-present is worse than one that is
    // absent, and it fails invisibly.
    //
    // With Privy credentials but no authorization key, every portfolio whose
    // owner has enabled Autopilot passes `mayTradeLive`, runs live, and then
    // fails at the first signature — surfacing as "approving pool 0x… failed:
    // An unknown error occurred" on every leg of every cycle. Measured here:
    // 586 identical failures over 560 cycles, none of them naming a cause.
    //
    // The most common way to reach this state is the most boring one: the key
    // was added to .env after the worker started, and `loadEnv` reads the file
    // once at boot.
    if (privyConfigured() && !process.env.PRIVY_AUTHORIZATION_KEY?.trim()) {
      out("");
      out("  WARNING: PRIVY_AUTHORIZATION_KEY is not set, and Privy credentials are.");
      out("  Autopilot portfolios will run LIVE and fail at every signature, because a");
      out("  session signer grants to a key quorum whose private half is that variable.");
      out("  If you have just added it, this process needs restarting — .env is read once.");
      out("");
      await record(null, "signer.key.missing", "error",
        "Worker started with Privy credentials but no PRIVY_AUTHORIZATION_KEY. Autopilot portfolios " +
          "will fail at every signature until it is set and the worker restarted.",
      ).catch(() => undefined);
    }

    const me = await registerWorker(hostname(), process.pid, process.env.RIVO_VERSION);
    this.health.workerId = me.id;
    this.alerter = alerterFromEnv();
    out(`worker     ${me.id} on ${me.hostname} pid ${me.pid}`);
    out(`interval   ${this.opts.intervalSec}s   concurrency ${this.opts.concurrency}   lease ${LEASE_TTL_SEC}s`);
    out(`alerts     ${this.alerter.configured ? "configured" : "none — set RIVO_ALERT_WEBHOOK"}`);
    out("");

    try {
      while (!this.stopping && (this.opts.maxPasses === 0 || this.health.passes < this.opts.maxPasses)) {
        const worked = await this.pass(me.id);
        if (!worked && !this.stopping) await this.sleep(this.opts.idleMs);
      }
    } finally {
      // Give back everything held, so a redeploy costs seconds rather than a
      // full lease TTL of idle portfolios.
      const freed = await releaseAll(me.id).catch(() => 0);
      if (freed > 0) out(`released   ${freed} lease(s) on the way out`);
    }
  }

  /**
   * The intelligence tasks, when this deployment runs them.
   *
   * Off by default in tests and in `--once` runs, because a pass that reaches
   * the venue and a month of fills is not what those are measuring.
   */
  private readonly intel: Intelligence | null;

  /**
   * What the background half is doing, for the health endpoint.
   *
   * Null when this replica does not run intelligence, which is a different and
   * more useful answer than zeroes: "not my job" and "my job, nothing done" look
   * identical in a counter and mean opposite things to whoever is on call.
   */
  get intelligenceHealth(): Intelligence["health"] | null {
    return this.intel?.health ?? null;
  }

  /** One scheduler pass. Returns whether it found anything to do. */
  private async pass(workerId: string): Promise<boolean> {
    this.health.passes++;
    this.health.lastPassAt = Math.floor(Date.now() / 1000);
    try {
      await heartbeat(workerId);
      await this.deliverAlerts();
      // The background half of the product loop: shadow decisions, settlement
      // resolution and calibration refresh. Cheap when nothing is due, and
      // guarded by an advisory lock so exactly one worker in the fleet does it —
      // two recording the same decision would double the evidence rather than
      // deepen it. A failure here is logged and never ends a trading pass.
      if (this.intel) await this.intel.tick().catch(() => undefined);
      const leases = await claimDue(workerId, this.opts.concurrency);
      this.health.holding = leases.length;
      if (leases.length === 0) return false;

      // In parallel, because a portfolio's cycle is almost entirely waiting on
      // an indexer and an RPC. They share nothing: separate state, separate
      // ledger rows, separate signer.
      await Promise.all(leases.map((lease) => this.runOne(lease)));
      return true;
    } catch (e) {
      this.health.failures++;
      this.health.lastError = e instanceof Error ? e.message : String(e);
      this.opts.out(`scheduler pass failed: ${this.health.lastError}`);
      // A failing scheduler must not spin. Whatever is wrong — the database is
      // down, the network is gone — hammering it makes it worse and fills a log
      // nobody can read.
      await this.sleep(this.opts.idleMs);
      return false;
    } finally {
      this.health.holding = 0;
    }
  }

  private async runOne(lease: Lease): Promise<void> {
    try {
      const portfolio = await portfolioById(lease.portfolioId);
      if (!portfolio) {
        this.opts.out(`${lease.portfolioId} vanished between claim and read — releasing`);
        return;
      }
      const outcome = await this.runCycle(portfolio, lease, {
        intervalSec: this.opts.intervalSec,
        indexer: this.indexer(portfolio.network),
        out: (l) => this.opts.out(l),
      });
      this.health.cycles++;
      if (outcome.ok) {
        this.health.lastSuccessfulCycleAt = Math.floor(Date.now() / 1000);
        this.health.consecutiveCycleFailures = 0;
      } else {
        this.health.failures++;
        this.health.consecutiveCycleFailures++;
        await this.reportIfVenueDown(outcome.error ?? "unknown");
      }
      this.opts.out(summarise(portfolio, outcome));
    } catch (e) {
      this.health.failures++;
      this.health.lastError = e instanceof Error ? e.message : String(e);
      this.opts.out(`${lease.portfolioId} threw outside its cycle: ${this.health.lastError}`);
    } finally {
      // ALWAYS. A lease held by a worker that has moved on is a portfolio that
      // stops trading until the TTL expires, and the user cannot see why.
      await release(lease).catch(() => undefined);
    }
  }

  /**
   * Say so when nothing is working, once.
   *
   * Recorded against no portfolio, because it is not a portfolio's problem: a run
   * of failed cycles across everything this worker holds is the venue, the RPC or
   * the network. `recordOnce` bounds it to one report an hour, so a venue that
   * stays down does not become a thousand identical rows.
   */
  private async reportIfVenueDown(lastError: string): Promise<void> {
    if (this.health.consecutiveCycleFailures !== VENUE_DOWN_AFTER) return;
    const since = this.health.lastSuccessfulCycleAt;
    await recordOnce(
      null,
      "venue.unreachable",
      "error",
      `${VENUE_DOWN_AFTER} consecutive cycles failed. ` +
        (since > 0
          ? `The last one that worked was ${new Date(since * 1000).toISOString()}. `
          : `No cycle has succeeded since this worker started. `) +
        `Most recent error: ${lastError}`,
      { workerId: this.health.workerId, consecutiveFailures: this.health.consecutiveCycleFailures },
    ).catch(() => undefined);
  }

  /**
   * Send anything that deserves an alert, once.
   *
   * Delivery is marked in the database rather than in memory, so a restart does
   * not re-send every warning the fleet has ever produced — which is the
   * behaviour that trains people to mute the channel.
   */
  private async deliverAlerts(): Promise<void> {
    if (!this.alerter?.configured) return;
    const pending = await undelivered(10);
    const sent: number[] = [];
    for (const e of pending) {
      // Name the portfolio in the text. Two portfolios can produce the identical
      // message — "Cycle failed: indexer timeout" — and an alert that does not
      // say whose it was is one somebody has to go and look up before they can
      // act on it.
      const where = e.portfolioId ? `[${e.portfolioId.slice(0, 8)}] ` : "";
      const ok = await this.alerter.fire(`event:${e.kind}`, `${where}${e.message}`).catch(() => false);
      // Marked either way. An alert that could not be delivered is not an alert
      // worth retrying forever — the event is still in the table, and retrying a
      // dead webhook on every pass is how a worker spends its time on nothing.
      if (ok !== false) sent.push(e.id);
    }
    await markNotified(sent);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // Do not hold the process open for a sleep during shutdown.
      if (typeof t.unref === "function" && this.stopping) t.unref();
    });
  }

  /** Finish what is in flight, then stop. */
  stop(): void {
    this.stopping = true;
  }

  async shutdown(): Promise<void> {
    this.stop();
    if (this.health.workerId) {
      await releaseAll(this.health.workerId).catch(() => undefined);
      await record(null, "worker.stopped", "info", `worker ${this.health.workerId} stopped`, {
        cycles: this.health.cycles,
        failures: this.health.failures,
      }).catch(() => undefined);
    }
    await closeDb().catch(() => undefined);
  }
}
