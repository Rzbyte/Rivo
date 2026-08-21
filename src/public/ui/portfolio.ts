// The main Rivo experience: connect, configure, run, and see why.
//
// The screen is arranged around one claim: Rivo manages a PORTFOLIO, not a list
// of trades. So the order is capital → exposure → positions → decisions, and the
// decisions come last because they only make sense once you can see the budget
// they were competing for. A layout that led with a signal feed would be a
// different product's layout.

import { explain } from "../explain.js";
import type { DecisionView, PortfolioView } from "../engine.js";
import type { PortfolioPolicy, RunMode } from "../../portfolio/policy.js";
import { PROFILES, type ProfileName } from "../../portfolio/profiles.js";
import type { WalletState } from "../wallet.js";
import type { BackendStatus } from "../backend.js";
import { addressUrl, tenorLabel, type Network } from "../../core/venue.js";
import { isDemo } from "../store.js";
import { clock, cls, esc, f2, f3, horizon, meter, pct, relTime, shortAddr, signed } from "./dom.js";
import { equityChart, exposureBar, termChart } from "./charts.js";

export interface AppState {
  wallet: WalletState | null;
  connecting: boolean;
  error: string | null;
  policy: PortfolioPolicy | null;
  view: PortfolioView | null;
  backend: BackendStatus | null;
  /** Draft configuration, before Start. */
  draft: { capital: number; profile: ProfileName; mode: RunMode };
  busy: boolean;
  showAdvanced: boolean;
  equity: { t: number; equity: number }[];
  activity: { at: number; kind: string; text: string }[];
}

// ---------------------------------------------------------------- connect gate

export function connectGate(s: AppState): string {
  const noProvider = s.error === "NO_PROVIDER";
  return `
  <div class="wrap narrow" style="padding-top:56px">
    <h1>Give Rivo a budget<br>and a risk policy.</h1>
    <p class="lede" style="margin-top:16px">
      It evaluates the whole DreamDEX Event Contract term structure as one portfolio, allocates only
      within portfolio-wide constraints, manages the positions through settlement, and shows you the
      binding reason behind every decision.
    </p>
    <div class="panel pad" style="margin-top:28px">
      ${
        noProvider
          ? `<h3>No wallet detected — that is fine</h3>
             <p class="mut" style="font-size:13.5px;margin-top:6px">
               Shadow Mode runs the real engine against the live venue with paper fills, so it needs
               no signature and no funds. Start one now — if you connect a wallet later, this
               portfolio comes with you.</p>
             <div style="display:flex;gap:9px;margin-top:14px;flex-wrap:wrap">
               <button class="primary" data-act="demo">Start a portfolio</button>
               <a class="btn" href="#/explorer">Open the explorer</a>
             </div>`
          : `<div style="display:flex;gap:10px;flex-wrap:wrap">
               <button class="primary big" data-act="connect" ${s.connecting ? "disabled" : ""}>
                 ${s.connecting ? "check your wallet…" : "Connect wallet"}
               </button>
               <button class="big" data-act="demo">Try it without a wallet</button>
             </div>
             <p class="mut" style="font-size:12.5px;margin-top:12px;margin-bottom:0">
               Read-only either way. Shadow Mode never signs and never spends, so a wallet is only
               used to scope your portfolio and show your balances — nothing on this page requests a
               signature, and no field on it could accept a private key.
             </p>`
      }
      ${s.error && !noProvider ? `<p class="note warn" style="margin-bottom:0">${esc(s.error)}</p>` : ""}
    </div>
    <div class="grid g3" style="margin-top:14px">
      ${[
        ["Cross-market allocation", "Eight live windows are two underlyings at four horizons. Rivo sizes them as one book."],
        ["Constraints that bind", "Every rejection names the limit that caused it, in collateral you can check."],
        ["Measured, not asserted", "30,771 held-out forecasts, and the negative results are published too."],
      ]
        .map(([t, d]) => `<div class="panel pad"><h3>${t}</h3><p class="mut" style="font-size:13px;margin:6px 0 0">${d}</p></div>`)
        .join("")}
    </div>
  </div>`;
}

// ------------------------------------------------------------------- wallet bar

