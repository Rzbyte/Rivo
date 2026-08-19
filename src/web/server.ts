// The Rivo dashboard.
//
// A local HTTP server over the same state the runtime writes — no build step, no
// framework, no bundler, and no dependency the rest of the project does not
// already have. The runtime is the product; this is a window onto it, and it is
// deliberately read-only so that watching Rivo can never change what Rivo does.
//
// The design goal is one screen that answers three questions in the order a
// person actually asks them: what is my money doing, how much risk is that, and
// why did it choose this. The third is the one no other trading bot answers.

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { DecisionLog, decisionLogPath, equityOf, statePath, type DecisionRecord, type RivoState } from "../runtime/state.js";
import { PROFILES } from "../portfolio/profiles.js";
import { riskOf, type Position } from "../portfolio/risk.js";

export interface DashboardData {
  state: RivoState | null;
  decisions: DecisionRecord[];
  error?: string;
}

function read(dataDir: string): DashboardData {
  const sp = statePath(dataDir);
  if (!existsSync(sp)) return { state: null, decisions: [], error: `No state at ${sp}. Start Rivo with \`npm start\`.` };
  try {
    const state = JSON.parse(readFileSync(sp, "utf8")) as RivoState;
    const decisions = new DecisionLog(decisionLogPath(dataDir)).read();
    return { state, decisions };
  } catch (e) {
    return { state: null, decisions: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Everything the page needs, computed server-side so the client stays dumb. */
export function view(data: DashboardData) {
  const { state, decisions } = data;
  if (!state) return { error: data.error ?? "no state" };

  const profile = PROFILES[state.profile as keyof typeof PROFILES] ?? PROFILES.balanced;
  const equity = equityOf(state);
  const deployed = equity - state.cash;
  const rho = 0.78; // display-only; the runtime measures it fresh each cycle
  const risk = riskOf(state.open as Position[], rho);

  const recent = decisions.slice(-400);
  const lastCycle = recent.length > 0 ? Math.max(...recent.map((d) => d.cycle)) : 0;
  const thisCycle = recent.filter((d) => d.cycle === lastCycle);

  // Group declines so the "why" panel shows patterns rather than a wall of lines.
  const declineReasons = new Map<string, number>();
  for (const d of recent.filter((x) => x.action === "SKIP")) {
    const key = d.binding
      .replace(/±[\d.]+\/1%/, "±budget")
      .replace(/expiry bucket \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "expiry-bucket concentration")
      .replace(/\(rho [\d.]+\)/, "")
      .replace(/[+-]?\d+\.\d+/g, "N")
      .replace(/\(\d+s left\)/, "(near expiry)")
      .trim();
    declineReasons.set(key, (declineReasons.get(key) ?? 0) + 1);
  }

  const settled = state.closed.filter((c) => c.exit === "settled");
  const staked = settled.reduce((n, c) => n + c.cost, 0);
  const returned = settled.reduce((n, c) => n + c.proceeds, 0);

  return {
    mode: state.dryRun ? "SHADOW" : "LIVE",
    profile: state.profile,
    kelly: profile.kellyFraction,
    capital: state.capital,
    cash: state.cash,
    deployed,
    equity,
    realizedPnl: state.realizedPnl,
    cycles: state.cycles,
    startedAt: state.startedAt,
    lastCycleAt: state.lastCycleAt,
    halted: state.halted,
    positions: state.open.map((p) => ({
      label: `${p.asset}-${Math.round(p.intervalSec / 60)}m`,
      asset: p.asset,
      leg: p.leg,
      shares: p.shares,
      entryPrice: p.entryPrice,
      cost: p.cost,
      expiry: p.expiry,
      fairAtEntry: p.fairAtEntry,
      delta: p.shares * p.deltaPer1PctPerShare,
    })),
    risk: {
      assetDelta: [...risk.assetDelta].map(([asset, d]) => ({
        asset,
        delta: d,
        budget: state.capital * profile.maxAssetDeltaPer1Pct,
      })),
      combined: risk.combinedDelta,
      combinedBudget: state.capital * profile.maxCombinedDeltaPer1Pct,
      maxLoss: risk.maxLoss,
      buckets: [...risk.expiryBuckets].map(([bucket, cost]) => ({
        bucket,
        cost,
        budget: state.capital * profile.maxPerExpiryBucket,
      })),
    },
    settled: {
      count: settled.length,
      wins: settled.filter((c) => c.won === 1).length,
      staked,
      returned,
      returnOnStake: staked > 0 ? (returned - staked) / staked : 0,
    },
    evaluations: decisions.length,
    lastCycleDecisions: thisCycle.map((d) => ({
      label: `${d.asset}-${Math.round(d.intervalSec / 60)}m`,
      leg: d.leg,
      action: d.action,
      fair: d.fair,
      ask: d.ask,
      edge: d.edge,
      shares: d.shares,
      cost: d.cost,
      binding: d.binding,
    })),
    declineReasons: [...declineReasons].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, n]) => ({ reason, n })),
  };
}

