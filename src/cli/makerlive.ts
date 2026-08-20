// `npm run maker:live -- --capital 20 --cycles 60 --live`
//
// Quotes both sides of every live window around Rivo's own fair value, then
// reports what the chain says happened. This is the one open question the
// replays could not settle: crediting yourself with a fill requires knowing you
// would have been at the front of a queue that no longer exists, so the only
// honest way to find out is to rest real quotes and watch.
//
// It measures what Glosten–Milgrom says decides a market maker's fate — spread
// captured against adverse selection suffered — and reports them SEPARATELY.
// A single P&L number would hide which side of that inequality this is on,
// which is the only thing worth learning.
//
// Dry by default. `--live` sends real orders.

import { writeFileSync } from "node:fs";
import { Indexer } from "../core/indexer.js";
import { snapshot } from "../engine/scan.js";
import { profile } from "../portfolio/profiles.js";
import { deltaPer1Pct } from "../portfolio/risk.js";
import { hasSigner, makeExecutor } from "../runtime/executor.js";
import { legKey, planQuotes, scoreFills, type MakerFill, type Quote } from "../runtime/maker.js";
import type { Asset } from "../core/config.js";

const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const num = (f: string, d: number) => Number(arg(f, String(d)));

interface Posted extends Quote {
  cycle: number;
  at: number;
  rested: boolean;
  rejected?: string;
}