export function walletChip(s: AppState): string {
  if (!s.wallet) {
    return `<button class="primary" data-act="connect" ${s.connecting ? "disabled" : ""}>${
      s.connecting ? "connecting…" : "Connect wallet"
    }</button>`;
  }
  const w = s.wallet;
  if (w.network === null) {
    return `<span class="tag bad"><i class="dot"></i>wrong network</span>
            <button data-act="switch">Switch to Somnia</button>`;
  }
  if (isDemo(w.address)) {
    // A demo identity gets the same way out as a real one. It had none, which
    // made it the one state in the app you could enter and not leave: no reset,
    // no route back to the gate, and the only exit was to connect a wallet —
    // an extension install as the price of undoing a click. The word is
    // "Discard" rather than "Disconnect" because there is nothing connected;
    // the portfolio is local, and this throws it away.
    return `
      <span class="tag warn">demo portfolio</span>
      <button data-act="connect">Connect a wallet</button>
      <button class="ghost" data-act="disconnect" title="Discard this demo portfolio">×</button>`;
  }
  return `
    <span class="tag mute" title="${esc(w.address)}">${esc(shortAddr(w.address))}</span>
    <span class="tag ok"><i class="dot"></i>${esc(w.network)}</span>
    <button class="ghost" data-act="disconnect" title="Forget this wallet on this device">×</button>`;
}

function walletPanel(w: WalletState): string {
  const net = w.network as Network;
  if (isDemo(w.address)) {
    return `
    <div class="panel pad">
      <h3>Demo portfolio</h3>
      <p class="mut" style="font-size:13px;margin:6px 0 0">
        No wallet connected, and none needed: Shadow Mode prices the live venue and fills on paper,
        so nothing here is signed or spent. Your policy is stored in this browser only, and moves
        onto your wallet if you connect one.
      </p>
      <button style="margin-top:12px" data-act="connect">Connect a wallet to see real balances</button>
    </div>`;
  }
  return `
  <div class="panel pad">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
      <h3>Wallet</h3>
      <a class="mut" style="font-size:12px" target="_blank" rel="noopener"
         href="${esc(addressUrl(net, w.address))}">${esc(shortAddr(w.address))} ↗</a>
    </div>
    <div class="grid g2" style="margin-top:12px">
      <div><div class="stat" style="padding:0">
        <div class="k">${esc(w.gasSymbol)} · gas</div><div class="v">${f3(w.gas)}</div>
        ${w.gas <= 0 ? `<div class="s" style="color:var(--warn)">no gas — Autopilot cannot send</div>` : ""}
      </div></div>
      <div><div class="stat" style="padding:0">
        <div class="k">${esc(w.collateralSymbol)} · collateral</div><div class="v">${f2(w.collateral)}</div>
        <div class="s">what DreamDEX settles in</div>
      </div></div>
    </div>
  </div>`;
}

// ----------------------------------------------------------------- configuring

const PROFILE_COPY: Record<ProfileName, string> = {
  conservative: "Refuses concentration the others accept. Holds 60% of capital in cash and needs 5 points of edge before crossing a spread.",
  balanced: "Half-Kelly sizing, 70% deployable, and a delta budget that lets two tenors of the same view coexist — but not three.",
  active: "Full Kelly, 90% deployable. Will cross a 2-point spread and hold 12% of capital of directional exposure per underlying.",
};

