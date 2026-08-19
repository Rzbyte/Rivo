// `npm run allocate -- --capital 50 --profile balanced`
//
// One full pass of the portfolio brain against the live venue: scan, price, size,
// and explain. Read-only — it decides and reports, and signs nothing.

import { Indexer } from "../core/indexer.js";
import { snapshot } from "../engine/scan.js";
import { allocate } from "../portfolio/allocator.js";
import { profile } from "../portfolio/profiles.js";
import { measureCorrelation, type Position } from "../portfolio/risk.js";
import type { Asset } from "../core/config.js";

const money = (x: number) => x.toFixed(2);
/** Absent is not zero: a leg with no offer has no ask and no edge, not 0.000. */
const opt = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "—".padStart(d + 2) : x.toFixed(d));
const optSigned = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "  —  " : `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const capital = Number(arg("--capital", "50"));
  const prof = profile(arg("--profile"));
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("--capital must be a positive number");

  const idx = new Indexer();
  const snap = await snapshot(idx, { minEdge: prof.minEdge });

  const btcBars = snap.assets.get("BTC")?.bars ?? [];
  const ethBars = snap.assets.get("ETH")?.bars ?? [];
  const rho = measureCorrelation(btcBars, ethBars);

  const spot = new Map<Asset, number>();
  for (const [a, s] of snap.assets) spot.set(a, s.spot);

  const held: Position[] = []; // no open book yet — the runtime will supply this
  const result = allocate({
    totalCapital: capital,
    freeCash: capital,
    opportunities: snap.opportunities,
    books: snap.books,
    spot,
    held,
    rho,
    profile: prof,
  });

  console.log("RIVO · allocation");
  console.log("=".repeat(92));
  console.log(`at         ${new Date(snap.at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`);
  console.log(`capital    ${money(capital)}   profile ${prof.name}   kelly x${prof.kellyFraction}   rho(BTC,ETH) ${rho.toFixed(3)}`);
  console.log(`universe   ${snap.windows.length} windows / ${snap.opportunities.length} legs`);
  console.log("");

  const buys = result.decisions.filter((d) => d.action === "BUY");
  console.log("ALLOCATION");
  console.log("-".repeat(92));
  if (buys.length === 0) {
    console.log("  100% cash — nothing cleared the thresholds.");
  } else {
    console.log("  market            leg    shares      @      cost    edge   kelly-asked   bound by");
    for (const d of buys) {
      const o = d.opportunity;
      console.log(
        `  ${`${o.asset}-${Math.round(o.intervalSec / 60)}m`.padEnd(16)}  ${o.leg.padEnd(5)} ` +
          `${d.shares.toFixed(0).padStart(6)} ${d.avgPrice.toFixed(3).padStart(7)} ${money(d.cost).padStart(9)} ` +
          `${optSigned(o.edge).padStart(7)} ${money(d.kellyTarget).padStart(10)}     ${d.binding}`,
      );
    }
  }
  console.log("");
  console.log(`  deployed   ${money(result.deployed).padStart(8)}   (${((result.deployed / capital) * 100).toFixed(1)}%)`);
  console.log(`  cash       ${money(result.cash).padStart(8)}   (${((result.cash / capital) * 100).toFixed(1)}%)`);

  console.log("");
  console.log("PORTFOLIO RISK");
  console.log("-".repeat(92));
  const r = result.riskAfter;
  for (const [asset, d] of r.assetDelta) {
    const cap = capital * prof.maxAssetDeltaPer1Pct;
    console.log(`  ${asset} delta      ${d >= 0 ? "+" : ""}${d.toFixed(3)} per 1% move   budget ±${cap.toFixed(2)}   ${(Math.abs(d) / cap * 100).toFixed(0)}% used`);
  }
  const combCap = capital * prof.maxCombinedDeltaPer1Pct;
  console.log(`  combined     ${r.combinedDelta >= 0 ? "+" : ""}${r.combinedDelta.toFixed(3)} per 1% move   budget ±${combCap.toFixed(2)}   ${(Math.abs(r.combinedDelta) / combCap * 100).toFixed(0)}% used`);
  console.log(`  max loss     ${money(r.maxLoss)}   (exact: a long binary cannot lose more than its premium)`);
  for (const [bucket, cost] of r.expiryBuckets) {
    console.log(`  settling ${bucket}   ${money(cost)}   budget ${money(capital * prof.maxPerExpiryBucket)}`);
  }

  console.log("");
  console.log("WHY — every leg considered, and what stopped it");
  console.log("-".repeat(92));
  const ordered = [...result.decisions].sort(
    (a, b) => (b.action === "BUY" ? 1 : 0) - (a.action === "BUY" ? 1 : 0) || (b.opportunity.edge ?? -9) - (a.opportunity.edge ?? -9),
  );
  for (const d of ordered) {
    const o = d.opportunity;
    const tag = d.action === "BUY" ? `BUY ${d.shares.toFixed(0)} @ ${d.avgPrice.toFixed(3)}` : "SKIP";
    console.log(
      `  ${`${o.asset}-${Math.round(o.intervalSec / 60)}m ${o.leg}`.padEnd(20)} fair ${opt(o.fair)}  ` +
        `ask ${opt(o.ask)}  edge ${optSigned(o.edge)}  ${tag.padEnd(20)} ${d.binding}`,
    );
  }
}

main().catch((e) => {
  console.error(`allocate failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
