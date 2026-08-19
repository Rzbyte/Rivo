// `npm run calibrate` — the evidence pack.
//
// Replays every settled DreamDEX Event Contract window against Rivo's fair-value
// model and reports whether the model's probabilities are worth betting on:
// discrimination (does it rank?), calibration (is its confidence honest?), and
// the shrinkage factor the position sizer must apply.
//
// Runs with no private key. Every number below is reproducible from public
// indexers by anyone reading the submission.

import { Indexer } from "../core/indexer.js";
import { BASE_RATE_UP } from "../model/fairvalue.js";
import { buildDataset, DEFAULT_SAMPLE_POINTS, DEFAULT_VOL_LOOKBACK_MIN, TRADEABLE_CADENCES } from "./dataset.js";
import {
  applyPlatt,
  auc,
  brierOfConstant,
  brierOptimalShrinkage,
  brierScore,
  brierSkill,
  fitPlatt,
  logLoss,
  reliability,
  type Prediction,
} from "./metrics.js";
import { writeFileSync } from "node:fs";

interface Args {
  days: number;
  maxMarkets: number;
  cadences: number[];
  tradedOnly: boolean;
  volLookbackMin: number;
  bins: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const v = get(flag);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${flag} expects a number, got "${v}"`);
    return n;
  };
  const cadenceArg = get("--cadences");
  const cadences = argv.includes("--all-cadences")
    ? []
    : cadenceArg
      ? cadenceArg.split(",").map((x) => Number(x.trim()))
      : [...TRADEABLE_CADENCES];
  return {
    days: num("--days", 30),
    maxMarkets: num("--max-markets", 20_000),
    cadences,
    tradedOnly: argv.includes("--traded-only"),
    volLookbackMin: num("--vol-lookback", DEFAULT_VOL_LOOKBACK_MIN),
    bins: num("--bins", 10),
    out: get("--out"),
  };
}

const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : "n/a");

function bar(freq: number, meanP: number, width = 34): string {
  // Two markers on one axis: where the model said it was (|) and where it
  // actually landed (#). Their separation IS the miscalibration.
  const cells = new Array(width).fill("·");
  const at = (v: number) => Math.min(width - 1, Math.max(0, Math.round(v * (width - 1))));
  cells[at(meanP)] = "|";
  cells[at(freq)] = cells[at(meanP)] === "|" && at(freq) === at(meanP) ? "X" : "#";
  return cells.join("");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const idx = new Indexer();
  const sinceExpiry = Math.floor(Date.now() / 1000) - args.days * 86_400;

  console.log("RIVO · calibration study");
  console.log("=".repeat(78));
  console.log(`venue      ${idx.venueId}`);
  console.log(`window     last ${args.days} days`);
  console.log(
    `cadences   ${args.cadences.length ? args.cadences.map((c) => `${c}s`).join(", ") : "ALL (including retired test series)"}`,
  );
  console.log(`universe   ${args.tradedOnly ? "windows that ACTUALLY TRADED only" : "all settled windows"}`);
  console.log(`sampling   ${DEFAULT_SAMPLE_POINTS.map((p) => `${p * 100}%`).join(", ")} through each window's life`);
  console.log(`vol        realized, ${args.volLookbackMin}-minute lookback, per-minute log returns`);
  console.log("");

  const ds = await buildDataset(idx, {
    sinceExpiry,
    maxMarkets: args.maxMarkets,
    cadences: args.cadences,
    tradedOnly: args.tradedOnly,
    volLookbackMin: args.volLookbackMin,
    onProgress: (m) => console.log(m),
  });

