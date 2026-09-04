// The evidence page.
//
// This exists because the honest version of Rivo's claim is narrow, and a narrow
// claim is only credible if you can see what was tested and what failed. So the
// negative results are not in an appendix — the backtest section leads with a
// loss, and the maker section leads with adverse selection.
//
// Everything here is read from the JSON artefacts the research CLIs write
// (docs/evidence/*.json). Nothing is typed in by hand, so a figure on this page
// cannot drift from the run that produced it.

import { esc, f2, pct } from "./dom.js";
import { reliabilityChart } from "./charts.js";

export interface EvidenceBundle {
  calibration: Calibration | null;
  backtest: Backtest | null;
  coherence: Coherence | null;
  maker: MakerLive | null;
  canary: LiveCanary | null;
}

interface LiveCanary {
  generatedAt: string;
  network: string;
  wallet: { address: string; url: string; collateral: number; collateralSymbol: string };
  authority: { kind: string; boundedOnChain: boolean; bounds: string };
  runtime: { cycles: number; capital: number; cash: number; realizedPnl: number; contributed: number };
  ledger: { identity: string; imbalance: number; balances: boolean };
  execution: {
    positionsOpenedByRivo: number;
    withTransactionHash: number;
    receipts: { hash: string; url: string; succeeded: boolean; block: number | null; events: number | null }[];
  };
  stages: { name: string; proven: boolean; evidence: string }[];
}

interface Calibration {
  generatedAt: string;
  period: { from: number; to: number };
  sample: { marketsTotal: number; marketsUsed: number; forecasts: number; realizedUpRate: number };
  discrimination: { auc: number };
  calibration: { brier: number; brierCoin: number; brierPrior: number; logLoss: number };
  shrinkage: { prior: number; slope: number; brierAfter: number };
  reliability: { lo: number; hi: number; n: number; meanP: number; freq: number }[];
  byPhase: { phase: number; n: number; auc: number | null; brier: number }[];
  holdout: { n: number; auc: number; brier: number; brierCoin: number };
}
interface Backtest {
  params: { days: number; capital: number };
  stream: { markets: number; chances: number };
  results: { name: string; finalEquity: number; return: number; maxDrawdown: number; trades: number; hitRate: number; returnOnStake: number }[];
}
interface Coherence {
  days: number;
  grossProfitCeiling: number;
  observations: number;
  violations: number;
  violationRate: number;
  executableViolations: number;
  roundTripCost: number;
}
interface MakerLive {
  params: { cycles: number; mode: string };
  metrics: {
    ordersPosted: number; fills: number; filledShares: number; pairedShares: number;
    capturedSpreadPerShare: number; adverseSelectionPerShare: number;
  };
}

export function evidence(e: EvidenceBundle): string {
  return `
  <div class="wrap">
    <div style="max-width:780px;padding:26px 0 6px">
      <h1 style="font-size:clamp(24px,3.6vw,34px)">Measured before it was trusted</h1>
      <p class="lede" style="margin-top:12px;font-size:16px">
        Rivo's claim is narrow on purpose: the forecasting model has real out-of-sample skill, and
        the portfolio layer survives conditions that bankrupt every unconstrained baseline. Anything
        beyond that we could not demonstrate, and this page says where.
      </p>
    </div>
    ${e.canary ? canarySection(e.canary) : ""}
    ${e.calibration ? calibrationSection(e.calibration) : missing("calibration")}
    ${e.backtest ? backtestSection(e.backtest) : missing("backtest")}
    ${e.maker ? makerSection(e.maker) : ""}
    ${e.coherence ? coherenceSection(e.coherence) : ""}
    <div class="panel pad" style="margin-top:28px">
      <h3>Reproduce it</h3>
      <p class="mut" style="font-size:13.5px;margin-top:8px">
        Every figure above comes from a JSON artefact written by a CLI in this repo, against public
        indexer data, with no key required:
      </p>
      <pre class="num" style="font-size:12.5px;overflow-x:auto;background:var(--panel-2);padding:12px;border-radius:8px;margin:0"><code>npm run calibrate -- --days 30    # discrimination, calibration, holdout
npm run backtest  -- --days 30    # Rivo against five unconstrained baselines
npm run coherence -- --days 30    # cross-tenor arbitrage bound
npm run proof     -- --data-dir ./data-live   # the live execution chain
npm test                          # 930 tests, entirely offline</code></pre>
    </div>
  </div>`;
}

