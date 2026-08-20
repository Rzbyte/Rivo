// The live pricing explorer.
//
// This was the whole page before Rivo had a product surface. It stays, one route
// down, because it is genuinely useful to anyone trading this venue by hand and
// because it is the cleanest demonstration that the model runs client-side. But
// it supports Rivo rather than defining it: a pricing dashboard is not a
// portfolio manager, and leading with one would misrepresent what was built.
//
// It reads the SAME engine snapshot the portfolio allocates from — not a second
// loader written for display. An explorer with its own data path is an explorer
// that will eventually disagree with the product it sits beside, and the
// disagreement will be invisible because both look plausible.

import type { Snapshot } from "../../engine/scan.js";
import { bestBid } from "../../engine/book.js";
import { collateralName, tenorLabel, type Network } from "../../core/venue.js";
import { cls, esc, f2, f3, horizon, pct, signed } from "./dom.js";
import { termChart } from "./charts.js";
import { sigmaPerMinute } from "../../model/vol.js";
import { DEFAULT_VOL_LOOKBACK_MIN } from "../../calibration/dataset.js";

interface Row {
  label: string;
  fair: number;
  ask: number | null;
  bid: number | null;
  gap: number | null;
  spot: number;
  reference: number;
  sigmaRemaining: number;
  minutesLeft: number;
}

/** One row per market, from its UP leg — the DOWN leg is its complement. */
export function rowsOf(snap: Snapshot): Row[] {
  const byMarket = new Map<string, Row>();
  for (const o of snap.opportunities) {
    if (o.leg !== "UP") continue;
    const w = snap.windows.find((x) => x.marketId === o.marketId);
    const book = snap.books.get(o.marketId);
    byMarket.set(o.marketId, {
      label: `${o.asset} ${tenorLabel(o.intervalSec)}`,
      fair: o.fair,
      ask: o.ask,
      bid: book ? bestBid(book.UP) : null,
      gap: o.edge === null ? null : -o.edge, // book − model, the explorer's convention
      spot: snap.assets.get(o.asset)?.spot ?? 0,
      reference: w?.reference ?? 0,
      sigmaRemaining: o.sigmaRemaining,
      minutesLeft: o.tauMinutes,
    });
  }
  return [...byMarket.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function explorer(snap: Snapshot | null, net: Network = "testnet"): string {
  if (!snap) return `<div class="wrap"><p class="empty">reading the venue…</p></div>`;
  const rows = rowsOf(snap);
  // Same lookback the engine priced with, so the σ shown is the σ used.
  const sigma = new Map<string, number>();
  for (const [asset, st] of snap.assets) {
    const v = sigmaPerMinute(st.bars, st.bars.length - 1, DEFAULT_VOL_LOOKBACK_MIN);
    if (v !== null) sigma.set(asset, v);
  }

  return `
  <div class="wrap">
    <div style="max-width:760px;padding:26px 0 6px">
      <h1 style="font-size:clamp(24px,3.6vw,34px)">What every live contract is worth</h1>
      <p class="lede" style="margin-top:12px;font-size:16px">
        Rivo's conditional fair value for all ${rows.length} live DreamDEX Event Contract windows,
        against what the book is charging. Computed in your browser from the same modules the trading
        runtime uses — no server, no wallet, nothing installed.
      </p>
    </div>

    <div class="grid g4" style="margin-top:20px">
      ${[...snap.assets.entries()]
        .map(
          ([a, st]) =>
            `<div class="panel stat"><div class="k">${esc(a)} spot</div>
             <div class="v">${st.spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
             <div class="s">${st.spotAgeSec}s old</div></div>`,
        )
        .join("")}
      ${[...sigma.entries()]
        .map(
          ([a, v]) =>
            `<div class="panel stat"><div class="k">${esc(a)} σ per minute</div><div class="v">${pct(v, 4)}</div>
             <div class="s">measured from venue candles</div></div>`,
        )
        .join("")}
    </div>

    <div class="panel pad" style="margin-top:14px">${termChart(rows.map((r) => ({ label: r.label, fair: r.fair, ask: r.ask, bid: r.bid })))}</div>

    <div class="sec-head"><h2>Every live window</h2>
      <span class="hint">gap = book − model. Negative means the UP leg is cheap relative to the model.</span></div>
    <div class="panel"><div class="scroll"><table>
      <thead><tr>
        <th>Window</th><th>Model</th><th>Bid</th><th>Ask</th><th>Gap</th>
        <th>Spot vs open</th><th>σ√τ</th><th>Settles in</th>
      </tr></thead>
      <tbody>${rows.map(row).join("")}</tbody>
    </table></div></div>

    ${
      snap.unpriced.length > 0
        ? `<p class="note" style="margin-top:14px">
             ${snap.unpriced.length} window${snap.unpriced.length > 1 ? "s" : ""} could not be priced:
             ${snap.unpriced.map((u) => `${esc(u.asset)} ${esc(tenorLabel(u.intervalSec))} — ${esc(u.reason)}`).join("; ")}.
             Rivo prices nothing it cannot anchor, rather than guessing.
           </p>`
        : ""
    }

    <div class="panel pad" style="margin-top:24px">
      <h3>How the number is built</h3>
      <p class="mut" style="font-size:13.5px;margin-top:8px">
        A window pays out if the underlying closes above its opening reference, so its value is the
        probability of exactly that: <code>P = Φ(ln(S/R) / σ√τ)</code> — where <code>S</code> is spot
        now, <code>R</code> the settlement reference resolved by the oracle, <code>σ</code> volatility
        measured from the venue's own candles, and <code>τ</code> the time left. It is conditional on
        where price is <em>now</em>, which is why a mid-window contract is rarely near 50% and why
        comparing one to the 50.23% unconditional base rate is a category error.
      </p>
      <p class="mut" style="font-size:13.5px;margin-bottom:0">
        Pricing binaries this way is standard and DreamDEX supplies the primitives — it is not Rivo's
        invention. What we can defend is that this implementation was measured out of sample before it
        was trusted, and that the gaps above are an input to a portfolio allocator rather than a trade
        signal. <a href="#/evidence">The evidence</a>.
      </p>
    </div>

    <p class="note" style="margin-top:20px">
      Denominated in ${esc(collateralName(net))}. A gap is not a profit: crossing the spread to take
      one measured negative at every threshold we tested, which is why Rivo's own allocator refuses
      most of them. <a href="#/app">See what it does instead</a>.
    </p>
  </div>`;
}

function row(r: Row): string {
  const money = r.reference > 0 ? 100 * Math.log(r.spot / r.reference) : 0;
  return `<tr>
    <td><b>${esc(r.label)}</b></td>
    <td class="n">${f3(r.fair)}</td>
    <td class="n mut">${r.bid === null ? "—" : f3(r.bid)}</td>
    <td class="n">${r.ask === null ? "—" : f3(r.ask)}</td>
    <td class="n ${r.gap === null ? "mut" : cls(-r.gap)}">${r.gap === null ? "—" : signed(r.gap, 3)}</td>
    <td class="n ${cls(money)}">${signed(money, 3)}%</td>
    <td class="n mut">${f2(100 * r.sigmaRemaining)}%</td>
    <td class="n mut">${esc(horizon(r.minutesLeft))}</td>
  </tr>`;
}