/**
 * Freeze the dashboard into one self-contained HTML file.
 *
 * The live page fetches `/api/state`; a snapshot inlines the same payload and
 * skips the fetch, so it opens from disk with no server, no network and no
 * dependencies. That is what makes it usable in a submission — a reviewer should
 * not have to run a trading bot to see what its interface looks like.
 */
export function snapshotHtml(dataDir: string): string {
  const payload = JSON.stringify(view(read(dataDir)));
  return PAGE.replace(
    "tick(); setInterval(tick,5000);",
    `render(${payload});/* static snapshot — captured ${new Date().toISOString()} */`,
  ).replace("<title>Rivo</title>", "<title>Rivo — snapshot</title>");
}

export function serve(dataDir: string, port: number): void {
  const server = createServer((req, res) => {
    if (req.url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(view(read(dataDir))));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  server.listen(port, () => {
    console.log(`RIVO dashboard  ->  http://localhost:${port}`);
    console.log(`reading ${statePath(dataDir)}`);
  });
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rivo</title>
<style>
  :root{
    --bg:#fbfbfa; --panel:#fff; --ink:#1a1a18; --muted:#6b6b66; --line:#e6e5e1;
    --pos:#1f7a4d; --neg:#b3321f; --accent:#2f5fd0; --warn:#a8621a;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#16161a; --panel:#1e1e23; --ink:#eceae4; --muted:#9a9a93; --line:#2e2e35;
    --pos:#4ec98a; --neg:#ff7a63; --accent:#7fa6ff; --warn:#e0a45c;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;}
  .wrap{max-width:980px;margin:0 auto;padding:32px 20px 64px}
  header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:28px}
  h1{font-size:26px;margin:0;letter-spacing:-.02em;font-weight:650}
  .badge{font:600 11px/1 var(--mono);letter-spacing:.09em;padding:5px 9px;border-radius:5px;
    border:1px solid var(--line);color:var(--muted)}
  .badge.live{color:var(--pos);border-color:currentColor}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--pos);display:inline-block;margin-right:6px;
    animation:pulse 2.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .sub{color:var(--muted);font-size:13px}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:26px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px 16px}
  .card .k{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
  .card .v{font:600 23px/1.1 var(--mono);letter-spacing:-.01em}
  .v.pos{color:var(--pos)} .v.neg{color:var(--neg)}
  h2{font-size:13px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);
    margin:30px 0 12px;font-weight:600}
  table{width:100%;border-collapse:collapse;font:13px/1.45 var(--mono)}
  th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;letter-spacing:.05em;
    text-transform:uppercase;padding:0 10px 7px 0;border-bottom:1px solid var(--line)}
  td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .tag{font:600 10px/1 var(--mono);padding:3px 6px;border-radius:4px;letter-spacing:.05em}
  .tag.buy{background:color-mix(in srgb,var(--pos) 15%,transparent);color:var(--pos)}
  .tag.skip{background:color-mix(in srgb,var(--muted) 15%,transparent);color:var(--muted)}
  .why{color:var(--muted);font-size:12px}
  .meter{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:5px;position:relative}
  .meter i{display:block;height:100%;border-radius:3px;background:var(--accent)}
  .meter i.hot{background:var(--warn)}
  .meter i.max{background:var(--neg)}
  .scroll{overflow-x:auto}
  .empty{color:var(--muted);font-style:italic;padding:16px 0}
  .halt{background:color-mix(in srgb,var(--neg) 12%,transparent);border:1px solid var(--neg);
    color:var(--neg);padding:11px 14px;border-radius:8px;margin-bottom:20px;font-size:13px}
  footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
