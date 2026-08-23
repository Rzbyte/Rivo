// `npm run alpha -- --days 90 --folds 5 [--cache f.json] [--out docs/evidence/alpha-research.json]`
//
// Reproduces the whole residual-alpha study: builds the dataset from the public
// indexer, runs every candidate and every mandated baseline through the same
// walk-forward split, and scores them in money.
//
// `--cache` writes the observation set on first run and reads it afterwards. The
// indexer holds roughly a month of history, so the dataset is small and fixed;
// re-fetching it for every experiment only adds a way for two runs of the same
// analysis to disagree.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Indexer } from "../core/indexer.js";
import { buildObservations, type Observation } from "../research/dataset.js";
import { walkForward, edgeBuckets, breakdown, oncePerWindow, type Economics, type WalkForwardResult } from "../research/walkforward.js";
import { marketOnly, takeEverything, diffusion, anyPositiveEdge, favouriteFixed, favouriteLearned, firstFill, residual } from "../research/strategies.js";
import { tenorLabel } from "../core/venue.js";
import { judge, mayExecuteLive, DEFAULT_ACCEPTANCE, type Verdict } from "../research/gating.js";

const arg = (flag: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag: string): boolean => process.argv.includes(flag);

const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const num = (x: number, d = 2): string => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;

function line(name: string, e: Economics): string {
  return [
    name.padEnd(38).slice(0, 38),
    String(e.trades).padStart(6),
    String(e.windows).padStart(5),
    e.stake.toFixed(1).padStart(9),
    num(e.pnl, 2).padStart(9),
    pct(e.returnOnStake).padStart(9),
    (e.tStat === 0 ? "—" : num(e.tStat, 2)).padStart(7),
    `${(e.winRate * 100).toFixed(1)}%`.padStart(7),
    e.maxDrawdown.toFixed(2).padStart(8),
  ].join(" ");
}
const HEADER = [
  "strategy".padEnd(38), "trades".padStart(6), "wins".padStart(5), "stake".padStart(9),
  "P&L".padStart(9), "ROS".padStart(9), "t".padStart(7), "hit".padStart(7), "maxDD".padStart(8),
].join(" ");