  if (ds.samples.length === 0) {
    console.log("\nNo forecasts produced. Skip reasons:");
    for (const [why, n] of Object.entries(ds.skipped).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${why}`);
    }
    process.exitCode = 1;
    return;
  }

  const preds: Prediction[] = ds.samples.map((s) => ({ p: s.p, y: s.y }));
  const upRate = preds.reduce((a, d) => a + d.y, 0) / preds.length;

  const bModel = brierScore(preds);
  const bCoin = brierOfConstant(preds, 0.5);
  const bPrior = brierOfConstant(preds, BASE_RATE_UP);
  const slope = brierOptimalShrinkage(preds, BASE_RATE_UP);
  const shrunk = preds.map((d) => ({ p: BASE_RATE_UP + slope * (d.p - BASE_RATE_UP), y: d.y }));
  const bShrunk = brierScore(shrunk);
  const a = auc(preds);

  console.log("");
  console.log("SAMPLE");
  console.log("-".repeat(78));
  console.log(`  settled windows pulled     ${ds.marketsTotal}`);
  console.log(`  windows priced             ${ds.marketsUsed}`);
  console.log(`  forecasts scored           ${preds.length}`);
  console.log(`  period                     ${new Date(ds.from * 1000).toISOString().slice(0, 16)} -> ${new Date(ds.to * 1000).toISOString().slice(0, 16)} UTC`);
  console.log(`  realized UP rate           ${pct(upRate)}   (at-inception prior ${pct(BASE_RATE_UP)})`);
  if (Object.keys(ds.skipped).length > 0) {
    console.log("  skipped:");
    for (const [why, n] of Object.entries(ds.skipped).sort((x, z) => z[1] - x[1])) {
      console.log(`    ${String(n).padStart(6)}  ${why}`);
    }
  }

  console.log("");
  console.log("DISCRIMINATION — does the model rank outcomes at all?");
  console.log("-".repeat(78));
  console.log(`  AUC                        ${f3(a)}   (0.50 = coin flip, <0.50 = inverted)`);

  console.log("");
  console.log("CALIBRATION — is its stated confidence honest?");
  console.log("-".repeat(78));
  console.log(`  Brier, model               ${f3(bModel)}`);
  console.log(`  Brier, always 0.5          ${f3(bCoin)}      skill ${pct(brierSkill(bModel, bCoin))}`);
  console.log(`  Brier, always prior        ${f3(bPrior)}      skill ${pct(brierSkill(bModel, bPrior))}`);
  console.log(`  log loss                   ${f3(logLoss(preds))}`);

  console.log("");
  console.log("RELIABILITY — | = model said, # = market settled, X = agreement");
  console.log("-".repeat(78));
  console.log("   bin        n     said   settled   gap   0" + " ".repeat(30) + "1");
  for (const b of reliability(preds, args.bins)) {
    const gap = b.freq - b.meanP;
    console.log(
      `  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)} ${String(b.n).padStart(7)}  ` +
        `${b.meanP.toFixed(3)}    ${b.freq.toFixed(3)}  ${gap >= 0 ? "+" : ""}${gap.toFixed(3)}   ${bar(b.freq, b.meanP)}`,
    );
  }

  console.log("");
  console.log("IN-SAMPLE FIT — diagnostic only; the holdout below is the authority");
  console.log("-".repeat(78));
  console.log(`  Brier-optimal slope k      ${f3(slope)}   (1.0 = confidence exactly earned)`);
  console.log(`  Brier after shrinking      ${f3(bShrunk)}   vs ${f3(bModel)} raw`);
  console.log("");
  console.log("  A correction fitted here is fitted to this period's noise as well as its");
  console.log("  signal. Whether any of it generalises is the next section's question.");

  // ---- Out-of-sample validation -------------------------------------------
  // Fitting a correction on the same forecasts it is scored against flatters it:
  // the parameters are chosen to minimise exactly the Brier we then report. The
  // honest test is temporal — fit on the earlier windows, apply to the later
  // ones, and see which correction still helps on data it never saw.
  //
  // Three candidates compete, including doing nothing. "Do nothing" winning is a
  // real and useful outcome: it means the model is already calibrated and any
  // correction is noise-fitting.
  const ordered = [...ds.samples].sort((x, z) => x.settleAt - z.settleAt);
  const cut = Math.floor(ordered.length * 0.7);
  const trainS = ordered.slice(0, cut);
  const testS = ordered.slice(cut);
  const train = trainS.map((d) => ({ p: d.p, y: d.y }));
  const test = testS.map((d) => ({ p: d.p, y: d.y }));

  console.log("");
  console.log("OUT-OF-SAMPLE — fitted on the first 70% of windows, scored on the last 30%");
  console.log("-".repeat(78));

  let chosen: { name: string; apply: (p: number, phase: number) => number } = {
    name: "none (model as-is)",
    apply: (p) => p,
  };

  if (train.length > 500 && test.length > 500) {
    const splitAt = new Date(trainS[trainS.length - 1]!.settleAt * 1000).toISOString().slice(0, 16);
    console.log(`  split at                   ${splitAt} UTC   (${train.length} train / ${test.length} test)`);

    const kTrain = brierOptimalShrinkage(train, BASE_RATE_UP);
    const plattAll = fitPlatt(train);
    // Phase-conditional: the model is least reliable early, when sigma over the
    // remaining life is largest and the volatility estimate least informative.
    // A per-phase map lets the correction say so instead of averaging it away.
    const phases = [...new Set(ds.samples.map((s) => s.phase))].sort((x, z) => x - z);
    const plattByPhase = new Map<number, ReturnType<typeof fitPlatt>>();
    for (const ph of phases) plattByPhase.set(ph, fitPlatt(trainS.filter((d) => d.phase === ph).map((d) => ({ p: d.p, y: d.y }))));

    const candidates: { name: string; apply: (p: number, phase: number) => number }[] = [
      { name: "none (model as-is)", apply: (p) => p },
      { name: "linear shrink", apply: (p) => BASE_RATE_UP + kTrain * (p - BASE_RATE_UP) },
      { name: "Platt (global)", apply: (p) => applyPlatt(plattAll, p) },
      { name: "Platt (per phase)", apply: (p, phase) => applyPlatt(plattByPhase.get(phase) ?? plattAll, p) },
    ];

    const bCoin = brierOfConstant(test, 0.5);
    console.log("");
    console.log("  correction              holdout Brier   skill    logloss   params");
    let best = { name: "", brier: Infinity, apply: candidates[0]!.apply };
    for (const c of candidates) {
      const scored = testS.map((d) => ({ p: c.apply(d.p, d.phase), y: d.y }));
      const b = brierScore(scored);
      const params =
        c.name === "linear shrink"
          ? `k=${f3(kTrain)}`
          : c.name === "Platt (global)"
            ? `a=${f3(plattAll.a)} b=${f3(plattAll.b)}`
            : c.name === "Platt (per phase)"
              ? phases.map((ph) => `${Math.round(ph * 100)}%:a=${(plattByPhase.get(ph)?.a ?? 1).toFixed(2)}`).join(" ")
              : "-";
      console.log(
        `  ${c.name.padEnd(22)}  ${f3(b)}      ${pct(brierSkill(b, bCoin)).padStart(7)}   ${f3(logLoss(scored))}   ${params}`,
      );
      if (b < best.brier) best = { name: c.name, brier: b, apply: c.apply };
    }
    chosen = { name: best.name, apply: best.apply };
    console.log("");
    console.log(`  holdout AUC                ${f3(auc(test))}   (discrimination is unaffected by calibration)`);
    console.log(`  WINNER                     ${best.name}`);
    if (best.name === "none (model as-is)") {
      console.log("  The model needs no correction on held-out data. Size from it directly,");
      console.log("  with the risk profile's fractional-Kelly multiplier as the only haircut.");
    } else {
      console.log("  Apply this map before sizing. Refit it as the sample grows.");
    }
  } else {
    console.log("  not enough data to split; widen --days");
  }
  void chosen;

  console.log("");
  console.log("BY CADENCE");
  console.log("-".repeat(78));
  console.log("  cadence        n     AUC    Brier    k");
  for (const iv of [...new Set(ds.samples.map((s) => s.intervalSec))].sort((x, z) => x - z)) {
    const sub = ds.samples.filter((s) => s.intervalSec === iv).map((s) => ({ p: s.p, y: s.y }));
    if (sub.length < 50) continue;
    console.log(
      `  ${String(iv).padStart(6)}s ${String(sub.length).padStart(7)}  ${f3(auc(sub))}  ${f3(brierScore(sub))}  ${f3(brierOptimalShrinkage(sub, BASE_RATE_UP))}`,
    );
  }

  console.log("");
  console.log("BY PHASE OF WINDOW");
  console.log("-".repeat(78));
  console.log("  phase          n     AUC    Brier    k");
  for (const ph of [...new Set(ds.samples.map((s) => s.phase))].sort((x, z) => x - z)) {
    const sub = ds.samples.filter((s) => s.phase === ph).map((s) => ({ p: s.p, y: s.y }));
    if (sub.length < 50) continue;
    console.log(
      `  ${String(Math.round(ph * 100)).padStart(5)}% ${String(sub.length).padStart(7)}  ${f3(auc(sub))}  ${f3(brierScore(sub))}  ${f3(brierOptimalShrinkage(sub, BASE_RATE_UP))}`,
    );
  }

  if (args.out) {
    const report = {
      generatedAt: new Date().toISOString(),
      venueId: idx.venueId,
      period: { from: ds.from, to: ds.to },
      cadences: args.cadences,
    tradedOnly: args.tradedOnly,
      sample: { marketsTotal: ds.marketsTotal, marketsUsed: ds.marketsUsed, forecasts: preds.length, realizedUpRate: upRate },
      discrimination: { auc: a },
      calibration: { brier: bModel, brierCoin: bCoin, brierPrior: bPrior, logLoss: logLoss(preds) },
      shrinkage: { prior: BASE_RATE_UP, slope, brierAfter: bShrunk },
      reliability: reliability(preds, args.bins),
      // Breakdowns are written out so the evidence file stands alone: anything
      // quoted in the docs should be checkable from the artefact, not only from
      // re-running the command and trusting that the venue has not moved.
      byPhase: [...new Set(ds.samples.map((s) => s.phase))]
        .sort((x, z) => x - z)
        .map((ph) => {
          const sub = ds.samples.filter((s) => s.phase === ph).map((s) => ({ p: s.p, y: s.y }));
          return { phase: ph, n: sub.length, auc: auc(sub), brier: brierScore(sub) };
        }),
      byCadence: [...new Set(ds.samples.map((s) => s.intervalSec))]
        .sort((x, z) => x - z)
        .map((iv) => {
          const sub = ds.samples.filter((s) => s.intervalSec === iv).map((s) => ({ p: s.p, y: s.y }));
          return { intervalSec: iv, n: sub.length, auc: auc(sub), brier: brierScore(sub) };
        }),
      holdout: (() => {
        const ord = [...ds.samples].sort((x, z) => x.settleAt - z.settleAt);
        const c = Math.floor(ord.length * 0.7);
        const te = ord.slice(c).map((d) => ({ p: d.p, y: d.y }));
        return te.length > 200
          ? { n: te.length, auc: auc(te), brier: brierScore(te), brierCoin: brierOfConstant(te, 0.5) }
          : null;
      })(),
      skipped: ds.skipped,
    };
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${args.out}`);
  }
}

main().catch((e) => {
  console.error(`\ncalibration failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
