// Is the losing hit rate a property of the model, or of how the sample is weighted?
//
// Fills are not spread evenly. A contested window can print a hundred trades
// while a quiet one prints two, so a per-fill hit rate is really a trade-weighted
// vote in which a handful of windows can outvote everything else. If the model
// is right about most WINDOWS but wrong about the few that trade heavily, the
// per-fill number will look catastrophic while the per-window number looks fine
// — and the fix for that is position sizing, not a new model.

import { Indexer } from "../core/indexer.js";
import { buildChances } from "../backtest/replay.js";

const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};

async function main(): Promise<void> {
  const idx = new Indexer();
  const { chances } = await buildChances(idx, { days: Number(arg("--days", "30")), onProgress: () => {} });

  const byMarket = new Map<string, { n: number; wins: number; stake: number; pnl: number; asset: string; iv: number }>();
  for (const c of chances) {
    const e = byMarket.get(c.marketId) ?? { n: 0, wins: 0, stake: 0, pnl: 0, asset: c.asset, iv: c.intervalSec };
    e.n++;
    e.wins += c.won;
    e.stake += c.price;
    e.pnl += c.won - c.price;
    byMarket.set(c.marketId, e);
  }

  const rows = [...byMarket.values()];
  const counts = rows.map((r) => r.n).sort((a, b) => b - a);
  const total = chances.length;

  console.log("RIVO · is the sample trade-weighted into a corner?");
  console.log("=".repeat(84));
  console.log(`  chances                    ${total}`);
  console.log(`  windows                    ${rows.length}`);
  console.log(`  chances per window         median ${counts[Math.floor(counts.length / 2)]}, max ${counts[0]}`);
  const top10 = counts.slice(0, 10).reduce((a, b) => a + b, 0);
  console.log(`  top 10 windows account for ${((top10 / total) * 100).toFixed(1)}% of all chances`);

  // Per-fill: every chance votes. Per-window: each window votes once.
  const perFill = chances.reduce((a, c) => a + c.won, 0) / total;
  const perWindow = rows.reduce((a, r) => a + r.wins / r.n, 0) / rows.length;
  console.log("");
  console.log("HIT RATE");
  console.log("-".repeat(84));
  console.log(`  per fill   (trade-weighted)   ${(perFill * 100).toFixed(1)}%`);
  console.log(`  per window (one vote each)    ${(perWindow * 100).toFixed(1)}%`);
  console.log("");
  if (perWindow > 0.5 && perFill < 0.5) {
    console.log("  The model is right about most WINDOWS and wrong about the ones that trade");
    console.log("  most. That is a sizing problem, not a forecasting problem: heavy trading is");
    console.log("  itself a signal that a window is contested, and size should shrink with it.");
  } else if (perWindow < 0.5) {
    console.log("  The model is wrong window-by-window too. This is not a weighting artefact.");
  }

  console.log("");
  console.log("WORST WINDOWS BY P&L — where the losses actually came from");
  console.log("-".repeat(84));
  console.log("  window                 asset  cadence  chances   won%   P&L/stake");
  for (const r of [...rows].sort((a, b) => a.pnl / Math.max(a.stake, 1e-9) - b.pnl / Math.max(b.stake, 1e-9)).slice(0, 10)) {
    console.log(
      `  ${String([...byMarket].find(([, v]) => v === r)?.[0]).slice(0, 20)}  ${r.asset.padEnd(5)}  ${String(Math.round(r.iv / 60) + "m").padStart(6)}  ` +
        `${String(r.n).padStart(7)}  ${((r.wins / r.n) * 100).toFixed(0).padStart(4)}   ${((r.pnl / Math.max(r.stake, 1e-9)) * 100).toFixed(1).padStart(8)}%`,
    );
  }

  // Concentration of damage: how much of the total loss comes from few windows?
  const losses = rows.map((r) => r.pnl).filter((p) => p < 0).sort((a, b) => a - b);
  const totalLoss = losses.reduce((a, b) => a + b, 0);
  const worst5 = losses.slice(0, 5).reduce((a, b) => a + b, 0);
  console.log("");
  console.log(`  worst 5 windows are ${((worst5 / totalLoss) * 100).toFixed(0)}% of all losses (${losses.length} losing windows)`);
}

main().catch((e) => {
  console.error(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
