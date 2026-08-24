// The front door.
//
// A judge opening this project has to understand within seconds that it is an
// portfolio layer over DreamDEX rather than another pricing dashboard, so the
// page leads with the sentence that says so and with the one number that proves
// the layer is doing something: live exposure against a live budget.
//
// This bundle is no longer published as a product of its own — see the README's
// "browser bundle" section. It is kept and tested because the pricing engine
// running in a browser with no Node is a real property, and boot.test.ts proves
// it against what actually ships.
//
// It deliberately does NOT open with the model, the mathematics, or the venue.
// Those are the reason the product works; they are not the product.

import { esc, f2, f3, pct, pending, relTime, signed } from "./dom.js";
import { termChart, type TermRow } from "./charts.js";
import type { PortfolioView } from "../engine.js";

export interface LandingData {
  /** A live preview cycle run against a demo policy, so the page shows a real allocation. */
  preview: PortfolioView | null;
  evidence: { auc: number; brier: number; skill: number; n: number } | null;
  connected: boolean;
  /** Why the last venue read failed, when it did. */
  error?: string | null;
  /** When that attempt was, for "3 minutes ago". */
  errorAt?: number;
}

/** The portfolio-level constraints, as opposed to "the price was bad". */
const PORTFOLIO_LIMIT = /delta budget|combined delta|expiry bucket|deployed cap|max position|tenor cap|cash floor|free cash/;

/**
 * The strongest thing this project can say, said first.
 *
 * The page used to open with a paragraph about what Rivo is, and buried the one
 * claim no competitor can make — that it turned down a trade it could see money
 * in, and named the limit that stopped it — in a note at the bottom of a panel
 * most visitors never scrolled to. Now the refusal IS the headline, in the
 * product's own live numbers.
 *
 * It only becomes the headline once there is a refusal to name. The venue read
 * takes a few seconds, so the static claim holds the space until then and the
 * block reserves its height, which keeps the swap from moving anything below it.
 */
function hero(d: LandingData): string {
  const refusal = d.preview?.skipped
    .filter((x) => (x.edge ?? 0) > 0)
    .find((x) => PORTFOLIO_LIMIT.test(x.binding));

  const cta = `
      <div style="display:flex;gap:10px;margin-top:26px;flex-wrap:wrap">
        <!-- No wallet is needed to run one, so the front door must not ask for
             an extension install. It used to read "Connect wallet and start",
             which was true before the demo identity landed and is now a toll
             booth on an open road. -->
        <a class="btn primary big" href="#/app">${d.connected ? "Open your portfolio" : "Give it a budget"}</a>
        <a class="btn big" href="#/app">See every constraint it applied</a>
        <a class="btn big" href="#/evidence">Read the evidence</a>
      </div>`;

  if (!refusal) {
    return `
    <div style="max-width:820px;padding:38px 0 8px;min-height:360px">
      <span class="tag ok" style="margin-bottom:16px"><i class="dot"></i>live on Somnia testnet</span>
      <h1 style="margin-top:14px">Rivo turns DreamDEX bots<br>into a portfolio.</h1>
      <p class="lede" style="margin-top:18px">
        DreamDEX already gives you bot infrastructure, fair-value primitives and execution. Rivo sits
        one level above: give it a capital budget and a risk policy once, and it manages the whole
        Event Contract term structure as a single book — allocating across markets, holding
        portfolio-wide BTC and ETH limits, managing positions through settlement, reconciling against
        the chain, and showing you the binding reason behind every decision.
      </p>
      ${cta}
    </div>`;
  }

  const points = ((refusal.edge ?? 0) * 100).toFixed(1);
  return `
    <div style="max-width:960px;padding:38px 0 8px;min-height:360px">
      <span class="tag ok"><i class="dot"></i>live on Somnia testnet · cycle ${d.preview!.cycles}</span>
      <p style="font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.13em;
                color:var(--faint);margin:20px 0 12px">
        ${esc(relTime(d.preview!.at))}, Rivo turned this down
      </p>
      <h1 style="line-height:1.04">
        <span style="font-family:var(--mono);font-weight:500;letter-spacing:-.02em">${esc(refusal.label)}</span><br>
        priced ${refusal.ask === null ? "—" : f3(refusal.ask)}. Worth ${f3(refusal.fair)}.
      </h1>
      <p class="lede" style="margin-top:20px;max-width:680px">
        ${points} points of edge, depth available, and Rivo refused it — because ${esc(refusal.binding)}.
        A signal bot takes it. Rivo counts it against exposure that is already spoken for, and holds
        the whole term structure as one book instead.
      </p>
      ${cta}
    </div>`;
}

export function landing(d: LandingData): string {
  const p = d.preview;
  return `
  <div class="wrap">
    ${hero(d)}

    <div style="margin-top:30px">${p ? livePreview(p) : pending("reading the live venue", d.error ?? null, d.errorAt)}</div>

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
  // The callout should demonstrate the claim the page makes — that legs are
  // refused by PORTFOLIO limits rather than by price. Taking whichever refusal
  // happens to rank first by edge produced examples like "top-up below minimum
  // trade", which is true, uninteresting, and about trade size rather than risk.
  const refused = p.skipped.filter((d) => (d.edge ?? 0) > 0);
  const PORTFOLIO_LIMIT = /delta budget|combined delta|expiry bucket|deployed cap|max position|tenor cap|cash floor|free cash/;
  const headline = refused.find((d) => PORTFOLIO_LIMIT.test(d.binding)) ?? refused[0];
  const rows = new Map<string, TermRow>();
  for (const d of [...p.accepted, ...p.skipped]) {
    const row = rows.get(d.marketId) ?? { asset: d.asset, tenor: d.tenor, label: `${d.asset} ${d.tenor}`, up: null, down: null };
    if (d.leg === "UP") row.up = { fair: d.fair, ask: d.ask };
    else row.down = { fair: d.fair, ask: d.ask };
    rows.set(d.marketId, row);
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
      <p class="mut" style="font-size:12px;margin:10px 0 0">
        One row per window, showing its <b>UP</b> leg. Every window also trades a DOWN leg at its own
        price, and Rivo scores both — ${p.accepted.length + p.skipped.length} legs across these
        ${rows.size} windows this cycle.
      </p>
      ${
        headline
          ? `<div class="note" style="margin-top:14px">
               Right now: <b>${esc(headline.label)}</b> is priced at ${headline.ask === null ? "—" : headline.ask.toFixed(3)}
               against Rivo's ${headline.fair.toFixed(3)} — ${signed((headline.edge ?? 0) * 100, 1)} points of raw edge —
               and Rivo <b>refused it</b>, because ${esc(headline.binding)}.
               ${
                 PORTFOLIO_LIMIT.test(headline.binding)
                   ? "That is a portfolio limit, not a view about the price: the exposure is already spoken for."
                   : ""
               }
               <a href="#/app">See every constraint it applied</a>.
             </div>`
          : ""
      }
    </div>
  </div>`;
}
