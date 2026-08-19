// `npm run diagnose -- --days 30`
//
// The backtest loses money with a well-calibrated model. This decides why.

import { Indexer } from "../core/indexer.js";
import { buildChances } from "../backtest/replay.js";
import { byEdge, byHorizon, byStaleness, renderBuckets, selectionValue } from "../backtest/diagnose.js";

const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};

async function main(): Promise<void> {
  const days = Number(arg("--days", "30"));
  const idx = new Indexer();
  console.log("RIVO · why is the model losing money?");
  console.log("=".repeat(84));
  const { chances } = await buildChances(idx, { days, onProgress: (m) => console.log(m) });
  if (chances.length === 0) {
    console.log("no chances");
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log(renderBuckets("BY CLAIMED EDGE — real edge should get MORE reliable as it grows", byEdge(chances)));
  console.log("");
  console.log(renderBuckets("BY HORIZON", byHorizon(chances)));
  console.log("");
  console.log(renderBuckets("BY SPOT STALENESS — if the edge lives here, it is ours, not the market's", byStaleness(chances)));

  const { chosen, ifInverted } = selectionValue(chances);
  console.log("");
  console.log("SELECTION VALUE — did picking a side help at all?");
  console.log("-".repeat(84));
  console.log(`  leg we chose        n=${chosen.n}  model said ${chosen.claimed.toFixed(3)}  actually won ${chosen.realized.toFixed(3)}  P&L/stake ${(chosen.edgePerStake * 100).toFixed(1)}%`);
  console.log(`  the opposite leg    n=${ifInverted.n}  actually won ${ifInverted.realized.toFixed(3)}  P&L/stake ${(ifInverted.edgePerStake * 100).toFixed(1)}%`);
  console.log("");
  if (chosen.realized < 0.5 && ifInverted.realized > 0.5) {
    console.log("  VERDICT: the chosen side loses and its opposite wins. We are systematically");
    console.log("  taking the wrong end of these trades — either the inputs are stale or the");
    console.log("  flow is informed. Read the staleness table above to tell which.");
  } else if (Math.abs(chosen.realized - ifInverted.realized) < 0.02) {
    console.log("  VERDICT: choosing a side adds nothing at fill time. Whatever the average");
    console.log("  calibration says, the model has no information at the moments trades happen.");
  } else {
    console.log("  VERDICT: the chosen side outperforms its opposite — the selection is informative.");
  }
}

main().catch((e) => {
  console.error(`diagnose failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