async function main(): Promise<void> {
  const capital = num("--capital", 20);
  const halfSpread = num("--half-spread", 0.02);
  const quoteSize = num("--quote-size", 5);
  const maxDisagreement = num("--max-disagreement", 0.1);
  const cycles = num("--cycles", 30);
  const intervalMs = num("--interval-ms", 30_000);
  const prof = profile(arg("--profile", "balanced"));
  const out = arg("--out");

  const wantsLive = process.argv.includes("--live");
  const mint = process.argv.includes("--mint");
  const dryRun = !wantsLive || !hasSigner();
  const idx = new Indexer();
  const executor = makeExecutor(dryRun);
  const address = await executor.address();

  console.log("RIVO · maker mode");
  console.log("=".repeat(80));
  console.log(`mode        ${executor.mode.toUpperCase()}${dryRun && wantsLive ? "  (asked for live, no funded key — staying dry)" : ""}`);
  console.log(`capital     ${capital}   half-spread ±${halfSpread}   quote size ${quoteSize}`);
  console.log(`ceiling     refuse to quote when model and book differ by more than ${maxDisagreement}`);
  console.log(`inventory   ${mint ? "mint complete sets so asks can rest" : "no minting — bids only, which is just a slow buyer"}`);
  console.log(`wallet      ${address ?? "(none — dry)"}`);
  console.log("");
  console.log("Quotes are centred on Rivo's fair value, not the book mid. The kit's own");
  console.log("ec-maker centres on the mid and says so — swap in your own signal to actually");
  console.log("make money. This is that signal, and its calibration is in docs/EVIDENCE.md.");
  console.log("");

  const posted: Posted[] = [];
  let failures = 0;
  let minted = 0;
  const startedAt = Math.floor(Date.now() / 1000);
  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log("\nstopping — cancelling resting quotes…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  for (let cycle = 1; cycle <= cycles && !stopping; cycle++) {
    const now = Math.floor(Date.now() / 1000);
    try {
      executor.newCycle();
      const snap = await snapshot(idx, { now });

      // Inventory comes from the chain, never from memory. A maker that
      // misremembers what it holds will quote an ask it cannot back.
      const inventory = address ? await idx.outcomeBalances(address) : new Map<string, number>();
      const invByLeg = new Map<string, number>();
      for (const [k, v] of inventory) {
        const i = k.lastIndexOf(":");
        invByLeg.set(`${k.slice(0, i)}:${k.slice(i + 1)}`, v);
      }

      // Existing inventory is exposure, so the delta budget must see it — but
      // only the NET of it. Equal Up and Down in one market is a complete set:
      // directionally flat by construction, which is the entire reason minting
      // one is safe. Counting the Up leg alone reads a hedged position as a full
      // long, and measured, that falsely exhausted the budget and skipped every
      // market the maker was there to quote.
      const assetDelta = new Map<string, number>();
      for (const o of snap.opportunities) {
        if (o.leg !== "UP") continue;
        const k = o.marketId.toLowerCase();
        const up = invByLeg.get(legKey(k, "UP")) ?? 0;
        const down = invByLeg.get(legKey(k, "DOWN")) ?? 0;
        const net = up - down;
        if (net === 0) continue;
        const spot = snap.assets.get(o.asset as Asset)?.spot ?? 0;
        assetDelta.set(o.asset, (assetDelta.get(o.asset) ?? 0) + net * deltaPer1Pct(o.deltaPerShare, spot));
      }

      const plan = planQuotes({
        opportunities: snap.opportunities,
        assetDelta,
        inventory: new Map([...invByLeg].map(([k, v]) => [k.toLowerCase(), v])),
        profile: prof,
        now,
        params: {
          halfSpread,
          quoteSize,
          maxDisagreement,
          minSecondsLeft: 300,
          freeCash: capital,
          assetDeltaBudget: capital * prof.maxAssetDeltaPer1Pct,
        },
      });

      // Mint inventory where the ask cannot rest without it. Selling needs the
      // token — there is no naked short here — so a maker with no inventory is
      // only ever a slow buyer, which is the taker path we already know loses.
      if (mint) {
        for (const need of plan.needsInventory) {
          const r = await executor.mintSet(need.marketId, need.shares);
          if (r.rejected) {
            console.log(`      mint ${need.marketId.slice(-8)} failed: ${r.rejected}`);
            failures++;
          } else {
            minted++;
            console.log(`      minted a complete set for ${need.marketId.slice(-8)}`);
          }
        }
      }

      // Pull last cycle's quotes before posting new ones. A stale quote holds
      // escrow and can be lifted at a price the model no longer believes.
      const pulled = await executor.cancelResting();

      // Post each quote on its own side.
      for (const q of plan.quotes) {
        const req = { marketId: q.marketId, leg: q.leg, size: q.size, limitPrice: q.price, type: "post-only" as const };
        const r = q.side === "buy" ? await executor.buy(req, undefined) : await executor.sell(req, undefined);
        posted.push({ ...q, cycle, at: now, rested: Boolean(r.rested), ...(r.rejected ? { rejected: r.rejected } : {}) });
        if (r.rejected) failures++;
      }

      const rested = posted.filter((x) => x.cycle === cycle && x.rested).length;
      console.log(
        `#${String(cycle).padStart(3)} ${new Date(now * 1000).toISOString().slice(11, 19)} · ` +
          `${snap.windows.length}w · quoted ${plan.quotes.length} (${rested} rested) · ` +
          `pulled ${pulled} · need inventory ${plan.needsInventory.length} · skipped ${plan.skipped.length}`,
      );
      if (cycle === 1 && plan.skipped.length > 0) {
        for (const s of plan.skipped.slice(0, 4)) console.log(`      skip ${s.marketId.slice(-8)} ${s.leg}: ${s.reason}`);
      }
    } catch (e) {
      failures++;
      console.log(`  cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (cycle < cycles && !stopping) await sleep(intervalMs, () => stopping);
  }

  await executor.cancelResting().catch(() => 0);

  // ---- what the chain says happened ---------------------------------------
  console.log("");
  console.log("RESULT — read back from the chain, not from what we intended");
  console.log("-".repeat(80));

  const quotedMarkets = [...new Set(posted.map((p) => p.marketId))];
  const fills: MakerFill[] = [];
  if (address && quotedMarkets.length > 0) {
    const byMarket = await idx.fills(quotedMarkets);
    const me = address.toLowerCase();
    for (const [marketId, rows] of byMarket) {
      for (const f of rows) {
        if (f.at < startedAt) continue;
        if (f.maker.toLowerCase() !== me) continue; // only fills against OUR resting quotes
        const q = posted.find((p) => p.marketId.toLowerCase() === marketId && p.at <= f.at);
        fills.push({
          at: f.at,
          marketId,
          leg: "UP",
          side: f.makerSide === "SELL_YES" ? "sell" : "buy",
          price: f.price,
          size: f.size,
          fairAtQuote: q?.fair ?? f.price,
        });
      }
    }
  }

  const snapEnd = await snapshot(idx, {}).catch(() => null);
  const fairNow = new Map<string, number>();
  for (const o of snapEnd?.opportunities ?? []) {
    if (o.leg === "UP" && Number.isFinite(o.fair)) fairNow.set(legKey(o.marketId.toLowerCase(), "UP"), o.fair);
  }
  const m = scoreFills(fills, fairNow);
  m.ordersPosted = posted.length;
  m.ordersRejected = posted.filter((p) => p.rejected).length;
  m.executionFailures = failures;

  const restedCount = posted.filter((p) => p.rested).length;
  console.log(`  orders posted              ${m.ordersPosted}`);
  console.log(`  …that actually rested      ${restedCount}`);
  console.log(`  …rejected                  ${m.ordersRejected}`);
  console.log(`  execution failures         ${m.executionFailures}`);
  console.log(`  complete sets minted       ${minted}`);
  console.log(`  fills against our quotes   ${m.fills}   (${m.filledShares.toFixed(2)} shares)`);
  console.log(`  paired shares              ${m.pairedShares.toFixed(2)}`);
  console.log(`  one-sided inventory        ${m.oneSidedShares.toFixed(2)}`);
  console.log(`  max inventory              ${m.maxInventoryShares.toFixed(2)} shares`);
  console.log("");
  console.log("  THE INEQUALITY THAT DECIDES IT — a maker profits only when the first exceeds");
  console.log("  the second. Reported apart so it is clear which side of it this run is on.");
  console.log(`    captured spread          ${m.capturedSpreadPerShare >= 0 ? "+" : ""}${m.capturedSpreadPerShare.toFixed(4)} per share`);
  console.log(`    adverse selection        ${m.adverseSelectionPerShare >= 0 ? "+" : ""}${m.adverseSelectionPerShare.toFixed(4)} per share`);
  const net = m.capturedSpreadPerShare + m.adverseSelectionPerShare;
  console.log(`    net                      ${net >= 0 ? "+" : ""}${net.toFixed(4)} per share`);

  console.log("");
  console.log("VERDICT");
  console.log("-".repeat(80));
  if (m.fills === 0) {
    console.log("  INCONCLUSIVE. No quote was lifted, so there is nothing to measure.");
    console.log(`  ${restedCount} of ${m.ordersPosted} orders rested; the venue simply did not come to them.`);
    console.log("  Run longer, quote tighter, or accept that this book has too little flow.");
  } else if (net > 0) {
    console.log(`  Captured spread exceeds adverse selection by ${net.toFixed(4)} per share over ${m.fills} fills.`);
    console.log("  Promising — but treat it as provisional until the sample is large and the");
    console.log("  one-sided inventory has actually settled.");
  } else {
    console.log(`  Adverse selection exceeds captured spread by ${Math.abs(net).toFixed(4)} per share.`);
    console.log("  The fills arrive on the side that was about to be wrong, which is the classic");
    console.log("  way a maker loses. Widening the spread usually does not fix this — it lowers");
    console.log("  the fill rate and the fills you still get are the most toxic ones.");
  }
  if (m.oneSidedShares > 0) {
    console.log("");
    console.log(`  ${m.oneSidedShares.toFixed(2)} shares are one-sided and carry directional risk to settlement.`);
    console.log("  Settlement P&L on those is not in the figures above and is not yet known.");
  }

  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(),
      params: { capital, halfSpread, quoteSize, maxDisagreement, cycles, mode: executor.mode },
      metrics: m, posted, fills }, null, 2));
    console.log(`\nwrote ${out}`);
  }
}

async function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  for (let w = 0; w < ms; w += 250) {
    if (cancelled()) return;
    await new Promise((r) => setTimeout(r, Math.min(250, ms - w)));
  }
}

main().catch((e) => {
  console.error(`maker failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
