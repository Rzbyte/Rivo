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
import type { Network } from "../core/config.js";
import { claimDue, heartbeat, registerWorker, release, releaseAll, LEASE_TTL_SEC, type Lease } from "../db/leases.js";
import { portfolioById } from "../db/portfolios.js";
import { record } from "../db/events.js";
import { runPortfolioCycle, summarise } from "./cycle.js";
import { migrate } from "../db/migrate.js";
import { closeDb, configured, safeTarget } from "../db/pool.js";
import { alerterFromEnv, type Alerter } from "../runtime/alert.js";
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
}

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
  };

  constructor(options: WorkerOptions = {}) {
    this.runCycle = options.runCycle ?? runPortfolioCycle;
    this.opts = {
      intervalSec: options.intervalSec ?? DEFAULTS.intervalSec,
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
      idleMs: options.idleMs ?? DEFAULTS.idleMs,
      maxPasses: options.maxPasses ?? 0,
      out: options.out ?? ((l) => console.log(l)),
    };
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

  /** One scheduler pass. Returns whether it found anything to do. */
  private async pass(workerId: string): Promise<boolean> {
    this.health.passes++;
    this.health.lastPassAt = Math.floor(Date.now() / 1000);
    try {
      await heartbeat(workerId);
      await this.deliverAlerts();
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
      if (!outcome.ok) this.health.failures++;
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
