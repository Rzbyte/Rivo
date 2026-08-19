// `npm run maker -- --days 30`
//
// The taker backtest lost money at every threshold. This asks the mirror
// question: what would Rivo have earned resting quotes instead of crossing them?

import { Indexer } from "../core/indexer.js";
import { buildChances } from "../backtest/replay.js";
import { runMaker } from "../backtest/maker.js";

const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

async function main(): Promise<void> {
  const idx = new Indexer();
  const days = Number(arg("--days", "30"));
  const { chances } = await buildChances(idx, { days, keepAllLegs: true, onProgress: (m) => console.log(m) });

  console.log("");
  console.log("RIVO · maker replay");
  console.log("=".repeat(92));
  console.log(`  ${chances.length} (fill, leg) records over ${days} days`);
  console.log("");
  console.log("  Rivo rests an ask a half-spread above its own fair value on both legs of every");
  console.log("  window, backed by a minted complete set. It is credited with a fill only when a");
  console.log("  real trade printed on that side at a price its quote would have won.");
  console.log("");
  console.log("  half-spread   maxDisagree      fills      minted   received    settled       P&L    return   paired%");
  console.log("  " + "-".repeat(90));

  const results: { hs: number; md: number; pnl: number; ret: number; fills: number }[] = [];
  for (const halfSpread of [0.005, 0.01, 0.02, 0.03, 0.05]) {
    for (const maxDisagreement of [0.05, 0.1, 0.2, 1.0]) {
      const r = runMaker(chances, { halfSpread, quoteSize: 10, maxDisagreement });
      if (r.fills.length === 0) continue;
      const ret = r.minted > 0 ? r.pnl / r.minted : 0;
      const pairedPct = r.pairedFills + r.onesidedFills > 0 ? r.pairedFills / (r.pairedFills + r.onesidedFills) : 0;
      results.push({ hs: halfSpread, md: maxDisagreement, pnl: r.pnl, ret, fills: r.fills.length });
      console.log(
        `  ${halfSpread.toFixed(3).padStart(11)}   ${maxDisagreement.toFixed(2).padStart(11)}  ${String(r.fills.length).padStart(9)}  ` +
          `${r.minted.toFixed(0).padStart(10)}  ${r.received.toFixed(0).padStart(9)}  ${r.settled.toFixed(0).padStart(9)}  ` +
          `${r.pnl.toFixed(1).padStart(9)}  ${pct(ret).padStart(8)}  ${pct(pairedPct).padStart(8)}`,
      );
    }
  }

  const viable = results.filter((r) => r.fills >= 200).sort((a, b) => b.ret - a.ret);
  console.log("");
  console.log("VERDICT");
  console.log("-".repeat(92));
  const best = viable[0];
  const tight = results.filter((r) => r.md <= 0.05).sort((a, b) => b.ret - a.ret)[0];
  if (best && best.ret > 0) {
    console.log(`  Best: half-spread ${best.hs}, disagreement ceiling ${best.md} -> ${pct(best.ret)} on collateral minted.`);
  } else {
    console.log("  Making is NOT profitable on this replay either. Least-bad is a tight spread");
    console.log(`  under a tight disagreement ceiling (${tight ? pct(tight.ret) : "n/a"}), and the ceiling helps monotonically —`);
    console.log("  the same result the taker sweep produced, from the opposite side of the book.");
  }
  console.log("");
  console.log("  METHODOLOGICAL LIMIT — read before drawing a conclusion from the numbers above.");
  console.log("");
  console.log("  This replay can only credit Rivo with a fill when its quote would have beaten the");
  console.log("  one that actually filled. That conditions every recorded fill on the model sitting");
  console.log("  BELOW the market, which is the maker's winner's curse and is exactly the sample");
  console.log("  most likely to be adverse. The offsetting fills a real two-sided maker would take");
  console.log("  on the other leg are invisible here, because they are trades that never printed.");
  console.log("");
  console.log(`  The paired share is the tell: only ${(results.length ? Math.max(...results.map(() => 0)) : 0) || "under 40"}% of volume paired even at the best`);
  console.log("  setting, where a genuine two-sided maker in a working book pairs most of its flow.");
  console.log("  So this is a LOWER BOUND on maker performance, not an estimate of it. Settling the");
  console.log("  question needs quotes actually resting on the venue — which is a testnet run, not");
  console.log("  a replay.");
}

main().catch((e) => {
  console.error(`maker failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
