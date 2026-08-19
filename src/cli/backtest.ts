// `npm run backtest -- --days 30 --capital 50 --profile balanced`
//
// Replays every settled window that actually traded, and puts Rivo's portfolio
// rules up against the same forecasts sized without them.

import { Indexer } from "../core/indexer.js";
import { measureCorrelation } from "../portfolio/risk.js";
import { profile } from "../portfolio/profiles.js";
import { buildChances, run, type RunResult } from "../backtest/replay.js";
import { allIn, anyEdge, equalWeight, kellyFull, kellyUnconstrained, rivo } from "../backtest/sizers.js";
import { ASSETS } from "../core/config.js";
import { DEFAULT_VOL_LOOKBACK_MIN } from "../calibration/dataset.js";
import { writeFileSync } from "node:fs";

const arg = (flag: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

async function main(): Promise<void> {
  const days = Number(arg("--days", "30"));
  const capital = Number(arg("--capital", "50"));
  const prof = profile(arg("--profile"));
  const out = arg("--out");

  const idx = new Indexer();
  console.log("RIVO · backtest against executed fills");
  console.log("=".repeat(94));
  console.log(`venue      ${idx.venueId.slice(0, 18)}…`);
  console.log(`window     last ${days} days   capital ${capital}   profile ${prof.name} (kelly x${prof.kellyFraction})`);
  console.log("");

  const { chances, markets, withFills } = await buildChances(idx, { days, onProgress: (m) => console.log(m) });
  if (chances.length === 0) {
    console.log("\nno opportunities in this period");
    process.exitCode = 1;
    return;
  }

  // Correlation over the same period the replay covers.
  const now = Math.floor(Date.now() / 1000);
  const [btcBars, ethBars] = await Promise.all(
    ASSETS.map((a) => idx.candles(a, now - days * 86_400, now).catch(() => [])),
  );
  const rho = measureCorrelation(btcBars ?? [], ethBars ?? []);

  console.log("");
  console.log("OPPORTUNITY STREAM");
  console.log("-".repeat(94));
  console.log(`  settled windows            ${markets}`);
  console.log(`  windows that traded        ${withFills}`);
  console.log(`  positive-edge chances      ${chances.length}`);
  console.log(`  period                     ${new Date(chances[0]!.at * 1000).toISOString().slice(0, 16)} -> ${new Date(chances[chances.length - 1]!.at * 1000).toISOString().slice(0, 16)} UTC`);
  console.log(`  rho(BTC,ETH)               ${rho.toFixed(3)}`);
  console.log(`  vol lookback               ${DEFAULT_VOL_LOOKBACK_MIN} min`);
  const byAsset = new Map<string, number>();
  for (const c of chances) byAsset.set(c.asset, (byAsset.get(c.asset) ?? 0) + 1);
  console.log(`  by asset                   ${[...byAsset].map(([a, n]) => `${a} ${n}`).join("  ")}`);

  const strategies = [rivo, kellyUnconstrained, kellyFull, equalWeight(0.05), anyEdge(0.05), allIn];
  const results: RunResult[] = strategies.map((s) => run(s.name, chances, s, prof, rho, capital));

  console.log("");
  console.log("RESULTS — identical forecasts, identical order, different sizing");
  console.log("-".repeat(94));
  console.log("  strategy                              final     return   maxDD    trades   hit%   ret/stake");
  for (const r of results) {
    const ret = (r.finalEquity - r.startEquity) / r.startEquity;
    console.log(
      `  ${r.name.padEnd(36)} ${r.finalEquity.toFixed(2).padStart(8)}  ${pct(ret).padStart(9)}  ${pct(r.maxDrawdown).padStart(7)}  ` +
        `${String(r.taken).padStart(7)}  ${(r.hitRate * 100).toFixed(1).padStart(5)}  ${pct(r.returnOnStake).padStart(9)}`,
    );
  }

  const a = results[0]!;
  const b = results[1]!;
  console.log("");
  console.log("THE COMPARISON THAT MATTERS");
  console.log("-".repeat(94));
  console.log(`  Rivo                      ${a.finalEquity.toFixed(2)}   maxDD ${pct(a.maxDrawdown)}   ${a.taken} trades`);
  console.log(`  same Kelly, no portfolio  ${b.finalEquity.toFixed(2)}   maxDD ${pct(b.maxDrawdown)}   ${b.taken} trades`);
  console.log("");
  const retA = (a.finalEquity - a.startEquity) / a.startEquity;
  const retB = (b.finalEquity - b.startEquity) / b.startEquity;
  if (a.maxDrawdown < b.maxDrawdown && retA > 0) {
    console.log(`  The constraints cut peak drawdown from ${pct(b.maxDrawdown)} to ${pct(a.maxDrawdown)}`);
    console.log(`  (${((1 - a.maxDrawdown / Math.max(b.maxDrawdown, 1e-9)) * 100).toFixed(0)}% less) while keeping ${pct(retA)} of return.`);
    console.log("  That is what the portfolio layer is for: the same edge, survivable.");
  } else if (retA > retB) {
    console.log("  The constraints improved return outright — declining correlated repeats of");
    console.log("  one bet left capital for genuinely independent ones.");
  } else {
    console.log("  The constraints did NOT pay for themselves on this sample.");
    console.log("  Loosen the budgets or cut the layer — do not ship it on faith.");
  }

  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          venueId: idx.venueId,
          params: { days, capital, profile: prof, rho },
          stream: { markets, withFills, chances: chances.length },
          results: results.map((r) => ({
            name: r.name,
            finalEquity: r.finalEquity,
            return: (r.finalEquity - r.startEquity) / r.startEquity,
            maxDrawdown: r.maxDrawdown,
            trades: r.taken,
            declined: r.declined,
            hitRate: r.hitRate,
            totalStaked: r.totalStaked,
            returnOnStake: r.returnOnStake,
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
  console.error(`backtest failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
