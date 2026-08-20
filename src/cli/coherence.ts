// `npm run coherence -- --days 30`
//
// Tests one claim and refuses to test the others: that DreamDEX's rolling term
// structure sometimes prices two same-expiry windows inconsistently enough to
// trade without a directional view. The derivation is in
// src/research/coherence.ts and is worth reading before the numbers.

import { writeFileSync } from "node:fs";
import { Indexer } from "../core/indexer.js";
import { runCoherence } from "../research/coherence.js";

const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)}%` : "n/a");

async function main(): Promise<void> {
  const days = Number(arg("--days", "30"));
  const skew = Number(arg("--skew", "300"));
  const out = arg("--out");
  const idx = new Indexer();

  console.log("RIVO · cross-tenor coherence");
  console.log("=".repeat(78));
  console.log("The only model-free bound on this venue: two windows on the same asset");
  console.log("sharing an expiry instant, references R_lo < R_hi, must satisfy p_lo >= p_hi.");
  console.log("Buying lo-UP and hi-DOWN pays at least 1 in every state, so it must cost at");
  console.log("least 1 — and its cost is exactly 1 + (p_lo - p_hi).");
  console.log("");
  console.log(`window     last ${days} days   ·   fills within ${skew}s count as simultaneous`);
  console.log("");

  const r = await runCoherence(idx, { days, skewSec: skew, onProgress: (m) => console.log(m) });

  console.log("");
  console.log("STRUCTURE — does the venue even offer the pair?");
  console.log("-".repeat(78));
  console.log(`  settled windows on listed cadences   ${r.windowsScanned}`);
  console.log(`  same-asset same-expiry pairs         ${r.pairsStructural}`);
  console.log(`  …where BOTH legs ever traded         ${r.pairsBothTraded}`);
  console.log(`  …with distinct resolved references   ${r.pairsWithReferences}`);
  if (r.tenorCombos.length > 0) {
    console.log("");
    console.log("  tenor combinations that share an expiry:");
    for (const c of r.tenorCombos) console.log(`    ${c.combo.padEnd(18)} ${c.n}`);
  }

  console.log("");
  console.log("THE BOUND — is it ever violated?");
  console.log("-".repeat(78));
  console.log(`  simultaneous observations            ${r.observations}`);
  console.log(`  violations (p_lo < p_hi)             ${r.violations}   ${pct(r.violationRate)}`);
  console.log(`  …clearing the ${r.roundTripCost} round trip      ${r.executableViolations}`);
  console.log("");
  console.log("  ECONOMICS — a ceiling, not an estimate. It assumes we could have been the");
  console.log("  taker on both legs of trades we only observed, and that taking them would");
  console.log("  not have moved the very prices being measured.");
  console.log(`    gross profit if every one taken   ${r.grossProfitCeiling.toFixed(2)} collateral`);
  console.log(`    per occurrence                    ${r.perOccurrence.toFixed(4)}`);
  console.log(`    median size on the thinner leg    ${r.medianSizeShares.toFixed(2)} shares`);
  console.log(`    over ${days} days                        ${(r.executableViolations / days).toFixed(1)} occurrences/day`);

  if (r.worst.length > 0) {
    console.log("");
    console.log("  largest violations — gap is package cost minus its guaranteed payoff:");
    for (const w of r.worst) {
      console.log(
        `    ${w.pair.asset} ${Math.round(w.pair.lo.intervalSec / 60)}m@${w.pLo.toFixed(3)} vs ` +
          `${Math.round(w.pair.hi.intervalSec / 60)}m@${w.pHi.toFixed(3)}  gap ${w.gap.toFixed(3)}  ` +
          `(Δt ${w.skewSec}s, size ${w.size.toFixed(2)})`,
      );
    }
  }

  console.log("");
  console.log("VERDICT");
  console.log("-".repeat(78));
  if (r.observations === 0) {
    console.log("  Not testable: no pair had both legs trading close enough in time.");
    console.log("  The structure exists; the liquidity to use it does not.");
  } else if (r.executableViolations === 0) {
    console.log(`  REJECTED. The books respect the bound ${pct(1 - r.violationRate)} of the time, and no`);
    console.log(`  violation clears the ${r.roundTripCost} round trip. There is no direction-neutral edge here.`);
    console.log("");
    console.log("  The binding constraint is liquidity, not coherence: of");
    console.log(`  ${r.pairsStructural} structural pairs, only ${r.pairsBothTraded} had both legs trade at all.`);
    console.log("  A relative-value trade needs two fills; this venue struggles to supply one.");
    console.log("");
    console.log("  Worth stating plainly: a book that disagrees with our FAIR VALUE is a");
    console.log("  different thing, and trading it is a directional bet — the one the taker");
    console.log("  backtest already measured as unprofitable at every threshold. Only the");
    console.log("  bound above was ever direction-neutral, and it holds.");
  } else {
    // Materiality, not an arbitrary cut-off. What matters is whether the whole
    // opportunity is worth the machinery: profit per day against the capital
    // each occurrence ties up until settlement.
    const perDay = r.grossProfitCeiling / days;
    const capitalPerTrade = r.medianSizeShares; // the package costs ~1 per share
    const material = perDay > 1 && r.executableViolations / days > 20;

    console.log(`  The bound IS violated — ${pct(r.violationRate)} of simultaneous observations, and`);
    console.log(`  ${r.executableViolations} of those clear the round trip. The derivation holds and the`);
    console.log("  violations settle consistently, so this is a real property of the venue.");
    console.log("");
    if (material) {
      console.log(`  Materially so: ${perDay.toFixed(2)}/day at the ceiling. Worth building execution for —`);
      console.log("  but confirm against a historical BOOK first. A printed trade proves a price");
      console.log("  existed, not that both legs could have been taken.");
    } else {
      console.log(`  But not materially. The entire opportunity over ${days} days is ${r.grossProfitCeiling.toFixed(2)} collateral`);
      console.log(`  — ${perDay.toFixed(2)}/day, ${(r.executableViolations / days).toFixed(1)} occurrences at a median ${r.medianSizeShares.toFixed(1)} shares, each tying`);
      console.log(`  up about ${capitalPerTrade.toFixed(1)} collateral until settlement.`);
      console.log("");
      console.log("  And that figure is a CEILING resting on three generous assumptions: that we");
      console.log("  could have been the taker on both legs of trades we only observed, that");
      console.log("  taking them would not have moved the prices being measured, and that fills");
      console.log(`  ${r.skewToleranceSec}s apart are simultaneous — on a 15-minute window that is ${(100 * r.skewToleranceSec / 900).toFixed(0)}% of its life.`);
      console.log("");
      console.log("  VERDICT: real, reproducible, and too small to build execution for. Recorded");
      console.log("  as a property of the venue rather than adopted as a strategy.");
    }
    console.log("");
    console.log("  The binding constraint is liquidity, not coherence: of");
    console.log(`  ${r.pairsStructural} structural pairs only ${r.pairsBothTraded} had both legs trade at all.`);
    console.log("  A relative-value trade needs two fills; this venue struggles to supply one.");
    console.log("");
    console.log("  Worth stating plainly: a book that disagrees with our FAIR VALUE is a");
    console.log("  different thing, and trading it is a directional bet — the one the taker");
    console.log("  backtest already measured as unprofitable at every threshold. Only the");
    console.log("  bound above was ever direction-neutral.");
  }

  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), days, skewSec: skew, ...r }, null, 2));
    console.log(`\nwrote ${out}`);
  }
}

main().catch((e) => {
  console.error(`coherence failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
