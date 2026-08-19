// Sweep the edge band.
//
// Rivo has an edge FLOOR and no ceiling. The kit's own oracle-follow strategy has
// both, and its README says why: "A very large gap on a liquid book usually means
// the model and the book disagree on the question or inputs, not a free 25-cent
// edge." The measured P&L says the same thing far more bluntly — the biggest
// claimed edges are where the money goes.
//
// There is a second reason a floor alone is not enough, and it is statistical
// rather than adversarial. Selecting the leg that maximises (model − price)
// selects for the leg where the MODEL'S ERROR is most positive. Even an unbiased
// model, filtered that way, is biased on the trades it takes. That is the
// winner's curse, and the remedy is the same: refuse the extremes.

import { Indexer } from "../core/indexer.js";
import { buildChances, type Chance } from "../backtest/replay.js";

const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};

interface BandResult {
  floor: number;
  ceiling: number;
  n: number;
  pnlPerStake: number;
  realized: number;
  price: number;
}

function evaluate(chances: Chance[], floor: number, ceiling: number): BandResult {
  let n = 0;
  let stake = 0;
  let pnl = 0;
  let won = 0;
  for (const c of chances) {
    if (c.edge < floor || c.edge > ceiling) continue;
    n++;
    stake += c.price;
    pnl += c.won - c.price;
    won += c.won;
  }
  return {
    floor,
    ceiling,
    n,
    pnlPerStake: stake > 0 ? pnl / stake : NaN,
    realized: n > 0 ? won / n : NaN,
    price: n > 0 ? stake / n : NaN,
  };
}

async function main(): Promise<void> {
  const idx = new Indexer();
  const days = Number(arg("--days", "30"));
  const { chances } = await buildChances(idx, { days, onProgress: () => {} });
  console.log("RIVO · edge-band sweep");
  console.log("=".repeat(88));
  console.log(`  ${chances.length} positive-edge chances over ${days} days`);
  console.log("");

  const floors = [0.0, 0.02, 0.03, 0.05, 0.08, 0.12];
  const ceilings = [0.05, 0.08, 0.12, 0.2, 0.35, 1.0];

  console.log("  P&L per unit staked, by edge band (rows = floor, cols = ceiling)");
  console.log("  " + "-".repeat(84));
  console.log("  floor \\ ceil " + ceilings.map((c) => c.toFixed(2).padStart(11)).join(""));
  const best: BandResult[] = [];
  for (const f of floors) {
    const cells: string[] = [];
    for (const c of ceilings) {
      if (c <= f) {
        cells.push("".padStart(11));
        continue;
      }
      const r = evaluate(chances, f, c);
      best.push(r);
      const v = Number.isFinite(r.pnlPerStake) ? `${(r.pnlPerStake * 100).toFixed(1)}%` : "—";
      cells.push(`${v}`.padStart(11));
    }
    console.log(`  ${f.toFixed(2).padStart(11)} ` + cells.join(""));
  }

  console.log("");
  console.log("  sample sizes");
  console.log("  " + "-".repeat(84));
  for (const f of floors) {
    const cells = ceilings.map((c) => (c <= f ? "".padStart(11) : String(evaluate(chances, f, c).n).padStart(11)));
    console.log(`  ${f.toFixed(2).padStart(11)} ` + cells.join(""));
  }

  const viable = best.filter((r) => r.n >= 500).sort((a, b) => b.pnlPerStake - a.pnlPerStake);
  console.log("");
  console.log("BEST BANDS (n >= 500)");
  console.log("-".repeat(88));
  for (const r of viable.slice(0, 6)) {
    console.log(
      `  edge ${r.floor.toFixed(2)}–${r.ceiling.toFixed(2)}   n=${String(r.n).padStart(6)}   ` +
        `P&L/stake ${(r.pnlPerStake * 100).toFixed(2).padStart(7)}%   won ${(r.realized * 100).toFixed(1)}%   avg price ${r.price.toFixed(3)}`,
    );
  }
  const top = viable[0];
  console.log("");
  if (top && top.pnlPerStake > 0) {
    console.log(`  A band exists that is profitable on this sample: edge ${top.floor.toFixed(2)}–${top.ceiling.toFixed(2)}.`);
    console.log("  Treat it as a hypothesis, not a result — it is the best of many cells tried on");
    console.log("  one period, which is exactly how overfitting looks. It needs a holdout before");
    console.log("  it goes anywhere near the allocator.");
  } else {
    console.log("  NO band is profitable on this sample. Taking liquidity against this flow does");
    console.log("  not work at any threshold, and no amount of position sizing repairs a negative");
    console.log("  core. The edge has to come from somewhere else.");
  }
}

main().catch((e) => {
  console.error(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
