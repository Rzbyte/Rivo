// Rendering for the public page. Hand-drawn SVG, no chart library: two charts do
// not justify a dependency, and a page that works from a file:// URL is a page
// anyone can open.

import { load, type Row, type Snapshot } from "./app.js";

const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => n.toFixed(3);
const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

interface Evidence {
  holdout: { n: number; auc: number; brier: number; brierCoin: number };
  sample: { forecasts: number; marketsUsed: number };
  reliability: { lo: number; hi: number; n: number; meanP: number; freq: number }[];
}

/**
 * The hero: model against book across the whole term structure.
 *
 * Eight windows, two underlyings, four tenors, on one axis. The point it makes
 * visually is the one a per-market view cannot: when the bars lean the same way
 * at the same time, they are one directional view expressed several times.
 */
function termChart(rows: Row[]): string {
  const quoted = rows.filter((r) => r.gap !== null);
  if (rows.length === 0) return `<p class="empty">no live windows right now — the venue rolls every 15 minutes</p>`;

  const rowH = 34;
  const padL = 92;
  const padR = 66;
  const top = 26;
  const W = 780;
  const H = top + rows.length * rowH + 20;
  const x = (p: number) => padL + p * (W - padL - padR);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rivo model probability against book price, by tenor">`;
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    s += `<line x1="${x(g)}" y1="${top - 10}" x2="${x(g)}" y2="${H - 18}" stroke="${css("--line")}" stroke-width="1"/>`;
    s += `<text x="${x(g)}" y="${H - 4}" fill="${css("--muted")}" font-size="10" text-anchor="middle" font-family="${css("--mono")}">${g.toFixed(2)}</text>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    s += `<text x="0" y="${y + 4}" fill="${css("--ink")}" font-size="12.5" font-family="${css("--mono")}">${esc(r.label)}</text>`;
    const mid = r.gap === null ? null : r.fair + r.gap;
    if (mid !== null) {
      const lo = Math.min(r.fair, mid);
      const hi = Math.max(r.fair, mid);
      const rich = mid > r.fair;
      s += `<rect x="${x(lo)}" y="${y - 7}" width="${Math.max(1, x(hi) - x(lo))}" height="14" rx="2" fill="${rich ? css("--neg") : css("--pos")}" opacity="0.2"/>`;
      s += `<circle cx="${x(mid)}" cy="${y}" r="4.5" fill="${css("--muted")}"/>`;
    }
    s += `<rect x="${x(r.fair) - 1.5}" y="${y - 10}" width="3" height="20" rx="1.5" fill="${css("--accent")}"/>`;
    if (r.gap !== null) {
      const strong = Math.abs(r.gap) > 0.03;
      s += `<text x="${W - padR + 10}" y="${y + 4}" fill="${strong ? css("--ink") : css("--muted")}" font-size="11.5" font-family="${css("--mono")}">${r.gap >= 0 ? "+" : ""}${f3(r.gap)}</text>`;
    } else {
      s += `<text x="${W - padR + 10}" y="${y + 4}" fill="${css("--muted")}" font-size="11.5" font-family="${css("--mono")}">no quote</text>`;
    }
  });
  s += "</svg>";

  const leaning = quoted.filter((r) => (r.gap ?? 0) > 0).length;
  const note =
    quoted.length === 0
      ? "Nothing is quoted on both sides right now — this venue is thin, and that is itself worth seeing."
      : `<strong>${leaning} of ${quoted.length}</strong> quoted windows are priced above the model. When they lean the same way at the same time they are one directional view expressed several times — which is exactly what a per-market view cannot show you.`;
  return `${s}<p class="note"><span style="color:${css("--accent")}">▮</span> Rivo's model &nbsp; <span style="color:${css("--muted")}">●</span> book &nbsp;·&nbsp; ${note}</p>`;
}

