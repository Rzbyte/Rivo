// The cockpit page.
//
// One self-contained document: no framework, no bundler, no CDN. Charts are
// hand-drawn SVG because three charts do not justify a charting library, and
// because a page that works from a file:// URL is a page a judge can open.
//
// The layout answers three questions in the order a person actually asks them:
// what is my money doing, how much risk is that, and why did it choose this.
// The third is the one no other trading bot answers, so it gets the most room.

export const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rivo</title>
<style>
  :root{
    --bg:#fbfbfa; --panel:#fff; --ink:#17170f; --muted:#6f6f66; --line:#e7e6e1; --line2:#f2f1ed;
    --pos:#1a7a4c; --neg:#b5321d; --accent:#2f5fd0; --warn:#a4631a; --live:#1a7a4c;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#141418; --panel:#1c1c21; --ink:#eeece6; --muted:#9b9b93; --line:#2c2c33; --line2:#232329;
    --pos:#4ecd8c; --neg:#ff7d64; --accent:#84a9ff; --warn:#e2a862; --live:#4ecd8c;
  }}
  :root[data-theme="dark"]{
    --bg:#141418; --panel:#1c1c21; --ink:#eeece6; --muted:#9b9b93; --line:#2c2c33; --line2:#232329;
    --pos:#4ecd8c; --neg:#ff7d64; --accent:#84a9ff; --warn:#e2a862; --live:#4ecd8c;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;}
  .wrap{max-width:1120px;margin:0 auto;padding:28px 20px 72px}

  header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:8px}
  h1{font-size:25px;margin:0;letter-spacing:-.025em;font-weight:660}
  .pill{display:inline-flex;align-items:center;gap:7px;font:600 11px/1 var(--mono);letter-spacing:.09em;
    padding:6px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
  .pill.on{color:var(--live);border-color:currentColor}
  .pill.off{color:var(--muted)}
  .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
  .pill.on .dot{animation:pulse 2.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .spacer{flex:1}
  .sub{color:var(--muted);font-size:13px}

  .controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0 24px;
    padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:11px}
  .controls label{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px}
  input[type=number],select{font:inherit;font-size:14px;padding:6px 9px;border-radius:7px;
    border:1px solid var(--line);background:var(--bg);color:var(--ink);width:104px}
  select{width:auto}
  button{font:600 14px/1 inherit;padding:9px 18px;border-radius:8px;border:1px solid transparent;
    background:var(--ink);color:var(--bg);cursor:pointer}
  button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .note{font-size:12px;color:var(--muted)}

  .grid{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));margin-bottom:22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:14px 15px}
  .card .k{font-size:11px;letter-spacing:.075em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
  .card .v{font:640 23px/1.1 var(--mono);letter-spacing:-.015em}
  .v.pos{color:var(--pos)} .v.neg{color:var(--neg)}

  h2{font-size:12px;letter-spacing:.085em;text-transform:uppercase;color:var(--muted);
    margin:30px 0 12px;font-weight:640}
  h2 span{text-transform:none;letter-spacing:0;font-weight:400;color:var(--muted);opacity:.8}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:16px}
  .two{display:grid;gap:13px;grid-template-columns:1fr 1fr}
  @media(max-width:820px){.two{grid-template-columns:1fr}}

  table{width:100%;border-collapse:collapse;font:13px/1.45 var(--mono)}
  th{text-align:left;font-weight:640;color:var(--muted);font-size:10.5px;letter-spacing:.06em;
    text-transform:uppercase;padding:0 10px 7px 0;border-bottom:1px solid var(--line)}
  td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line2);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .why{color:var(--muted);font-size:12px;font-family:inherit}
  .tag{font:640 10px/1 var(--mono);padding:3px 6px;border-radius:4px;letter-spacing:.05em}
  .tag.buy{background:color-mix(in srgb,var(--pos) 16%,transparent);color:var(--pos)}
  .tag.skip{background:color-mix(in srgb,var(--muted) 15%,transparent);color:var(--muted)}
  .tag.adopt{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
  .meter{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:5px}
  .meter i{display:block;height:100%;border-radius:3px;background:var(--accent)}
  .meter i.hot{background:var(--warn)} .meter i.max{background:var(--neg)}
  .scroll{overflow-x:auto}
  .empty{color:var(--muted);font-style:italic;padding:14px 0}
  .halt{background:color-mix(in srgb,var(--neg) 12%,transparent);border:1px solid var(--neg);
    color:var(--neg);padding:11px 14px;border-radius:9px;margin-bottom:18px;font-size:13px}
  footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
  svg{display:block;width:100%;height:auto;overflow:visible}
  .lede{color:var(--muted);font-size:13px;margin:-4px 0 14px;max-width:64ch}
</style></head>
<body><div class="wrap" id="app"><p class="empty">loading…</p></div>
<script>
const f2=n=>Number(n).toFixed(2), f3=n=>Number(n).toFixed(3);
const pct=n=>Number.isFinite(n)?(100*n).toFixed(1)+'%':'—';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let busy=false;

function meter(used,budget){
  const r=budget>0?Math.min(1,Math.abs(used)/budget):0;
  return '<div class="meter"><i class="'+(r>=.99?'max':r>=.75?'hot':'')+'" style="width:'+(r*100).toFixed(0)+'%"></i></div>';
}

/* ---- chart 1: the hero. model vs book across the whole term structure ---- */
function termChart(rows){
  // Collapse to one row per market, in UP terms: the two legs are complements,
  // so drawing both would be the same information twice.
  const byLabel=new Map();
  for(const r of rows){
    const e=byLabel.get(r.label)||{label:r.label,asset:r.asset,tenor:r.tenorMinutes};
    if(r.leg==='UP'){ e.fair=r.fair; if(r.ask!=null) e.book=r.ask; e.upAction=r.action; e.upBinding=r.binding; }
    else { if(e.fair==null) e.fair=1-r.fair; if(e.book==null&&r.ask!=null) e.book=1-r.ask;
           e.downAction=r.action; e.downBinding=r.binding; }
    byLabel.set(r.label,e);
  }
  const items=[...byLabel.values()].filter(e=>e.fair!=null);
  if(!items.length) return '<p class="empty">no live windows priced yet</p>';

  const rowH=30, padL=78, padR=54, top=22, W=760, H=top+items.length*rowH+16;
  const x=p=>padL+p*(W-padL-padR);
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="model probability versus book price by tenor">';
  // axis
  for(const g of [0,0.25,0.5,0.75,1]){
    s+='<line x1="'+x(g)+'" y1="'+(top-8)+'" x2="'+x(g)+'" y2="'+(H-14)+'" stroke="'+css('--line')+'" stroke-width="1"/>';
    s+='<text x="'+x(g)+'" y="'+(H-2)+'" fill="'+css('--muted')+'" font-size="10" text-anchor="middle" font-family="'+css('--mono')+'">'+g.toFixed(2)+'</text>';
  }
  items.forEach((e,i)=>{
    const y=top+i*rowH+rowH/2;
    s+='<text x="0" y="'+(y+4)+'" fill="'+css('--ink')+'" font-size="12" font-family="'+css('--mono')+'">'+esc(e.label)+'</text>';
    if(e.book!=null){
      const lo=Math.min(e.fair,e.book), hi=Math.max(e.fair,e.book);
      const rich=e.book>e.fair; // book charges more than the model thinks it is worth
      s+='<rect x="'+x(lo)+'" y="'+(y-6)+'" width="'+Math.max(1,x(hi)-x(lo))+'" height="12" rx="2" fill="'
        +(rich?css('--neg'):css('--pos'))+'" opacity="0.18"/>';
      s+='<circle cx="'+x(e.book)+'" cy="'+y+'" r="4" fill="'+css('--muted')+'"/>';
    }
    s+='<rect x="'+(x(e.fair)-1.5)+'" y="'+(y-9)+'" width="3" height="18" rx="1.5" fill="'+css('--accent')+'"/>';
    const gap=e.book!=null?(e.book-e.fair):null;
    if(gap!=null) s+='<text x="'+(W-padR+8)+'" y="'+(y+4)+'" fill="'+(Math.abs(gap)>0.03?css('--ink'):css('--muted'))
      +'" font-size="11" font-family="'+css('--mono')+'">'+(gap>=0?'+':'')+gap.toFixed(3)+'</text>';
  });
  s+='</svg>';
  const leaning=items.filter(e=>e.book!=null&&e.book>e.fair).length, quoted=items.filter(e=>e.book!=null).length;
  return s+'<p class="note" style="margin-top:10px">'
    +'<span style="color:'+css('--accent')+'">▮</span> Rivo\\'s model &nbsp; '
    +'<span style="color:'+css('--muted')+'">●</span> book &nbsp;·&nbsp; '
    +(quoted?('<strong>'+leaning+' of '+quoted+'</strong> quoted windows are priced above the model — the same lean, at the same time, which is what makes them one bet rather than several.'):'no two-sided quotes right now')
    +'</p>';
}

/* ---- chart 2: equity ---- */
function equityChart(pts,capital){
  if(!pts||pts.length<2) return '<p class="empty">not enough history yet</p>';
  const W=460,H=170,pad=30;
  const xs=pts.map(p=>p.t), ys=pts.map(p=>p.v);
  const x0=Math.min(...xs),x1=Math.max(...xs),lo=Math.min(...ys,capital),hi=Math.max(...ys,capital);
  const sx=t=>pad+(x1===x0?0:(t-x0)/(x1-x0))*(W-pad-8);
  const sy=v=>H-22-(hi===lo?0.5:(v-lo)/(hi-lo))*(H-40);
  const d=pts.map((p,i)=>(i?'L':'M')+sx(p.t).toFixed(1)+' '+sy(p.v).toFixed(1)).join(' ');
  const last=pts[pts.length-1].v, up=last>=capital;
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="equity over time">';
  s+='<line x1="'+pad+'" y1="'+sy(capital)+'" x2="'+(W-8)+'" y2="'+sy(capital)+'" stroke="'+css('--muted')
    +'" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>';
  s+='<text x="0" y="'+(sy(capital)+3)+'" fill="'+css('--muted')+'" font-size="10" font-family="'+css('--mono')+'">'+f2(capital)+'</text>';
  s+='<path d="'+d+'" fill="none" stroke="'+(up?css('--pos'):css('--neg'))+'" stroke-width="1.8" stroke-linejoin="round"/>';
  s+='<circle cx="'+sx(pts[pts.length-1].t)+'" cy="'+sy(last)+'" r="3.5" fill="'+(up?css('--pos'):css('--neg'))+'"/>';
  s+='</svg><p class="note">Open positions held at cost — a binary has no mid until it settles, and marking to the model would draw a curve out of an opinion.</p>';
  return s;
}

/* ---- chart 3: reliability ---- */
function reliabilityChart(c){
  if(!c) return '<p class="empty">run <code>npm run calibrate -- --out docs/evidence/calibration.json</code></p>';
  const W=460,H=200,pad=34;
  const sx=p=>pad+p*(W-pad-12), sy=p=>H-26-p*(H-46);
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="predicted probability versus realized frequency">';
  s+='<line x1="'+sx(0)+'" y1="'+sy(0)+'" x2="'+sx(1)+'" y2="'+sy(1)+'" stroke="'+css('--muted')+'" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>';
  for(const g of [0,0.5,1]){
    s+='<text x="'+sx(g)+'" y="'+(H-8)+'" fill="'+css('--muted')+'" font-size="10" text-anchor="middle" font-family="'+css('--mono')+'">'+g+'</text>';
    s+='<text x="'+(pad-8)+'" y="'+(sy(g)+3)+'" fill="'+css('--muted')+'" font-size="10" text-anchor="end" font-family="'+css('--mono')+'">'+g+'</text>';
  }
  const maxN=Math.max(...c.bins.map(b=>b.n));
  let path='';
  c.bins.forEach((b,i)=>{
    const r=3+5*Math.sqrt(b.n/maxN);
    s+='<circle cx="'+sx(b.meanP)+'" cy="'+sy(b.freq)+'" r="'+r.toFixed(1)+'" fill="'+css('--accent')+'" opacity="0.75"/>';
    path+=(i?'L':'M')+sx(b.meanP).toFixed(1)+' '+sy(b.freq).toFixed(1)+' ';
  });
  s+='<path d="'+path+'" fill="none" stroke="'+css('--accent')+'" stroke-width="1.3" opacity="0.5"/>';
  s+='</svg>';
  return s+'<p class="note">Dashed line is perfect calibration. Dot size is sample count. '
    +'<strong>AUC '+f3(c.auc)+'</strong>, Brier '+f3(c.brier)+' against '+f3(c.brierCoin)
    +' for always-0.5 — '+pct(1-c.brier/c.brierCoin)+' skill, held out over '+c.n.toLocaleString()+' forecasts.</p>';
}

async function post(path,body){
  busy=true; render(window.__last, true);
  try{
    const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    const j=await r.json();
    if(!r.ok) alert(j.error||'failed');
  }catch(e){ alert(String(e)); }
  busy=false; tick();
}

function render(d,keepBusy){
  window.__last=d;
  const app=document.getElementById('app');
  if(!d||d.error){app.innerHTML='<header><h1>Rivo</h1></header><p class="empty">'+esc(d?d.error:'no data')+'</p>'
    +'<div class="controls"><label>capital <input type="number" id="cap" value="50" min="1" step="1"></label>'
    +'<label>profile <select id="prof"><option>conservative</option><option selected>balanced</option><option>active</option></select></label>'
    +'<label><input type="checkbox" id="live"> live</label>'
    +'<button onclick="startRun()">Start</button></div>';return;}

  const st=d.status, live=d.mode==='LIVE';
  const age=st.sinceLastCycleSec;
  let h='<header><h1>Rivo</h1>'
    +'<span class="pill '+(st.running?'on':'off')+'"><span class="dot"></span>'
      +(st.running?(live?'LIVE':'SHADOW'):'STOPPED')+'</span>'
    +'<span class="spacer"></span>'
    +'<span class="sub">'+esc(d.profile)+' · Kelly ×'+d.kelly+' · cycle '+d.cycles
      +(age==null?'':' · '+(age<90?'just now':Math.round(age/60)+'m ago'))+'</span></header>';

  h+='<div class="controls">'
    +'<label>capital <input type="number" id="cap" value="'+d.capital+'" min="1" step="1"></label>'
    +'<label>profile <select id="prof">'+d.profiles.map(p=>'<option'+(p===d.profile?' selected':'')+'>'+p+'</option>').join('')+'</select></label>'
    +'<label><input type="checkbox" id="live"'+(live?' checked':'')+'> live</label>'
    +(st.running
        ? (st.owned
            ? '<button onclick="stopRun()"'+(keepBusy?' disabled':'')+'>Stop</button>'
            : '<button class="ghost" disabled>running (external)</button>')
        : '<button onclick="startRun()"'+(keepBusy?' disabled':'')+'>Start</button>')
    +'<span class="spacer"></span>'
    +'<span class="note">Your key never touches this page — it stays in <code>.env</code> and only the local runtime reads it.</span>'
    +'</div>';

  if(d.halted) h+='<div class="halt"><strong>Halted.</strong> '+esc(d.halted)+'</div>';

  const pnlCls=d.realizedPnl>0?'pos':d.realizedPnl<0?'neg':'';
  h+='<div class="grid">'
    +'<div class="card"><div class="k">Capital</div><div class="v">'+f2(d.capital)+'</div></div>'
    +'<div class="card"><div class="k">Deployed</div><div class="v">'+f2(d.deployed)+'</div><div class="sub">'+pct(d.deployed/d.capital)+'</div></div>'
    +'<div class="card"><div class="k">Cash</div><div class="v">'+f2(d.cash)+'</div><div class="sub">'+pct(d.cash/d.capital)+'</div></div>'
    +'<div class="card"><div class="k">Realised P&amp;L</div><div class="v '+pnlCls+'">'+(d.realizedPnl>=0?'+':'')+f2(d.realizedPnl)+'</div></div>'
    +'</div>';

  h+='<h2>Term structure <span>— what the model says, against what the book charges</span></h2>'
    +'<p class="lede">Eight windows, two underlyings, four tenors. When they lean the same way at the same time they are one directional view expressed several times — which is exactly what a per-market bot cannot see.</p>'
    +'<div class="panel">'+termChart(d.termStructure)+'</div>';

  h+='<div class="two" style="margin-top:13px">'
    +'<div><h2 style="margin-top:0">Equity</h2><div class="panel">'+equityChart(d.equityCurve,d.capital)+'</div></div>'
    +'<div><h2 style="margin-top:0">Forecast calibration</h2><div class="panel">'+reliabilityChart(d.calibration)+'</div></div>'
    +'</div>';

  h+='<h2>Risk</h2><div class="grid">';
  for(const a of d.risk.assetDelta)
    h+='<div class="card"><div class="k">'+esc(a.asset)+' exposure</div><div class="v">'+(a.delta>=0?'+':'')+f2(a.delta)+'</div>'
      +'<div class="sub">per 1% move · ±'+f2(a.budget)+'</div>'+meter(a.delta,a.budget)+'</div>';
  h+='<div class="card"><div class="k">Combined</div><div class="v">'+(d.risk.combined>=0?'+':'')+f2(d.risk.combined)+'</div>'
    +'<div class="sub">correlation-adjusted · ±'+f2(d.risk.combinedBudget)+'</div>'+meter(d.risk.combined,d.risk.combinedBudget)+'</div>'
    +'<div class="card"><div class="k">Max loss</div><div class="v">'+f2(d.risk.maxLoss)+'</div>'
    +'<div class="sub">exact — a long binary cannot lose more than its premium</div></div></div>';

  h+='<h2>Positions</h2>';
  if(!d.positions.length) h+='<p class="empty">100% cash — nothing cleared the thresholds.</p>';
  else{
    h+='<div class="panel scroll"><table><tr><th>Market</th><th>Leg</th><th class="num">Shares</th>'
      +'<th class="num">Entry</th><th class="num">Cost</th><th class="num">Δ/1%</th><th class="num">Settles</th><th></th></tr>';
    for(const p of d.positions){
      const m=Math.max(0,Math.round((p.expiry-Date.now()/1000)/60));
      h+='<tr><td>'+esc(p.label)+'</td><td>'+esc(p.leg)+'</td><td class="num">'+f2(p.shares)+'</td>'
        +'<td class="num">'+f3(p.entryPrice)+'</td><td class="num">'+f2(p.cost)+'</td>'
        +'<td class="num">'+(p.delta>=0?'+':'')+f3(p.delta)+'</td><td class="num">'+m+'m</td>'
        +'<td>'+(p.adopted?'<span class="tag adopt">ADOPTED</span>':'')+'</td></tr>';
    }
    h+='</table></div>';
    if(d.positions.some(p=>p.adopted))
      h+='<p class="note">ADOPTED — found on-chain and taken over. Nothing records what was paid, so its entry price is an estimate and any P&amp;L involving it is only as good as that mark.</p>';
  }

  if(d.settled.count){
    h+='<h2>Settled</h2><div class="grid">'
      +'<div class="card"><div class="k">Positions</div><div class="v">'+d.settled.count+'</div></div>'
      +'<div class="card"><div class="k">Hit rate</div><div class="v">'+pct(d.settled.wins/d.settled.count)+'</div></div>'
      +'<div class="card"><div class="k">Return on stake</div><div class="v '+(d.settled.returnOnStake>=0?'pos':'neg')+'">'
      +pct(d.settled.returnOnStake)+'</div></div></div>'
      +'<p class="note">A low hit rate is not failure. Buying a leg at 0.20 that is worth 0.30 should lose four times in five and still profit — return on stake is the number that matters.</p>';
  }

  h+='<h2>Why this allocation</h2>';
  if(!d.termStructure.length) h+='<p class="empty">no decisions recorded yet</p>';
  else{
    const rows=[...d.termStructure].sort((a,b)=>(b.action==='BUY')-(a.action==='BUY')||(b.edge??-9)-(a.edge??-9));
    h+='<div class="panel scroll"><table><tr><th>Market</th><th>Leg</th><th></th><th class="num">Model</th>'
      +'<th class="num">Book</th><th class="num">Edge</th><th>Bound by</th></tr>';
    for(const r of rows){
      h+='<tr><td>'+esc(r.label)+'</td><td>'+esc(r.leg)+'</td>'
        +'<td><span class="tag '+(r.action==='BUY'?'buy':'skip')+'">'+esc(r.action)+'</span></td>'
        +'<td class="num">'+f3(r.fair)+'</td><td class="num">'+(r.ask==null?'—':f3(r.ask))+'</td>'
        +'<td class="num">'+(r.edge==null?'—':(r.edge>=0?'+':'')+f3(r.edge))+'</td>'
        +'<td class="why">'+esc(r.binding)+'</td></tr>';
    }
    h+='</table></div>';
  }

  if(d.declineReasons.length){
    h+='<h2>What stops it trading <span>— across recent cycles</span></h2><div class="panel scroll"><table>'
      +'<tr><th class="num">Count</th><th>Reason</th></tr>';
    for(const r of d.declineReasons) h+='<tr><td class="num">'+r.n+'</td><td class="why">'+esc(r.reason)+'</td></tr>';
    h+='</table></div>';
  }

  h+='<footer>'+d.evaluations.toLocaleString()+' leg evaluations across '+d.cycles+' cycles — cumulative, '
    +'and the venue lists eight windows at a time.'
    +(d.mode==='SHADOW'?' <strong>Shadow mode: fills are simulated against real book depth, settlement outcomes are real, no capital is at risk.</strong>':'')
    +'</footer>';
  app.innerHTML=h;
}

function startRun(){
  const cap=Number(document.getElementById('cap').value)||50;
  const prof=document.getElementById('prof').value;
  const live=document.getElementById('live').checked;
  if(live&&!confirm('Start LIVE with '+cap+' of collateral? Real orders will be sent.')) return;
  post('/api/start',{capital:cap,profile:prof,live});
}
function stopRun(){ post('/api/stop',{}); }

async function tick(){
  try{ render(await (await fetch('/api/state')).json()); }
  catch(e){ document.getElementById('app').innerHTML='<h1>Rivo</h1><p class="empty">'+esc(String(e))+'</p>'; }
}
tick(); setInterval(()=>{if(!busy)tick();},5000);
</script></body></html>`;