async function main(): Promise<void> {
  const days = Number(arg("--days", "90"));
  const folds = Number(arg("--folds", "5"));
  const blocks = (arg("--blocks", "windows") === "time" ? "time" : "windows") as "windows" | "time";
  const cache = arg("--cache");
  const out = arg("--out");
  const bothLegs = has("--both-legs");

  let rows: Observation[];
  if (cache && existsSync(cache)) {
    console.log(`dataset   cached  ${cache}`);
    rows = JSON.parse(readFileSync(cache, "utf8")) as Observation[];
  } else {
    const idx = new Indexer();
    const built = await buildObservations(idx, { days, keepBothLegs: true, onProgress: (m) => console.log(m) });
    rows = built.rows;
    if (cache) {
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify(rows));
    }
  }

  const universe = bothLegs ? rows : rows.filter((r) => r.executable);
  const windows = new Set(universe.map((r) => r.marketId)).size;
  const span: [number, number] = [universe[0]?.at ?? 0, universe[universe.length - 1]?.at ?? 0];

  console.log("");
  console.log("RIVO ALPHA RESEARCH  ·  market-relative residual");
  console.log("=".repeat(102));
  console.log(`dataset    ${universe.length} decision rows across ${windows} settled windows`);
  console.log(`span       ${new Date(span[0] * 1000).toISOString().slice(0, 16)} → ${new Date(span[1] * 1000).toISOString().slice(0, 16)}`);
  console.log(`side       ${bothLegs ? "BOTH legs (assumes a complete set is always available)" : "executable side only (proved takeable by the resting order)"}`);
  console.log(`folds      ${folds} ${blocks === "windows" ? "window-balanced" : "equal-time"} blocks, expanding window, trained only on windows already SETTLED`);
  console.log("");
  console.log("The unit of evidence is the settled window, not the fill: every fill inside one");
  console.log("window shares one outcome. 'wins' below counts windows; the once-per-window table");
  console.log("is the decorrelated view and the one any claim rests on.");
  console.log("");

  const candidates = [
    marketOnly(),
    takeEverything(),
    anyPositiveEdge(),
    diffusion(0.02),
    diffusion(0.03),
    favouriteFixed(0.9),
    favouriteLearned(),
    firstFill(),
    residual({ threshold: 0.005 }),
    residual({ threshold: 0.01 }),
    residual({ threshold: 0.02 }),
    residual({ threshold: 0.01, k: 1 }),
    residual({ threshold: 0.01, k: 2 }),
    residual({ threshold: 0.01, shrink: 0.5 }),
  ];

  const results: WalkForwardResult[] = [];
  for (const c of candidates) {
    process.stdout.write(`  running ${c.name}…`.padEnd(60) + "\r");
    results.push(walkForward(universe, c, { folds, blocks }));
  }
  process.stdout.write(" ".repeat(70) + "\r");

  console.log("EVERY FILL COUNTED (correlated; trade count is inflated by design)");
  console.log(HEADER);
  console.log("-".repeat(102));
  for (const r of results) console.log(line(r.strategy, r.all));

  console.log("");
  console.log("ONE ENTRY PER SETTLED WINDOW  ← the decorrelated view");
  console.log(HEADER);
  console.log("-".repeat(102));
  for (const r of results) console.log(line(r.strategy, r.once));

  // Per-fold, for the strategies that actually traded.
  console.log("");
  console.log("BY TEMPORAL FOLD (once per window)");
  for (const r of results) {
    if (r.once.trades === 0) continue;
    const cells = r.folds.map((f) => `f${f.fold.index}:${pct(f.once.returnOnStake)}(${f.once.windows}w)`).join("  ");
    console.log(`  ${r.strategy.padEnd(38).slice(0, 38)} ${cells}`);
  }

  // The diagnostic that matters most.
  console.log("");
  console.log("DOES A BIGGER CLAIMED EDGE PAY BETTER?  (once per window)");
  for (const r of results) {
    if (r.once.trades < 20) continue;
    const b = edgeBuckets(oncePerWindow(r.trades));
    if (b.length < 2) continue;
    console.log(`  ${r.strategy}`);
    for (const k of b) {
      console.log(
        `    edge ${k.lo.toFixed(3)}–${k.hi === 1 ? "  ∞" : k.hi.toFixed(3)}  n=${String(k.trades).padStart(4)}  meanEdge=${num(k.meanEdge, 4)}  realised ROS=${pct(k.returnOnStake).padStart(9)}`,
      );
    }
  }

  // The gate. Criteria are evaluated, not asserted.
  const baseRate = results.find((r) => r.strategy.startsWith("take every executable fill"));
  const verdicts = new Map<string, Verdict>();
  for (const r of results) {
    if (r.all.trades === 0) continue;
    verdicts.set(
      r.strategy,
      judge(r.all, r.folds.map((f) => ({ fold: f.fold.index, economics: f.all })), baseRate?.all ?? null),
    );
  }

  console.log("");
  console.log("ACCEPTANCE GATE");
  console.log(`  floor: ROS ≥ ${(DEFAULT_ACCEPTANCE.minReturnOnStake * 100).toFixed(0)}%, ≥ ${DEFAULT_ACCEPTANCE.minWindows} windows, t ≥ ${DEFAULT_ACCEPTANCE.minTStat}, ≥ ${DEFAULT_ACCEPTANCE.minPositiveFolds}/${folds - 1} folds non-negative,`);
  console.log(`         survives removal of its best fold, and beats the base rate.`);
  console.log("");
  for (const [name, v] of verdicts) {
    console.log(`  ${v.state === "VALIDATED" ? "PASS" : "FAIL"}  ${name}`);
    for (const f of v.failures) console.log(`        · ${f}`);
  }
  const passed = [...verdicts.entries()].filter(([, v]) => mayExecuteLive(v.state));
  console.log("");
  console.log(
    passed.length === 0
      ? "VERDICT  no candidate is eligible for live execution. Production strategy unchanged."
      : `VERDICT  ${passed.length} candidate(s) eligible: ${passed.map(([n]) => n).join(", ")}`,
  );

  const best = results
    .filter((r) => r.once.trades >= 30)
    .sort((a, b) => b.once.returnOnStake - a.once.returnOnStake)[0];
  if (best) {
    const once = oncePerWindow(best.trades);
    console.log("");
    console.log(`BREAKDOWN · ${best.strategy} (once per window)`);
    console.log("  by asset");
    for (const [k, e] of Object.entries(breakdown(once, (t) => t.asset))) console.log(`    ${line(k, e)}`);
    console.log("  by tenor");
    for (const [k, e] of Object.entries(breakdown(once, (t) => tenorLabel(t.intervalSec)))) console.log(`    ${line(k, e)}`);
    console.log("  by leg");
    for (const [k, e] of Object.entries(breakdown(once, (t) => t.leg))) console.log(`    ${line(k, e)}`);
  }

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          dataset: { rows: universe.length, windows, span, executableOnly: !bothLegs, days },
          folds,
          blocks,
          acceptance: DEFAULT_ACCEPTANCE,
          verdict: passed.length === 0 ? "no candidate eligible for live execution" : passed.map(([n]) => n).join(", "),
          results: results.map((r) => ({
            strategy: r.strategy,
            gate: verdicts.get(r.strategy) ?? null,
            all: r.all,
            once: r.once,
            byFold: r.folds.map((f) => ({ fold: f.fold.index, testStart: f.fold.testStart, trainWindows: f.fold.trainWindows, all: f.all, once: f.once })),
            edgeBuckets: edgeBuckets(oncePerWindow(r.trades)),
            byAsset: breakdown(oncePerWindow(r.trades), (t) => t.asset),
            byTenor: breakdown(oncePerWindow(r.trades), (t) => tenorLabel(t.intervalSec)),
            byLeg: breakdown(oncePerWindow(r.trades), (t) => t.leg),
          })),
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${out}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