/** Reliability: predicted probability against realized frequency. */
function reliabilityChart(e: Evidence): string {
  const W = 420;
  const H = 210;
  const pad = 36;
  const sx = (p: number) => pad + p * (W - pad - 14);
  const sy = (p: number) => H - 28 - p * (H - 50);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="predicted probability against realized frequency">`;
  s += `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(1)}" stroke="${css("--muted")}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>`;
  for (const g of [0, 0.5, 1]) {
    s += `<text x="${sx(g)}" y="${H - 8}" fill="${css("--muted")}" font-size="10" text-anchor="middle" font-family="${css("--mono")}">${g}</text>`;
    s += `<text x="${pad - 8}" y="${sy(g) + 3}" fill="${css("--muted")}" font-size="10" text-anchor="end" font-family="${css("--mono")}">${g}</text>`;
  }
  const maxN = Math.max(...e.reliability.map((b) => b.n));
  let path = "";
  e.reliability.forEach((b, i) => {
    const r = 3 + 5 * Math.sqrt(b.n / maxN);
    s += `<circle cx="${sx(b.meanP)}" cy="${sy(b.freq)}" r="${r.toFixed(1)}" fill="${css("--accent")}" opacity="0.75"/>`;
    path += `${i ? "L" : "M"}${sx(b.meanP).toFixed(1)} ${sy(b.freq).toFixed(1)} `;
  });
  s += `<path d="${path}" fill="none" stroke="${css("--accent")}" stroke-width="1.3" opacity="0.5"/></svg>`;
  return s;
}

function render(snap: Snapshot, ev: Evidence | null): void {
  const app = document.getElementById("app")!;
  const t = new Date(snap.at * 1000).toISOString().replace("T", " ").slice(0, 19);

  let h = `<header>
    <h1>Rivo</h1>
    <span class="sub">What every DreamDEX Event Contract is worth, right now</span>
  </header>
  <p class="lede">Each contract asks one question: does BTC or ETH close at or above the price it opened at,
  over a fixed window. Rivo prices all eight live windows against their own resolved opening references and
  the underlying's measured volatility — then shows you what the order book is charging instead.
  <strong>No wallet, no sign-in, nothing to install.</strong></p>`;

  const spots = Object.entries(snap.spot).filter(([, v]) => v > 0);
  h += `<div class="strip">`;
  for (const [a, v] of spots) {
    h += `<span><b>${esc(a)}</b> ${f2(v)} <i>σ ${(100 * (snap.sigmaPerMin[a] ?? 0)).toFixed(3)}%/min</i></span>`;
  }
  h += `<span class="right">${t} UTC · testnet</span></div>`;

  h += `<div class="panel hero">${termChart(snap.rows)}</div>`;

  if (snap.rows.length > 0) {
    h += `<h2>Every live window</h2><div class="panel scroll"><table>
      <tr><th>Window</th><th class="num">Rivo</th><th class="num">Book bid</th><th class="num">Book ask</th>
      <th class="num">Gap</th><th class="num">Spot vs open</th><th class="num">Settles</th></tr>`;
    for (const r of snap.rows) {
      const money = 100 * Math.log(r.spot / r.reference);
      h += `<tr><td>${esc(r.label)}</td>
        <td class="num strong">${f3(r.fair)}</td>
        <td class="num">${r.bid === null ? "—" : f3(r.bid)}</td>
        <td class="num">${r.ask === null ? "—" : f3(r.ask)}</td>
        <td class="num ${r.gap === null ? "" : r.gap > 0 ? "neg" : "pos"}">${r.gap === null ? "—" : (r.gap >= 0 ? "+" : "") + f3(r.gap)}</td>
        <td class="num">${money >= 0 ? "+" : ""}${money.toFixed(3)}%</td>
        <td class="num">${Math.max(0, Math.round(r.minutesLeft))}m</td></tr>`;
    }
    h += `</table></div>
    <p class="note"><b>Gap</b> is book minus model. Positive means the book is charging more than Rivo thinks
    the outcome is worth. <b>Spot vs open</b> is how far the underlying currently sits from the level that
    window settles against — the single input that moves the price most.</p>`;
  }

  if (snap.unpriced.length > 0) {
    h += `<p class="note">Not priced: ${snap.unpriced.map((u) => `${esc(u.label)} <i>(${esc(u.reason)})</i>`).join(" · ")}</p>`;
  }

  if (ev) {
    const skill = 1 - ev.holdout.brier / ev.holdout.brierCoin;
    h += `<h2>Why you should believe that number</h2>
    <div class="two">
      <div class="panel">${reliabilityChart(ev)}
        <p class="note">Dashed line is perfect calibration; dot size is sample count.</p></div>
      <div class="panel evidence">
        <div class="stat"><span>${f3(ev.holdout.auc)}</span><i>AUC, held out</i></div>
        <div class="stat"><span>${f3(ev.holdout.brier)}</span><i>Brier, against ${f3(ev.holdout.brierCoin)} for always-0.5</i></div>
        <div class="stat"><span>${pct(skill)}</span><i>skill over a coin flip</i></div>
        <div class="stat"><span>${ev.sample.forecasts.toLocaleString()}</span><i>forecasts scored, across ${ev.sample.marketsUsed.toLocaleString()} settled windows</i></div>
        <p class="note">Every forecast was made from information available at the time and scored against
        what settlement actually decided. The correction was fitted on the earlier windows and tested on the
        later ones, so none of this is measured on the data it was tuned to.</p>
      </div>
    </div>`;
  }

  h += `<h2>What this is</h2>
  <p class="lede">Rivo is the portfolio and evidence layer for DreamDEX Event Contracts. This page is its
  pricing engine, made public. The same code also runs an autonomous portfolio manager that allocates
  capital across these windows under portfolio-wide risk limits — but you do not need any of that to use
  the number above.</p>
  <p class="note"><strong>An honest note.</strong> Being able to price these accurately is not the same as
  being able to profit from trading them. We measured that too, and taking liquidity against this venue's
  flow lost money at every threshold we tested. That result is in the repository with its method, alongside
  everything else. Prices, not promises.</p>
  <footer>
    <a href="https://github.com/Rzbyte/Rivo">github.com/Rzbyte/Rivo</a> ·
    built on the <a href="https://github.com/somnia-chain/dreamdex-bot-kit">DreamDEX Bot Kit</a> ·
    Somnia × DreamDEX Event Contracts Hackathon
  </footer>`;

  app.innerHTML = h;
}

async function tick(): Promise<void> {
  const app = document.getElementById("app")!;
  try {
    const [snap, ev] = await Promise.all([
      load(),
      fetch("calibration.json")
        .then((r) => (r.ok ? (r.json() as Promise<Evidence>) : null))
        .catch(() => null),
    ]);
    render(snap, ev);
  } catch (e) {
    app.innerHTML = `<header><h1>Rivo</h1></header><p class="empty">Could not reach the venue: ${esc(
      e instanceof Error ? e.message : String(e),
    )}</p>`;
  }
}

void tick();
setInterval(() => void tick(), 20_000);