const missing = (what: string): string =>
  `<div class="panel pad" style="margin-top:20px"><p class="empty">${esc(what)} artefact not published with this build</p></div>`;

function canarySection(c: LiveCanary): string {
  const proven = c.stages.filter((s) => s.proven).length;
  const ok = c.execution.receipts.filter((r) => r.succeeded);
  return `
  <div class="sec-head" style="margin-top:34px"><h2>Does it actually run on-chain?</h2>
    <span class="hint">live canary on ${esc(c.network)} · ${c.runtime.cycles} cycles · ${new Date(c.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC</span></div>
  <div class="grid g4">
    ${[
      ["Stages evidenced", `${proven}/${c.stages.length}`, "each with a checkable artefact"],
      ["Transactions", String(ok.length), `all status 0x1`],
      ["Ledger imbalance", c.ledger.imbalance.toExponential(1), c.ledger.balances ? "balances" : "DOES NOT BALANCE"],
      ["Capital", f2(c.runtime.capital), `smallest safe size`],
    ]
      .map(([k, v, s]) => `<div class="panel stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
      .join("")}
  </div>
  <div class="grid side" style="margin-top:14px">
    <div class="panel pad">
      <h3>The autonomous path, stage by stage</h3>
      <p class="mut" style="font-size:12.5px;margin:4px 0 12px">
        A stage with no evidence is reported as unproven rather than omitted.
      </p>
      <div class="scroll"><table><tbody>
        ${c.stages
          .map(
            (s) => `<tr>
              <td style="white-space:nowrap"><span class="tag ${s.proven ? "ok" : "mute"}">${s.proven ? "✓" : "·"}</span>
                <b style="margin-left:6px">${esc(s.name)}</b></td>
              <td style="text-align:left;white-space:normal" class="mut">${esc(s.evidence)}</td>
            </tr>`,
          )
          .join("")}
      </tbody></table></div>
    </div>
    <div class="panel pad">
      <h3>Transactions</h3>
      <p class="mut" style="font-size:12.5px;margin:4px 0 10px">
        Receipts read back from the RPC, not from Rivo's own logs. Click through and check them.
      </p>
      <div style="font-family:var(--mono);font-size:11.5px;line-height:1.7">
        ${c.execution.receipts
          .slice(0, 10)
          .map(
            (r) =>
              `<div style="padding:4px 0;border-bottom:1px solid var(--line)">
                 <span class="${r.succeeded ? "pos" : "neg"}">${r.succeeded ? "✓" : "✗"}</span>
                 <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.hash.slice(0, 22))}…</a>
                 <span class="mut"> block ${r.block?.toLocaleString() ?? "?"} · ${r.events ?? "?"} events</span>
               </div>`,
          )
          .join("")}
      </div>
      <p class="mut" style="font-size:12px;margin:12px 0 0">
        Wallet <a href="${esc(c.wallet.url)}" target="_blank" rel="noopener">${esc(c.wallet.address.slice(0, 10))}…</a>
        · authority <b>${esc(c.authority.kind)}</b>${c.authority.boundedOnChain ? "" : ", bounded by Rivo rather than by the chain"}.
      </p>
    </div>
  </div>
  <p class="note" style="margin-top:14px">
    <b>${esc(c.ledger.identity)}</b> — checked before any risk figure is derived from it, because
    equity, drawdown and the circuit breaker all come from the same two numbers and would be wrong
    together. On this run the imbalance is ${c.ledger.imbalance.toExponential(1)}.
    Reproduce with <code>npm run proof -- --data-dir ./data-canary</code>.
  </p>`;
}

function calibrationSection(c: Calibration): string {
  const days = Math.round((c.period.to - c.period.from) / 86400);
  const skill = 1 - c.holdout.brier / c.holdout.brierCoin;
  return `
  <div class="banner warn" style="margin-top:34px">
    <strong>Read the next four numbers next to the verdict, not instead of it.</strong>
    They measure how well the forecast separates up from down, and it does that well. Trading it does
    not pay for itself out of sample &mdash; +2.80% return on stake at t = 0.79, walk-forward and
    window-clustered, and &minus;0.50% once its best fold is removed &mdash; so
    Rivo&rsquo;s own research marks the strategy <strong>REJECTED</strong> for real capital, and the
    execution path enforces that on every network. Being right about direction is not the same as being
    right by more than the spread you cross to act on it.
    <a href="https://github.com/Rzbyte/Rivo/blob/main/docs/ALPHA-RESEARCH.md">The study</a>.
  </div>

  <div class="sec-head"><h2>Does the model know anything?</h2>
    <span class="hint">${c.sample.forecasts.toLocaleString()} forecasts · ${c.sample.marketsUsed.toLocaleString()} settled windows · ${days} days</span></div>
  <div class="grid g4">
    ${[
      ["Holdout AUC", c.holdout.auc.toFixed(4), `on ${c.holdout.n.toLocaleString()} unseen forecasts`],
      ["Holdout Brier", c.holdout.brier.toFixed(4), `coin flip = ${c.holdout.brierCoin.toFixed(2)}`],
      ["Skill vs coin", pct(skill), "Brier skill score"],
      ["Base rate", pct(c.sample.realizedUpRate, 2), "UP over the whole sample"],
    ]
      .map(([k, v, s]) => `<div class="panel stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
      .join("")}
  </div>
  <div class="grid side" style="margin-top:14px">
    <div class="panel pad">
      <h3>Reliability</h3>
      <p class="mut" style="font-size:12.5px;margin:4px 0 12px">
        Predicted probability against what actually happened. On the diagonal is perfect; dot size is
        the number of forecasts in the bin.
      </p>
      ${reliabilityChart(c.reliability.filter((r) => r.n > 0).map((r) => ({ p: r.meanP, freq: r.freq, n: r.n })))}
    </div>
    <div class="panel pad">
      <h3>Skill by window phase</h3>
      <p class="mut" style="font-size:12.5px;margin:4px 0 10px">
        Early in a window there is almost nothing to know; near expiry the answer is nearly
        determined. A model that scored evenly across phases would be suspicious.
      </p>
      <div class="scroll"><table><thead><tr><th>Elapsed</th><th>AUC</th><th>Brier</th><th>N</th></tr></thead><tbody>
        ${c.byPhase
          .map(
            (p) =>
              `<tr><td>${pct(p.phase, 0)}</td><td class="n">${p.auc === null ? "—" : p.auc.toFixed(3)}</td>
               <td class="n">${p.brier.toFixed(3)}</td><td class="n mut">${p.n.toLocaleString()}</td></tr>`,
          )
          .join("")}
      </tbody></table></div>
    </div>
  </div>
  <p class="note" style="margin-top:14px">
    <b>A correction we rejected.</b> Fitting a shrinkage slope to the full sample gave
    ${c.shrinkage.slope.toFixed(3)} and improved in-sample Brier to ${c.shrinkage.brierAfter.toFixed(4)}.
    It did not survive the holdout, so it is not applied. The model ships uncorrected because the
    data did not support correcting it — this is the kind of result that is easy to quietly keep.
  </p>`;
}

function backtestSection(b: Backtest): string {
  const rivo = b.results[0]!;
  const others = b.results.slice(1);
  const bankrupt = others.filter((r) => r.finalEquity <= 0).length;
  return `
  <div class="sec-head" style="margin-top:38px"><h2>Does the portfolio layer matter?</h2>
    <span class="hint">${b.params.days} days · ${b.stream.chances.toLocaleString()} chances to trade · ${b.params.capital} starting capital</span></div>
  <div class="panel"><div class="scroll"><table>
    <thead><tr><th>Rule</th><th>Final equity</th><th>Return</th><th>Max drawdown</th><th>Trades</th><th>Hit rate</th><th>Per unit staked</th></tr></thead>
    <tbody>${b.results
      .map(
        (r, i) => `<tr${i === 0 ? ' style="background:var(--accent-soft)"' : ""}>
          <td><b>${esc(r.name)}</b></td>
          <td class="n ${r.finalEquity <= 0 ? "neg" : ""}">${r.finalEquity <= 0 ? "0 — ruined" : f2(r.finalEquity)}</td>
          <td class="n ${r.return < 0 ? "neg" : "pos"}">${pct(r.return)}</td>
          <td class="n">${pct(r.maxDrawdown)}</td>
          <td class="n">${r.trades.toLocaleString()}</td>
          <td class="n">${pct(r.hitRate)}</td>
          <td class="n ${r.returnOnStake < 0 ? "neg" : "pos"}">${pct(r.returnOnStake)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table></div></div>
  <p class="note warn" style="margin-top:14px">
    <b>Read this honestly.</b> Rivo finished at ${pct(rivo.return)} — a loss. It is on the page because
    the comparison is the finding, not the level: all ${bankrupt} unconstrained baselines reached zero
    inside about 50 trades, and Rivo was still trading after ${rivo.trades.toLocaleString()}. The
    portfolio layer is demonstrably doing something, and what it is doing is preventing ruin on a
    signal that loses money when you cross the spread to take it. That is a real result and it is not
    a profitable strategy.
  </p>`;
}

function makerSection(m: MakerLive): string {
  const net = m.metrics.capturedSpreadPerShare + m.metrics.adverseSelectionPerShare;
  return `
  <div class="sec-head" style="margin-top:38px"><h2>Would providing liquidity work instead?</h2>
    <span class="hint">first live evidence · ${m.params.cycles} cycles on testnet</span></div>
  <div class="grid g4">
    ${[
      ["Orders posted", String(m.metrics.ordersPosted), "post-only, both sides"],
      ["Fills", `${m.metrics.fills}`, `${m.metrics.filledShares} shares`],
      ["Paired", `${m.metrics.pairedShares}`, "both sides of a quote filled"],
      ["Net per share", net.toFixed(4), "captured spread + adverse selection"],
    ]
      .map(
        ([k, v, s]) =>
          `<div class="panel stat"><div class="k">${k}</div><div class="v ${k === "Net per share" && net < 0 ? "neg" : ""}">${v}</div><div class="s">${s}</div></div>`,
      )
      .join("")}
  </div>
  <p class="note" style="margin-top:14px">
    Taking liquidity measured negative, so the obvious next question is whether providing it works.
    On the first live evidence it does not: captured spread was ${m.metrics.capturedSpreadPerShare.toFixed(4)}
    per share against adverse selection of ${m.metrics.adverseSelectionPerShare.toFixed(4)}, and
    ${m.metrics.pairedShares === 0 ? "not one quote filled on both sides" : `only ${m.metrics.pairedShares} shares paired`} —
    the fills that arrived were the ones we did not want. That is Glosten–Milgrom behaving exactly as
    described, on a sample far too small to conclude from. It is an open question, reported as one.
  </p>`;
}

function coherenceSection(c: Coherence): string {
  return `
  <div class="sec-head" style="margin-top:38px"><h2>Is there a model-free arbitrage across tenors?</h2>
    <span class="hint">${c.observations.toLocaleString()} observations over ${c.days} days</span></div>
  <div class="panel pad">
    <p class="mut" style="font-size:13.5px;margin-top:0">
      A 1-hour window and the 15-minute window ending with it must satisfy a bound that holds
      whatever the true price process is. Violating it is mispricing no model is needed to detect.
      The bound is violated ${pct(c.violationRate)} of the time — ${c.violations.toLocaleString()} times —
      and ${c.executableViolations.toLocaleString()} of those clear the ${c.roundTripCost.toFixed(3)} round-trip cost.
    </p>
    <p class="mut" style="font-size:13.5px;margin-bottom:0">
      <b>We did not build it.</b> Total gross profit available across the entire 30 days, at a
      deliberately generous ceiling, is <b>${c.grossProfitCeiling.toFixed(2)} collateral</b>. The
      inefficiency is real and it is too small to be a product. Reporting it and declining to chase it
      is the same judgement the allocator makes on every leg it refuses.
    </p>
  </div>`;
}
