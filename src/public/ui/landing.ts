// The front door.
//
// A judge opening this project has to understand within seconds that it is an
// autonomous portfolio manager rather than another pricing dashboard, so the page
// leads with the sentence that says so and with the one number that proves the
// portfolio layer is doing something: live exposure against a live budget.
//
// It deliberately does NOT open with the model, the mathematics, or the venue.
// Those are the reason the product works; they are not the product.

import { esc, f2, pct, signed } from "./dom.js";
import { termChart } from "./charts.js";
import type { PortfolioView } from "../engine.js";

export interface LandingData {
  /** A live preview cycle run against a demo policy, so the page shows a real allocation. */
  preview: PortfolioView | null;
  evidence: { auc: number; brier: number; skill: number; n: number } | null;
  connected: boolean;
}

export function landing(d: LandingData): string {
  const p = d.preview;
  return `
  <div class="wrap">
    <div style="max-width:820px;padding:38px 0 8px">
      <span class="tag ok" style="margin-bottom:16px"><i class="dot"></i>live on Somnia testnet</span>
      <h1 style="margin-top:14px">Rivo turns DreamDEX bots<br>into a portfolio.</h1>
      <p class="lede" style="margin-top:18px">
        DreamDEX already gives you bot infrastructure, fair-value primitives and execution. Rivo sits
        one level above: give it a capital budget and a risk policy once, and it manages the whole
        Event Contract term structure as a single book — allocating across markets, holding
        portfolio-wide BTC and ETH limits, managing positions through settlement, reconciling against
        the chain, and showing you the binding reason behind every decision.
      </p>
      <div style="display:flex;gap:10px;margin-top:24px;flex-wrap:wrap">
        <a class="btn primary big" href="#/app">${d.connected ? "Open your portfolio" : "Connect wallet and start"}</a>
        <a class="btn big" href="#/explorer">See live pricing</a>
        <a class="btn big" href="#/evidence">Read the evidence</a>
      </div>
    </div>

    ${p ? livePreview(p) : `<div class="panel pad" style="margin-top:30px"><p class="empty">reading the live venue…</p></div>`}

    <div class="sec-head" style="margin-top:44px"><h2>What the layer above actually does</h2></div>
    <div class="grid g3">
      ${[
        [
          "Allocates across markets",
          "Eight windows are live at once — BTC and ETH at 15m, 1h, 4h and 1d. They are not eight independent bets. Rivo ranks them by edge per unit of exposure consumed and funds them from one budget.",
        ],
        [
          "Holds portfolio-wide risk",
          "BTC-1h DOWN and BTC-4h DOWN are one directional view expressed twice. A per-signal bot sizes both in full; Rivo counts them once against a delta budget, and against a combined budget through the measured BTC/ETH correlation.",
        ],
        [
          "Manages after entry",
          "Conviction decay, settlement, claiming, and capital redeployment run without a human. Positions are reconciled against the chain every cycle — the chain wins any disagreement, and a restart adopts what is held rather than buying it twice.",
        ],
        [
          "Explains every refusal",
          "Each rejected leg carries the constraint that caused it and the collateral that constraint allowed. Nothing is generated; the sentence is a rendering of the allocator's own output.",
        ],
        [
          "Isolates each portfolio",
          "A policy is keyed by wallet. Conservative and Active are not a size dial — they change which constraint binds first, so the same market can be a full position under one and no position under the other.",
        ],
        [
          "Publishes what failed",
          "Taking liquidity measured negative at every threshold across 53,989 fills. Two calibration corrections were rejected when the holdout did not support them. Both are in the evidence rather than out of it.",
        ],
      ]
        .map(([t, b]) => `<div class="panel pad"><h3>${t}</h3><p class="mut" style="font-size:13px;margin:7px 0 0">${b}</p></div>`)
        .join("")}
    </div>

    ${
      d.evidence
        ? `<div class="sec-head" style="margin-top:44px"><h2>Measured, not asserted</h2>
             <span class="hint">held out of sample · <a href="#/evidence">method</a></span></div>
           <div class="grid g4">
             ${[
               ["AUC", d.evidence.auc.toFixed(4), "ranking skill on unseen windows"],
               ["Brier", d.evidence.brier.toFixed(4), "lower is better"],
               ["Skill vs base rate", pct(d.evidence.skill), "against the unconditional prior"],
               ["Forecasts", d.evidence.n.toLocaleString(), "across 6,157 settled windows"],
             ]
               .map(
                 ([k, v, s]) =>
                   `<div class="panel stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`,
               )
               .join("")}
           </div>`
        : ""
    }

    <div class="panel pad" style="margin-top:30px">
      <h3>What Rivo does not claim</h3>
      <p class="mut" style="font-size:13.5px;margin:8px 0 0">
        Fair-value pricing, market discovery, edge gating and settlement primitives are DreamDEX's,
        not ours — Rivo uses them. Rivo is not proven profitable, and we do not present it as such:
        the forecasting model has measured out-of-sample skill, and the measured result of taking
        liquidity on this venue is negative. What we built and can defend is the layer that decides
        <em>how much of which</em>, refuses most of what looks attractive, and keeps a record honest
        enough to include the results that went against us.
      </p>
    </div>
  </div>`;
}

function livePreview(p: PortfolioView): string {
  const btc = p.exposures.find((e) => e.asset === "BTC");
  const refused = p.skipped.filter((d) => (d.edge ?? 0) > 0);
  const rows = new Map<string, { label: string; fair: number; ask: number | null; bid: number | null }>();
  for (const d of [...p.accepted, ...p.skipped]) {
    if (d.leg === "UP") rows.set(d.marketId, { label: `${d.asset} ${d.tenor}`, fair: d.fair, ask: d.ask, bid: null });
  }
  return `
  <div class="panel" style="margin-top:30px">
    <div class="pad" style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
      <div>
        <h3>Running right now, on a 50-unit balanced policy</h3>
        <p class="mut" style="font-size:13px;margin:4px 0 0">
          Not a screenshot. This is the engine, in your browser, against the live venue this second.
        </p>
      </div>
      <span class="tag ok live"><i class="dot"></i>live</span>
    </div>
    <div class="pad" style="padding-top:0">
      <div class="grid g4" style="margin-bottom:16px">
        <div class="stat" style="padding:0"><div class="k">Legs priced</div><div class="v">${p.accepted.length + p.skipped.length}</div></div>
        <div class="stat" style="padding:0"><div class="k">Allocated to</div><div class="v">${p.accepted.length}</div><div class="s">${f2(p.deployed)} of 50 deployed</div></div>
        <div class="stat" style="padding:0"><div class="k">Refused with edge</div><div class="v">${refused.length}</div><div class="s">portfolio limits, not price</div></div>
        <div class="stat" style="padding:0"><div class="k">BTC exposure</div><div class="v">${btc ? signed(btc.delta) : "—"}</div><div class="s">of ±${btc ? f2(btc.cap) : "—"} per 1% move</div></div>
      </div>
      ${termChart([...rows.values()])}
      ${
        refused.length > 0
          ? `<div class="note" style="margin-top:14px">
               <b>${esc(refused[0]!.label)}</b> has ${signed((refused[0]!.edge ?? 0) * 100, 1)}% of raw edge and Rivo
               <b>refused it</b> — ${esc(refused[0]!.binding)}. That refusal is the product.
               <a href="#/app">See the full reasoning</a>.
             </div>`
          : ""
      }
    </div>
  </div>`;
}
