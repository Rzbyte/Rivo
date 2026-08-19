// `npm run scan` — one pass of the Opportunity Engine over the live venue.
//
// Prints every leg it considered, priced, with the reason any of them is not
// actionable. Read-only: no key, no orders, nothing signed.

import { Indexer } from "../core/indexer.js";
import { snapshot } from "../engine/scan.js";
import { bestBid } from "../engine/opportunity.js";

const f = (x: number | null, d = 3) => (x === null || !Number.isFinite(x) ? "  —  " : x.toFixed(d));
const signed = (x: number | null) => (x === null || !Number.isFinite(x) ? "  —  " : `${x >= 0 ? "+" : ""}${x.toFixed(3)}`);

async function main(): Promise<void> {
  const idx = new Indexer();
  const snap = await snapshot(idx);

  console.log("RIVO · live scan");
  console.log("=".repeat(96));
  console.log(`at         ${new Date(snap.at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`);
  console.log(`venue      ${idx.venueId.slice(0, 18)}…  collateral decimals ${idx.decimals}`);
  for (const [asset, s] of snap.assets) {
    console.log(`${asset.padEnd(10)} spot ${s.spot.toFixed(2)}  mark ${s.mark.toFixed(2)}  age ${s.spotAgeSec}s  ${s.bars.length} bars`);
  }
  console.log(`windows    ${snap.windows.length} priced, ${snap.unpriced.length} unpriced`);
  console.log("");

  if (snap.opportunities.length === 0) {
    console.log("no priceable legs this pass");
  } else {
    console.log(
      "  market            leg    left    ref-money   σrem     fair    bid    ask    edge   depth@fair  Δ/share   status",
    );
    console.log("  " + "-".repeat(112));
    const sorted = [...snap.opportunities].sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9));
    for (const o of sorted) {
      const label = `${o.asset}-${Math.round(o.intervalSec / 60)}m`;
      const book = snap.books.get(o.marketId);
      const bid = book ? bestBid(book[o.leg]) : null;
      console.log(
        `  ${label.padEnd(16)}  ${o.leg.padEnd(5)} ${(o.tauMinutes).toFixed(1).padStart(6)}m ` +
          `${(o.moneyness * 100).toFixed(3).padStart(9)}% ${(o.sigmaRemaining * 100).toFixed(3).padStart(7)}% ` +
          `${f(o.fair).padStart(7)} ${f(bid).padStart(6)} ${f(o.ask).padStart(6)} ${signed(o.edge).padStart(7)} ` +
          `${o.depthAtFair.toFixed(0).padStart(10)} ${o.deltaPerShare.toExponential(1).padStart(9)}   ` +
          (o.blocked ?? "TRADEABLE"),
      );
    }
  }

  if (snap.unpriced.length > 0) {
    console.log("");
    console.log("unpriced windows:");
    for (const u of snap.unpriced) {
      console.log(`  ${u.asset}-${Math.round(u.intervalSec / 60)}m  ${u.marketId.slice(0, 12)}…  ${u.reason}`);
    }
  }

  const tradeable = snap.opportunities.filter((o) => o.blocked === null);
  console.log("");
  console.log(`${tradeable.length} of ${snap.opportunities.length} legs tradeable`);
}

main().catch((e) => {
  console.error(`scan failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
