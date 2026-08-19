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

  const idx = new Indexer();
  const store = new StateStore(statePath(dataDir));
  const log = new DecisionLog(decisionLogPath(dataDir));
  const state = store.load(() => emptyState(capital, prof.name, dryRun));
  const executor = makeExecutor(dryRun);

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

  let consecutiveErrors = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await cycle(state, { idx, executor, store, log, profile: prof, out: (l) => console.log(l) });
      consecutiveErrors = 0;
      heartbeat(r, state.capital, equityOf(state), state.realizedPnl, state.open.length);
    } catch (e) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  cycle error (${consecutiveErrors}): ${msg}`);
      // A transient indexer hiccup should not end a multi-day run, but a wall of
      // errors means something is genuinely broken and grinding on will only
      // make the state harder to reason about.
      if (consecutiveErrors >= 10) {
        console.error("\n10 consecutive cycle errors — stopping rather than looping on a broken state.");
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