export function configure(s: AppState): string {
  const w = s.wallet!;
  const d = s.draft;
  const p = PROFILES[d.profile];
  const cap = d.capital;
  const blocked = s.backend === null || !s.backend.canTrade;

  return `
  <div class="wrap">
    <div class="grid side">
      <div>
        <h2>Set your portfolio policy</h2>
        <p class="mut" style="font-size:13.5px;margin-top:4px">
          You set this once. Rivo enforces it on every cycle without asking again.
        </p>

        <div class="panel pad" style="margin-top:16px">
          <div class="field">
            <label for="cap">Capital budget · ${esc(w.collateralSymbol)}</label>
            <input id="cap" type="number" min="1" step="1" value="${cap}" data-input="capital">
            <p class="mut" style="font-size:12px;margin:6px 0 0">
              The ceiling on everything below. In Shadow Mode this is simulated, so it need not match
              your balance of ${f2(w.collateral)}.
            </p>
          </div>

          <div class="field">
            <label>Risk profile</label>
            <div class="seg h3">
              ${(Object.keys(PROFILES) as ProfileName[])
                .map(
                  (name) => `
                <button data-act="profile" data-v="${name}" aria-pressed="${d.profile === name}">
                  <span class="t">${name[0]!.toUpperCase()}${name.slice(1)}</span>
                  <span class="d">${pct(PROFILES[name].maxDeployed, 0)} deployed · ${pct(PROFILES[name].minEdge, 0)} min edge</span>
                </button>`,
                )
                .join("")}
            </div>
            <p class="mut" style="font-size:12.5px;margin:9px 0 0">${PROFILE_COPY[d.profile]}</p>
          </div>

          <div class="field" style="margin-bottom:0">
            <label>Mode</label>
            <div class="seg h2">
              <button data-act="mode" data-v="shadow" aria-pressed="${d.mode === "shadow"}">
                <span class="t">Shadow</span>
                <span class="d">Real prices, real settlement, paper fills. Runs here in your browser.</span>
              </button>
              <button data-act="mode" data-v="autopilot" aria-pressed="${d.mode === "autopilot"}" ${blocked ? "disabled" : ""}>
                <span class="t">Autopilot${blocked ? " · unavailable" : ""}</span>
                <span class="d">Real orders on Somnia. Needs a Rivo backend that stays awake to sign.</span>
              </button>
            </div>
          </div>
        </div>

        <details class="panel pad" style="margin-top:14px" ${s.showAdvanced ? "open" : ""}>
          <summary style="cursor:pointer;font-weight:600">Advanced limits</summary>
          <p class="mut" style="font-size:12.5px;margin-top:10px">
            These only ever tighten your profile. Rivo takes the stricter of the two, so a
            Conservative portfolio can never be loosened into Active limits while still saying
            “Conservative”.
          </p>
          <div class="grid g2" style="margin-top:12px">
            ${[
              ["maxDeployed", "Max deployed", p.maxDeployed],
              ["maxPerPosition", "Max one leg", p.maxPerPosition],
              ["maxAssetDeltaPer1Pct", "Per-asset delta", p.maxAssetDeltaPer1Pct],
              ["maxPerExpiryBucket", "Per expiry bucket", p.maxPerExpiryBucket],
            ]
              .map(
                ([k, label, v]) => `
              <div class="field" style="margin-bottom:0">
                <label for="ov-${k}">${label} · % of capital</label>
                <input id="ov-${k}" type="number" min="0" max="100" step="1"
                       value="${((v as number) * 100).toFixed(0)}" data-override="${k}">
              </div>`,
              )
              .join("")}
          </div>
        </details>
      </div>

      <div>
        ${walletPanel(w)}
        <div class="panel pad" style="margin-top:14px">
          <h3>What this policy means</h3>
          <table style="margin-top:10px">
            <tbody>
              ${[
                ["Deployed at most", `${f2(cap * p.maxDeployed)} ${w.collateralSymbol}`],
                ["Any one leg", `${f2(cap * p.maxPerPosition)}`],
                ["BTC exposure", `±${f2(cap * p.maxAssetDeltaPer1Pct)} per 1% move`],
                ["ETH exposure", `±${f2(cap * p.maxAssetDeltaPer1Pct)} per 1% move`],
                ["One expiry bucket", `${f2(cap * p.maxPerExpiryBucket)}`],
                ["Always in cash", `${f2(cap * p.cashFloor)}`],
                ["Kelly haircut", `${p.kellyFraction}×`],
              ]
                .map(([k, v]) => `<tr><td>${k}</td><td class="n">${v}</td></tr>`)
                .join("")}
            </tbody>
          </table>
        </div>
        <button class="primary big" data-act="start" style="width:100%;justify-content:center;margin-top:14px"
                ${s.busy ? "disabled" : ""}>
          ${s.busy ? "starting…" : "Start Rivo"}
        </button>
        ${
          blocked && d.mode === "shadow"
            ? `<p class="mut" style="font-size:12px;margin-top:10px">
                 Autopilot is unavailable from this page — see <a href="#/app" data-act="whyblocked">why</a>.
               </p>`
            : ""
        }
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------- dashboard

export function dashboard(s: AppState): string {
  const v = s.view;
  const policy = s.policy!;
  const w = s.wallet!;
  if (!v) return `<div class="wrap"><p class="empty">running the first cycle against the live venue…</p></div>`;

  const live = policy.state === "running";
  const modeTag =
    policy.mode === "autopilot"
      ? `<span class="tag bad live"><i class="dot"></i>autopilot · live orders</span>`
      : `<span class="tag ok ${live ? "live" : ""}"><i class="dot"></i>shadow${live ? " · running" : ""}</span>`;

  const totalPnl = v.realizedPnl + v.unrealizedPnl;

  return `
  <div class="wrap">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      ${modeTag}
      <span class="tag mute">${esc(policy.profile)}</span>
      ${policy.state === "paused" ? `<span class="tag warn">paused — managing, not opening</span>` : ""}
      ${policy.state === "halted" ? `<span class="tag bad">halted — ${esc(policy.stoppedReason ?? "circuit breaker")}</span>` : ""}
      <span class="mut" style="font-size:12.5px">cycle ${v.cycles} · ${esc(relTime(v.at))}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        ${live ? `<button data-act="pause">Pause</button>` : `<button data-act="resume" ${s.busy ? "disabled" : ""}>Resume</button>`}
        <button class="danger" data-act="stop">Stop</button>
      </div>
    </div>

    <div class="grid g4">
      ${stat("Allocated", f2(v.capital), esc(w.collateralSymbol))}
      ${stat("Deployed", f2(v.deployed), `${pct(v.capital > 0 ? v.deployed / v.capital : 0, 0)} of capital${meter(v.deployed, v.limits.deployedCap)}`)}
      ${stat("Cash", f2(v.cash), `floor ${f2(v.limits.cashFloor)}`)}
      ${stat("P&L", signed(totalPnl), `${signed(v.realizedPnl)} realised · ${signed(v.unrealizedPnl)} open`, cls(totalPnl))}
    </div>

    <div class="grid side" style="margin-top:14px">
      <div>
        ${exposurePanel(v)}
        ${positionsPanel(v, w)}
      </div>
      <div>
        ${equityPanel(s, v)}
        ${feedPanel(s)}
      </div>
    </div>

    <div class="sec-head">
      <h2>Why this allocation?</h2>
      <span class="hint">Every reason below is the constraint the allocator actually applied — read off the engine, not written by a model.</span>
    </div>
    ${decisionsPanel(v)}

    <div class="sec-head"><h2>The live term structure</h2>
      <span class="hint">Rivo's model against the book, for all ${v.accepted.length + v.skipped.length} legs it priced this cycle.</span></div>
    <div class="panel pad">${termChart(termRows(v))}</div>

    ${v.closed.length > 0 ? settledPanel(v, w) : ""}

    <p class="note warn" style="margin-top:28px">
      Rivo is not proven profitable. The forecasting model has measured skill out of sample, and the
      measured result of <em>taking liquidity</em> on this venue is negative at every edge threshold we
      tested. What the portfolio layer demonstrably does is survive: unconstrained sizing on the same
      signal went bankrupt inside 60 trades in backtest, and the constrained portfolio did not.
      <a href="#/evidence">See the evidence</a>.
    </p>
  </div>`;
}

const stat = (k: string, v: string, s = "", klass = ""): string =>
  `<div class="panel stat"><div class="k">${k}</div><div class="v ${klass}">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;

function termRows(v: PortfolioView): { label: string; fair: number; ask: number | null; bid: number | null }[] {
  const seen = new Map<string, { label: string; fair: number; ask: number | null; bid: number | null }>();
  for (const d of [...v.accepted, ...v.skipped]) {
    if (d.leg !== "UP") continue; // one row per market; the Down leg is its complement
    seen.set(d.marketId, { label: `${d.asset} ${d.tenor}`, fair: d.fair, ask: d.ask, bid: d.bid });
  }
  return [...seen.values()];
}

function exposurePanel(v: PortfolioView): string {
  return `
  <div class="panel pad">
    <h3>Portfolio exposure</h3>
    <p class="mut" style="font-size:12.5px;margin:4px 0 14px">
      Collateral gained or lost per 1% move in the underlying. Two tenors of the same view count once,
      here, which is the reason this layer exists.
    </p>
    <div class="grid g2">
      ${v.exposures
        .map(
          (e) => `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:12.5px">
            <b>${e.asset}</b>
            <span class="num ${cls(e.delta)}">${signed(e.delta)} / ±${f2(e.cap)}</span>
          </div>
          ${exposureBar(e.delta, e.cap, e.asset)}
        </div>`,
        )
        .join("")}
    </div>
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px">
        <b>Combined <span class="mut" style="font-weight:400">· rho ${f2(v.rho)}, measured</span></b>
        <span class="num ${cls(v.combined.delta)}">${signed(v.combined.delta)} / ±${f2(v.combined.cap)}</span>
      </div>
      ${exposureBar(v.combined.delta, v.combined.cap, "combined")}
    </div>
    ${
      v.expiry.length > 0
        ? `<div style="margin-top:16px">
             <div class="k" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:600">
               Capital by expiry bucket</div>
             ${v.expiry
               .map(
                 (b) => `<div style="margin-top:8px">
                   <div style="display:flex;justify-content:space-between;font-size:12px">
                     <span class="mut">${esc(b.bucket.replace("T", " "))} UTC</span>
                     <span class="num">${f2(b.cost)} / ${f2(b.cap)}</span>
                   </div>${meter(b.cost, b.cap)}</div>`,
               )
               .join("")}
           </div>`
        : ""
    }
  </div>`;
}

function positionsPanel(v: PortfolioView, w: WalletState): string {
  return `
  <div class="panel" style="margin-top:14px">
    <div class="pad" style="padding-bottom:0"><h3>Open positions · ${v.positions.length}</h3></div>
    ${
      v.positions.length === 0
        ? `<p class="empty">nothing open — the skip reasons below say why</p>`
        : `<div class="scroll"><table>
             <thead><tr><th>Leg</th><th>Shares</th><th>Entry</th><th>Cost</th><th>Mark</th><th>Open P&L</th><th>Δ/1%</th><th>Settles</th></tr></thead>
             <tbody>${v.positions
               .map((p) => {
                 const pnl = p.value - p.cost;
                 return `<tr>
                   <td><b>${esc(p.label)}</b></td>
                   <td class="n">${f2(p.shares)}</td>
                   <td class="n">${f3(p.entryPrice)}</td>
                   <td class="n">${f2(p.cost)}</td>
                   <td class="n">${p.mark === null ? "—" : f3(p.mark)}</td>
                   <td class="n ${cls(pnl)}">${signed(pnl)}</td>
                   <td class="n ${cls(p.shares * p.deltaPer1PctPerShare)}">${signed(p.shares * p.deltaPer1PctPerShare)}</td>
                   <td class="n mut">${esc(horizon((p.expiry - v.at) / 60))}</td>
                 </tr>`;
               })
               .join("")}</tbody></table></div>
           <p class="mut" style="font-size:12px;padding:10px 18px 16px;margin:0">
             Marked at Rivo's model value, not the bid: these are held to settlement, and the bid is
             what a forced exit would realise. Denominated in ${esc(w.collateralSymbol)}.
           </p>`
    }
  </div>`;
}

function equityPanel(s: AppState, v: PortfolioView): string {
  return `
  <div class="panel pad">
    <h3>Equity</h3>
    <p class="mut" style="font-size:12.5px;margin:4px 0 10px">cash plus the model value of what is open</p>
    ${equityChart(s.equity, v.capital)}
  </div>`;
}

function feedPanel(s: AppState): string {
  const rows = s.activity.slice(0, 60);
  return `
  <div class="panel" style="margin-top:14px">
    <div class="pad" style="padding-bottom:8px"><h3>Activity</h3></div>
    <div class="pad feed" style="padding-top:0">
      ${
        rows.length === 0
          ? `<p class="empty">waiting for the first cycle</p>`
          : rows
              .map(
                (a) =>
                  `<div><time>${esc(clock(a.at))}</time><span class="k ${esc(a.kind)}">${esc(a.kind)}</span><span>${esc(a.text)}</span></div>`,
              )
              .join("")
      }
    </div>
  </div>`;
}

function settledPanel(v: PortfolioView, w: WalletState): string {
  const wins = v.closed.filter((c) => c.won === 1).length;
  const net = v.closed.reduce((s, c) => s + (c.proceeds - c.cost), 0);
  return `
  <div class="sec-head"><h2>Settled</h2>
    <span class="hint">${v.closed.length} resolved · ${wins} won · ${signed(net)} ${esc(w.collateralSymbol)} net</span></div>
  <div class="panel"><div class="scroll"><table>
    <thead><tr><th>Leg</th><th>Shares</th><th>Cost</th><th>Proceeds</th><th>Net</th><th>Result</th><th>When</th></tr></thead>
    <tbody>${v.closed
      .slice(0, 25)
      .map((c) => {
        const pnl = c.proceeds - c.cost;
        return `<tr>
          <td><b>${esc(c.asset)} ${esc(tenorLabel(c.intervalSec))} ${esc(c.leg)}</b></td>
          <td class="n">${f2(c.shares)}</td><td class="n">${f2(c.cost)}</td>
          <td class="n">${f2(c.proceeds)}</td>
          <td class="n ${cls(pnl)}">${signed(pnl)}</td>
          <td>${c.exit === "voided" ? `<span class="tag mute">voided</span>` : c.won ? `<span class="tag ok">won</span>` : `<span class="tag bad">lost</span>`}</td>
          <td class="n mut">${esc(relTime(c.closedAt, v.at))}</td>
        </tr>`;
      })
      .join("")}</tbody></table></div></div>`;
}

// -------------------------------------------------------------- the "why" panel

function decisionsPanel(v: PortfolioView): string {
  // Refusals with real edge are the interesting ones: a positive-expectancy trade
  // Rivo declined is the whole argument for the portfolio layer, so they lead.
  const interesting = v.skipped.filter((d) => (d.edge ?? 0) > 0);
  const rest = v.skipped.filter((d) => (d.edge ?? 0) <= 0);
  return `
  <div class="grid g2">
    <div>
      <h3 style="margin-bottom:9px">Taken · ${v.accepted.length}</h3>
      ${v.accepted.length === 0 ? `<p class="empty">nothing this cycle</p>` : v.accepted.map((d) => card(d, v, "buy")).join("")}
    </div>
    <div>
      <h3 style="margin-bottom:9px">Refused with positive edge · ${interesting.length}</h3>
      ${
        interesting.length === 0
          ? `<p class="empty">nothing with edge was refused this cycle</p>`
          : interesting.map((d) => card(d, v, "skip")).join("")
      }
      ${
        rest.length > 0
          ? `<details class="limits" style="margin-top:12px">
               <summary>${rest.length} more legs priced with no edge</summary>
               <div style="margin-top:9px">${rest.map((d) => card(d, v, "skip")).join("")}</div>
             </details>`
          : ""
      }
    </div>
  </div>`;
}

function card(d: DecisionView, v: PortfolioView, kind: "buy" | "skip"): string {
  const e = explain(d, v);
  const edgeTag =
    d.edge === null
      ? ""
      : `<span class="tag ${d.edge > 0 ? "ok" : "mute"}">${signed(d.edge * 100, 1)}% edge</span>`;
  return `
  <div class="dec ${kind}">
    <div class="dec-top">
      <span class="dec-name">${esc(d.label)}</span>
      ${edgeTag}
      <span class="tag mute">${esc(horizon(d.minutesLeft))} left</span>
      ${kind === "buy" ? `<span class="tag ok" style="margin-left:auto">${f2(d.cost)}</span>` : ""}
    </div>
    <div class="dec-why"><b>${esc(e.headline)}</b> ${esc(e.detail)}</div>
    ${
      e.competitors.length > 0
        ? `<div class="dec-why" style="margin-top:6px">Holding that budget: ${e.competitors
            .map((c) => `<b>${esc(c.label)}</b> <span class="num">(${f2(c.cost)}, Δ${signed(c.delta)})</span>`)
            .join(", ")}</div>`
        : ""
    }
    ${
      d.limits.length > 0
        ? `<details class="limits">
             <summary>every constraint the allocator applied</summary>
             <div style="margin-top:7px">
               ${d.limits
                 .map(
                   (l) => `<div class="limit-row ${l.binding ? "bind" : ""}">
                     <span class="lname">${esc(l.name)}</span>
                     <span class="lval">${l.allowedCost >= 1e9 ? "no limit" : `${f2(l.allowedCost)} allowed`}</span>
                   </div>`,
                 )
                 .join("")}
             </div>
             <p class="mut" style="font-size:12px;margin:8px 0 0">
               The smallest of these is what bound. Engine string: <code>${esc(d.binding)}</code>
             </p>
           </details>`
        : ""
    }
  </div>`;
}
