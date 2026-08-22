// `npm start` — Rivo, running.
//
// Give it a budget and a risk profile once. It discovers every live window,
// prices each against its own settlement reference, sizes the whole term
// structure as one exposure, manages what it holds, redeems what settles, and
// redeploys the proceeds. No prompting, no per-trade approval.
//
// DRY_RUN=true is the default, matching every strategy in the kit. Without a
// funded PRIVATE_KEY it stays dry regardless of what the flag says.

import { Indexer } from "../core/indexer.js";
import { profile } from "../portfolio/profiles.js";
import { cycle, type CycleReport } from "../runtime/loop.js";
import { hasSigner, makeExecutor } from "../runtime/executor.js";
import { acquire, release } from "../runtime/lock.js";
import { alerterFromEnv } from "../runtime/alert.js";
import {
  DecisionLog,
  decisionLogPath,
  defaultDataDir,
  emptyState,
  equityOf,
  StateStore,
  statePath,
} from "../runtime/state.js";

const arg = (f: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const money = (x: number) => x.toFixed(2);

/** Cycle interval. Fast enough to catch a 15m window's life, slow enough to be polite. */
const DEFAULT_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const capital = Number(arg("--capital", "50"));
  const prof = profile(arg("--profile"));
  const intervalMs = Number(arg("--interval-ms", String(DEFAULT_INTERVAL_MS)));
  const maxCycles = Number(arg("--cycles", "0")); // 0 = forever
  const dataDir = arg("--data-dir", defaultDataDir())!;

  // Dry run unless BOTH a real key is present and it is explicitly disabled.
  const wantsLive = (process.env.DRY_RUN ?? "true") === "false" || process.argv.includes("--live");
  const dryRun = !wantsLive || !hasSigner();

  // Before anything opens the state file. Two runtimes on one directory both
  // allocate against the same capital and send orders from the same wallet —
  // measured here once, and it drained the wallet while each process's ledger
  // still looked correct to itself.
  const lock = acquire(dataDir);
  if (!lock.ok) {
    const held = lock.heldBy!;
    console.error(`another Rivo already owns ${dataDir} — pid ${held.pid}, started ${new Date(held.startedAt * 1000).toISOString()}.`);
    console.error(`  ${held.argv}`);
    console.error(`Stop it first, or run this one with a different --data-dir.`);
    process.exitCode = 1;
    return;
  }
  process.on("exit", () => release(dataDir));

  const idx = new Indexer();
  const store = new StateStore(statePath(dataDir));
  const log = new DecisionLog(decisionLogPath(dataDir));
  const state = store.load(() => emptyState(capital, prof.name, dryRun));
  const executor = makeExecutor(dryRun);
  // The live executor needs the venue's collateral decimals to size an approval,
  // and an approval is worth a line in the log: it is a transaction the operator
  // did not ask for, sent once per pool before the first order that needs it.
  if (executor.mode === "live") {
    const live = executor as unknown as {
      decimals?: number;
      onApprove?: (p: string, h: string) => void;
      onNote?: (m: string) => void;
    };
    live.decimals = idx.decimals;
    live.onApprove = (pool, hash) => console.log(`  APPROVE pool ${pool.slice(0, 10)}… tx ${hash}`);
    live.onNote = (m) => console.log(`  note: ${m}`);
  }

  console.log("RIVO");
  console.log("=".repeat(78));
  console.log(`mode       ${executor.mode.toUpperCase()}${dryRun && wantsLive ? "  (asked for live, but no funded PRIVATE_KEY — staying dry)" : ""}`);
  console.log(`capital    ${money(state.capital)}   profile ${prof.name}   kelly x${prof.kellyFraction}`);
  console.log(`venue      ${idx.venueId.slice(0, 18)}…   collateral decimals ${idx.decimals}`);
  console.log(`state      ${statePath(dataDir)}`);
  console.log(`decisions  ${decisionLogPath(dataDir)}`);
  if (state.cycles > 0) {
    console.log(
      `resumed    cycle ${state.cycles}, ${state.open.length} open, ${state.closed.length} closed, ` +
        `realised ${money(state.realizedPnl)}`,
    );
  }
  if (lock.tookOverFrom) {
    console.log(`lock       took over from pid ${lock.tookOverFrom.pid}, which is no longer running`);
  }
  if (state.halted) console.log(`HALTED     ${state.halted}`);
  console.log("");

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) process.exit(1); // second signal: give up waiting
    stopping = true;
    console.log(`\n${sig} — finishing this cycle, then stopping. State is saved after every cycle.`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const alerter = alerterFromEnv();
  console.log(`alerts     ${alerter.configured ? "configured" : "none — set RIVO_ALERT_WEBHOOK to be told when it stops"}`);
  console.log("");
  if (executor.mode === "live") {
    void alerter.fire("started", `live run started on ${dataDir} with ${money(state.capital)} of capital`);
  }

  let consecutiveErrors = 0;
  // Generous against a normal cycle (seconds) and decisive against a hang.
  const CYCLE_DEADLINE_MS = Math.max(120_000, intervalMs * 3);
  while (!stopping) {
    const started = Date.now();
    try {
      // A watchdog above the per-request timeouts. Those bound each read; this
      // bounds the CYCLE, so a stall anywhere — an unbounded call added later, a
      // wallet library that swallows its own abort, a pathological retry chain —
      // still ends in an error the loop can recover from rather than a process
      // that sleeps forever holding its state file frozen. Measured: a live run
      // hung exactly this way for two hours and looked healthy the whole time.
      const r = await withDeadline(
        cycle(state, { idx, executor, store, log, profile: prof, out: (l) => console.log(l) }),
        CYCLE_DEADLINE_MS,
      );
      consecutiveErrors = 0;
      // A pass that completed is the recovery signal: let a future failure be
      // news again rather than staying suppressed by the last one.
      alerter.clear("errors");
      heartbeat(r, state.capital, equityOf(state), state.realizedPnl, state.open.length);
      // The breaker firing is the single thing an operator must not learn from a
      // log the next morning. Fired from here rather than from the loop so the
      // loop stays free of I/O that is not the venue's.
      if (state.halted) void alerter.fire("halted", `circuit breaker fired — ${state.halted}`);
    } catch (e) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  cycle error (${consecutiveErrors}): ${msg}`);
      if (process.env.RIVO_TRACE) console.log((e as Error)?.stack ?? "(no stack)");
      // A transient indexer hiccup should not end a multi-day run, but a wall of
      // errors means something is genuinely broken and grinding on will only
      // make the state harder to reason about.
      // Three is worth telling somebody about; ten is worth stopping for.
      if (consecutiveErrors === 3) void alerter.fire("errors", `3 consecutive cycle errors — latest: ${msg.slice(0, 200)}`);
      if (consecutiveErrors >= 10) {
        console.error("\n10 consecutive cycle errors — stopping rather than looping on a broken state.");
        await alerter.fire("stopped", `stopped after 10 consecutive cycle errors — latest: ${msg.slice(0, 200)}`);
        process.exitCode = 1;
        return;
      }
    }
    if (maxCycles > 0 && state.cycles >= maxCycles) break;
    if (stopping) break;
    const elapsed = Date.now() - started;
    await sleep(Math.max(1_000, intervalMs - elapsed), () => stopping);
  }

  console.log("");
  console.log(`stopped after ${state.cycles} cycles · equity ${money(equityOf(state))} · realised ${money(state.realizedPnl)}`);
  if (executor.mode === "live") {
    await alerter.fire("stopped", `run stopped after ${state.cycles} cycles · equity ${money(equityOf(state))}`);
  }
  release(dataDir);
}

/**
 * Reject if `work` has not settled within `ms`.
 *
 * The underlying work is NOT cancelled — it cannot be, once it is in flight —
 * so the timer is unref'd and the loop simply stops waiting on it. That is the
 * right trade: an abandoned cycle may still write state it had already computed,
 * and the next cycle reconciles against the chain before trusting any of it.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cycle exceeded ${(ms / 1000).toFixed(0)}s deadline — abandoning it`)), ms);
    timer.unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function heartbeat(r: CycleReport, capital: number, equity: number, realized: number, open: number): void {
  const t = new Date(r.at * 1000).toISOString().slice(11, 19);
  const deployed = equity - r.cash;
  const parts = [
    `#${String(r.cycle).padStart(4)}`,
    t,
    `${r.windows}w/${r.legs}legs`,
    `open ${open}`,
    `cash ${r.cash.toFixed(2)}`,
    `deployed ${deployed.toFixed(2)}`,
    `equity ${equity.toFixed(2)}`,
    `pnl ${(realized >= 0 ? "+" : "") + realized.toFixed(2)}`,
    `rho ${r.rho.toFixed(2)}`,
  ];
  if (r.reconciled.length > 0) parts.push(`reconciled ${r.reconciled.length}`);
  if (r.settled > 0) parts.push(`settled ${r.settled}`);
  if (r.bought > 0) parts.push(`bought ${r.bought}`);
  if (r.halted) parts.push("HALTED");
  console.log(parts.join(" · "));
  void capital;
}

/** Interruptible sleep — a stop signal should not wait out a full interval. */
async function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < ms; waited += step) {
    if (cancelled()) return;
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}

main().catch((e) => {
  console.error(`rivo failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