</style></head>
<body><div class="wrap" id="app"><p class="empty">loading…</p></div>
<script>
const f2=n=>Number(n).toFixed(2), f3=n=>Number(n).toFixed(3);
const pct=n=>(100*n).toFixed(1)+'%';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function meter(used,budget){
  const r=budget>0?Math.min(1,Math.abs(used)/budget):0;
  const cls=r>=0.99?'max':r>=0.75?'hot':'';
  return '<div class="meter"><i class="'+cls+'" style="width:'+(r*100).toFixed(0)+'%"></i></div>';
}

function render(d){
  const app=document.getElementById('app');
  if(d.error){app.innerHTML='<h1>Rivo</h1><p class="empty">'+esc(d.error)+'</p>';return;}
  const pnlCls=d.realizedPnl>0?'pos':d.realizedPnl<0?'neg':'';
  const mins=Math.round((Date.now()/1000-d.lastCycleAt)/60);

  let h='<header><h1>Rivo</h1>'
    +'<span class="badge '+(d.mode==='LIVE'?'live':'')+'"><span class="dot"></span>'+d.mode+'</span>'
    +'<span class="sub">'+esc(d.profile)+' · Kelly ×'+d.kelly+' · cycle '+d.cycles
    +' · '+(mins<2?'just now':mins+'m ago')+'</span></header>';

  if(d.halted) h+='<div class="halt"><strong>Halted.</strong> '+esc(d.halted)+'</div>';

  h+='<div class="grid">'
    +'<div class="card"><div class="k">Capital</div><div class="v">'+f2(d.capital)+'</div></div>'
    +'<div class="card"><div class="k">Deployed</div><div class="v">'+f2(d.deployed)+'</div>'
      +'<div class="sub">'+pct(d.deployed/d.capital)+'</div></div>'
    +'<div class="card"><div class="k">Cash</div><div class="v">'+f2(d.cash)+'</div>'
      +'<div class="sub">'+pct(d.cash/d.capital)+'</div></div>'
    +'<div class="card"><div class="k">Realised P&amp;L</div><div class="v '+pnlCls+'">'
      +(d.realizedPnl>=0?'+':'')+f2(d.realizedPnl)+'</div></div>'
    +'</div>';

  h+='<h2>Allocation</h2>';
  if(!d.positions.length) h+='<p class="empty">100% cash — nothing cleared the thresholds.</p>';
  else{
    h+='<div class="scroll"><table><tr><th>Market</th><th>Leg</th><th class="num">Shares</th>'
      +'<th class="num">Entry</th><th class="num">Cost</th><th class="num">Δ per 1%</th>'
      +'<th class="num">Settles</th></tr>';
    for(const p of d.positions){
      const m=Math.max(0,Math.round((p.expiry-Date.now()/1000)/60));
      h+='<tr><td>'+esc(p.label)+'</td><td>'+esc(p.leg)+'</td>'
        +'<td class="num">'+f2(p.shares)+'</td><td class="num">'+f3(p.entryPrice)+'</td>'
        +'<td class="num">'+f2(p.cost)+'</td>'
        +'<td class="num">'+(p.delta>=0?'+':'')+f3(p.delta)+'</td>'
        +'<td class="num">'+m+'m</td></tr>';
    }
    h+='</table></div>';
  }

  h+='<h2>Risk</h2><div class="grid">';
  for(const a of d.risk.assetDelta){
    h+='<div class="card"><div class="k">'+esc(a.asset)+' exposure</div>'
      +'<div class="v">'+(a.delta>=0?'+':'')+f2(a.delta)+'</div>'
      +'<div class="sub">per 1% move · budget ±'+f2(a.budget)+'</div>'+meter(a.delta,a.budget)+'</div>';
  }
  h+='<div class="card"><div class="k">Combined</div><div class="v">'
    +(d.risk.combined>=0?'+':'')+f2(d.risk.combined)+'</div>'
    +'<div class="sub">correlation-adjusted · ±'+f2(d.risk.combinedBudget)+'</div>'
    +meter(d.risk.combined,d.risk.combinedBudget)+'</div>'
    +'<div class="card"><div class="k">Max loss</div><div class="v">'+f2(d.risk.maxLoss)+'</div>'
    +'<div class="sub">exact — a long binary cannot lose more than its premium</div></div></div>';

  if(d.risk.buckets.length){
    h+='<div class="scroll"><table><tr><th>Settling together</th><th class="num">Committed</th>'
      +'<th class="num">Budget</th><th></th></tr>';
    for(const b of d.risk.buckets){
      h+='<tr><td>'+esc(b.bucket)+'</td><td class="num">'+f2(b.cost)+'</td>'
        +'<td class="num">'+f2(b.budget)+'</td><td style="width:130px">'+meter(b.cost,b.budget)+'</td></tr>';
    }
    h+='</table></div>';
  }

  if(d.settled.count){
    h+='<h2>Settled</h2><div class="grid">'
      +'<div class="card"><div class="k">Positions</div><div class="v">'+d.settled.count+'</div></div>'
      +'<div class="card"><div class="k">Hit rate</div><div class="v">'+pct(d.settled.wins/d.settled.count)+'</div></div>'
      +'<div class="card"><div class="k">Return on stake</div><div class="v '
      +(d.settled.returnOnStake>=0?'pos':'neg')+'">'+pct(d.settled.returnOnStake)+'</div></div></div>'
      +'<p class="why">A low hit rate is not failure. Buying a leg at 0.20 that is worth 0.30 '
      +'should lose four times in five and still profit — return on stake is the number that matters.</p>';
  }

  h+='<h2>Why this allocation</h2>';
  if(!d.lastCycleDecisions.length) h+='<p class="empty">no decisions recorded yet</p>';
  else{
    h+='<div class="scroll"><table><tr><th>Market</th><th>Leg</th><th></th>'
      +'<th class="num">Fair</th><th class="num">Ask</th><th class="num">Edge</th>'
      +'<th>Bound by</th></tr>';
    const rows=[...d.lastCycleDecisions].sort((a,b)=>(b.action==='BUY')-(a.action==='BUY')||(b.edge??-9)-(a.edge??-9));
    for(const r of rows){
      h+='<tr><td>'+esc(r.label)+'</td><td>'+esc(r.leg)+'</td>'
        +'<td><span class="tag '+(r.action==='BUY'?'buy':'skip')+'">'+esc(r.action)+'</span></td>'
        +'<td class="num">'+f3(r.fair)+'</td>'
        +'<td class="num">'+(r.ask==null?'—':f3(r.ask))+'</td>'
        +'<td class="num">'+(r.edge==null?'—':(r.edge>=0?'+':'')+f3(r.edge))+'</td>'
        +'<td class="why">'+esc(r.binding)+'</td></tr>';
    }
    h+='</table></div>';
  }

  if(d.declineReasons.length){
    h+='<h2>What stops it trading</h2><div class="scroll"><table>'
      +'<tr><th class="num">Count</th><th>Reason</th></tr>';
    for(const r of d.declineReasons)
      h+='<tr><td class="num">'+r.n+'</td><td class="why">'+esc(r.reason)+'</td></tr>';
    h+='</table></div>';
  }

  h+='<footer>'+d.evaluations.toLocaleString()+' leg evaluations across '+d.cycles+' cycles. '
    +'Counts are cumulative — the venue lists 8 windows at a time.'
    +(d.mode==='SHADOW'?' <strong>Shadow mode: fills are simulated against real book depth; '
      +'settlement outcomes are real; no capital is at risk.</strong>':'')+'</footer>';
  app.innerHTML=h;
}

async function tick(){
  try{ render(await (await fetch('/api/state')).json()); }
  catch(e){ document.getElementById('app').innerHTML='<h1>Rivo</h1><p class="empty">'+e+'</p>'; }
}
tick(); setInterval(tick,5000);
</script></body></html>`;
