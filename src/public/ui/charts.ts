// Inline SVG charts. No dependencies, theme-aware, and readable at phone width.
//
// Every chart here answers one question a table cannot. The term structure shows
// that the eight live windows lean the SAME WAY at the same time, which is the
// entire argument for a portfolio layer and is invisible in a list of rows.

import { cssVar, esc, f2, f3 } from "./dom.js";

/** One leg of one window, as Rivo priced it against the book. */
export interface TermLeg {
  /** Rivo's probability for THIS leg. */
  fair: number;
  /** What the book charges to buy it, or null when nothing is offered. */
  ask: number | null;
}

export interface TermRow {
  asset: string;
  tenor: string;
  label: string;
  up: TermLeg | null;
  down: TermLeg | null;
}

/**
 * The term structure as a deviation plot: model minus book, both legs, one axis.
 *
 * The previous chart drew each window's UP leg as a dumbbell on an absolute
 * 0–100% scale. It was honest and it answered the wrong question. What the whole
 * portfolio argument rests on is not "what is this window worth" — a table says
 * that better — it is that the windows lean the SAME WAY AT THE SAME TIME. On an
 * absolute scale that is invisible: a 4h window sitting at 0.29 and a 1d window
 * at 0.99 are far apart on the page even when the model disagrees with the book
 * by the same amount in the same direction on both.
 *
 * So every leg is drawn as a deviation from a shared centre line. Left is the
 * book above the model; right is the book below it. Reading the sign off which
 * side of the line a mark sits on is faster than reading a signed number, and
 * the thing worth seeing becomes a shape: when four BTC windows all push right
 * at once, that is one bet expressed four times, and it is a column.
 *
 * Both legs are shown because both trade. The DOWN leg is not the UP leg's
 * complement once a spread is involved, and on this venue it is often the
 * better-supplied side — drawing only UP hid half the venue.
 */
export function termChart(rows: TermRow[]): string {
  if (rows.length === 0) return `<p class="empty">no live windows</p>`;

  const line = cssVar("--line"), line2 = cssVar("--line-2"), muted = cssVar("--muted");
  const ink = cssVar("--ink"), faint = cssVar("--faint");
  const pos = cssVar("--pos"), neg = cssVar("--neg");

  const dev = (l: TermLeg | null): number | null => (l && l.ask !== null ? l.fair - l.ask : null);

  // The scale is taken from the data and rounded up to a readable step, so a
  // quiet cycle is not flattened into noise and a violent one is not clipped.
  const magnitudes = rows.flatMap((r) => [dev(r.up), dev(r.down)]).flatMap((d) => (d === null ? [] : [Math.abs(d)]));
  const peak = magnitudes.length > 0 ? Math.max(...magnitudes) : 0.05;
  const scale = Math.max(0.05, Math.ceil(peak * 20) / 20);

  // Group by asset, keeping the venue's own tenor order rather than sorting by
  // value — the point is the shape of the curve across horizons.
  const assets = [...new Set(rows.map((r) => r.asset))];

  const L = 58, R = 116, ROW = 26, GROUP_HEAD = 30, TOP = 34;
  const W = 720;
  const plotW = W - L - R;
  const mid = L + plotW / 2;
  const H = TOP + assets.reduce((n, a) => n + GROUP_HEAD + rows.filter((r) => r.asset === a).length * ROW + 10, 0);
  const at = (d: number) => mid + Math.max(-1, Math.min(1, d / scale)) * (plotW / 2);

  let y = TOP;
  const body = assets
    .map((asset) => {
      const mine = rows.filter((r) => r.asset === asset);
      // "Leaning" counts legs the model prices meaningfully ABOVE the book — the
      // ones Rivo would want to buy. Three or more at once is the correlation
      // the delta budget exists to refuse.
      const leaning = mine.filter((r) => {
        const u = dev(r.up), d = dev(r.down);
        return (u !== null && u > 0.02) || (d !== null && d > 0.02);
      }).length;
      const summary =
        leaning >= 3
          ? `${leaning} of ${mine.length} windows lean the same way — one view, ${leaning} tenors`
          : `no consistent lean this cycle`;

      const head =
        `<text x="0" y="${y + 10}" fill="${ink}" font-size="11" font-weight="700" ` +
        `font-family="ui-monospace,monospace" letter-spacing="1">${esc(asset)}</text>` +
        `<text x="${L}" y="${y + 10}" fill="${leaning >= 3 ? ink : faint}" font-size="10.5">${esc(summary)}</text>` +
        `<line x1="0" y1="${y + 18}" x2="${W}" y2="${y + 18}" stroke="${line}" stroke-width="1"/>`;
      y += GROUP_HEAD;

      const legs = mine
        .map((r) => {
          const ry = y + ROW / 2;
          const u = dev(r.up), d = dev(r.down);
          const bar = (v: number | null, colour: string, top: number, height: number, opacity: string) => {
            if (v === null) return "";
            const xEnd = at(v);
            const x0 = Math.min(mid, xEnd), w = Math.abs(xEnd - mid);
            return `<rect x="${x0}" y="${ry + top}" width="${Math.max(1, w)}" height="${height}" fill="${colour}" opacity="${opacity}"/>`;
          };
          const fmt = (v: number | null) => (v === null ? "  —  " : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`);
          const out =
            `<text x="0" y="${ry + 4}" fill="${muted}" font-size="10.5" font-family="ui-monospace,monospace">${esc(r.tenor)}</text>` +
            `<line x1="${mid}" y1="${ry - 9}" x2="${mid}" y2="${ry + 9}" stroke="${line2}" stroke-width="1"/>` +
            bar(u, pos, -8, 7, "1") +
            bar(d, neg, 1, 7, ".55") +
            `<text x="${W}" y="${ry + 4}" fill="${muted}" font-size="10.5" text-anchor="end" ` +
            `font-family="ui-monospace,monospace">${fmt(u)} / ${fmt(d)}</text>`;
          y += ROW;
          return out;
        })
        .join("");

      y += 10;
      return head + legs;
    })
    .join("");

  const axis =
    `<text x="0" y="12" fill="${faint}" font-size="10.5">model minus book, per leg</text>` +
    `<text x="${mid}" y="12" fill="${faint}" font-size="10.5" text-anchor="middle">agrees</text>` +
    `<text x="${L}" y="12" fill="${faint}" font-size="10.5">−${scale.toFixed(2)}</text>` +
    `<text x="${W - R}" y="12" fill="${faint}" font-size="10.5" text-anchor="end">+${scale.toFixed(2)}</text>`;

  return (
    `<div class="scroll"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:520px" role="img" ` +
    `aria-label="Every live leg, drawn as Rivo's model minus the book's price, around a shared centre line">` +
    `${axis}${body}</svg></div>` +
    `<div class="note" style="margin-top:12px;font-size:13px">` +
    `<svg width="46" height="12" style="display:inline-block;vertical-align:-2px" aria-hidden="true">` +
    `<rect x="0" y="1" width="20" height="5" fill="${pos}"/>` +
    `<rect x="0" y="7" width="30" height="5" fill="${neg}" opacity=".55"/>` +
    `<line x1="0" y1="0" x2="0" y2="12" stroke="${line2}" stroke-width="1"/></svg> ` +
    `<b style="color:${pos}">UP</b> and <b style="color:${neg}">DOWN</b> for each window, as the distance ` +
    `from Rivo's model to the book. To the <b>right</b> the book is selling below Rivo's value; to the ` +
    `<b>left</b>, above it. The centre line is agreement. What to look for is a <b>column</b>: several ` +
    `windows of one asset pushing the same way at once is a single directional view, and it is charged ` +
    `once against that asset's delta budget rather than funded four times.` +
    `</div>`
  );
}

/** Predicted probability against realised frequency — the credibility panel. */
export function reliabilityChart(points: { p: number; freq: number; n: number }[]): string {
  if (points.length === 0) return `<p class="empty">no calibration data</p>`;
  const S = 260, P = 34;
  const x = (v: number) => P + v * (S - P - 10);
  const y = (v: number) => S - P - v * (S - P - 10);
  const line = cssVar("--line"), muted = cssVar("--muted"), accent = cssVar("--accent");
  const maxN = Math.max(...points.map((p) => p.n), 1);

  const grid = [0, 0.5, 1]
    .map(
      (v) =>
        `<line x1="${x(v)}" y1="${y(0)}" x2="${x(v)}" y2="${y(1)}" stroke="${line}"/>` +
        `<line x1="${x(0)}" y1="${y(v)}" x2="${x(1)}" y2="${y(v)}" stroke="${line}"/>` +
        `<text x="${x(v)}" y="${S - 12}" fill="${muted}" font-size="9.5" text-anchor="middle">${(v * 100).toFixed(0)}</text>` +
        `<text x="${P - 7}" y="${y(v) + 3}" fill="${muted}" font-size="9.5" text-anchor="end">${(v * 100).toFixed(0)}</text>`,
    )
    .join("");

  const dots = points
    .map(
      (p) =>
        `<circle cx="${x(p.p)}" cy="${y(p.freq)}" r="${(2.5 + 4 * Math.sqrt(p.n / maxN)).toFixed(1)}" ` +
        `fill="${accent}" opacity=".78"><title>predicted ${f3(p.p)} → realised ${f3(p.freq)} over ${p.n} forecasts</title></circle>`,
    )
    .join("");

  return (
    `<svg viewBox="0 0 ${S} ${S}" width="100%" style="max-width:300px" role="img" ` +
    `aria-label="Reliability diagram: predicted probability against realised frequency">` +
    `${grid}<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="${muted}" stroke-dasharray="3 3"/>${dots}` +
    `<text x="${x(0.5)}" y="${S - 1}" fill="${muted}" font-size="9.5" text-anchor="middle">predicted %</text></svg>`
  );
}

/** Equity through time, reconstructed from settled positions. */
export function equityChart(series: { t: number; equity: number }[], capital: number): string {
  if (series.length < 2) {
    return `<p class="empty">the equity curve appears once positions have settled</p>`;
  }
  const W = 640, H = 150, P = 42;
  const ts = series.map((s) => s.t);
  const vs = series.map((s) => s.equity);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const lo = Math.min(...vs, capital), hi = Math.max(...vs, capital);
  const pad = (hi - lo) * 0.12 || Math.max(1, capital * 0.02);
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - P - 12);
  const y = (v: number) => H - 24 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (H - 40);
  const line = cssVar("--line"), muted = cssVar("--muted");
  const last = vs[vs.length - 1]!;
  const c = last >= capital ? cssVar("--pos") : cssVar("--neg");

  const path = series.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.t).toFixed(1)},${y(s.equity).toFixed(1)}`).join("");
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Equity through time">` +
    `<line x1="${P}" y1="${y(capital)}" x2="${W - 12}" y2="${y(capital)}" stroke="${line}" stroke-dasharray="4 4"/>` +
    `<text x="${P - 6}" y="${y(capital) + 3}" fill="${muted}" font-size="10" text-anchor="end">${f2(capital)}</text>` +
    `<path d="${path}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>` +
    `<circle cx="${x(t1)}" cy="${y(last)}" r="3.5" fill="${c}"/>` +
    `<text x="${W - 12}" y="${y(last) - 8}" fill="${c}" font-size="11" text-anchor="end" ` +
    `font-family="ui-monospace,monospace">${f2(last)}</text></svg>`
  );
}

/** Signed exposure against a symmetric budget — the constraint users watch most. */
export function exposureBar(delta: number, cap: number, label: string): string {
  const W = 300, H = 40, M = 12;
  const mid = W / 2;
  const half = (W - 2 * M) / 2;
  const frac = cap > 0 ? Math.max(-1.15, Math.min(1.15, delta / cap)) : 0;
  const line = cssVar("--line"), muted = cssVar("--muted");
  const c = Math.abs(frac) >= 0.999 ? cssVar("--neg") : Math.abs(frac) >= 0.85 ? cssVar("--warn") : cssVar("--accent");
  const w = Math.abs(frac) * half;
  const x0 = frac >= 0 ? mid : mid - w;
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:320px" role="img" ` +
    `aria-label="${esc(label)} exposure ${f2(delta)} against a budget of ${f2(cap)}">` +
    `<rect x="${M}" y="14" width="${W - 2 * M}" height="12" rx="6" fill="${line}"/>` +
    `<rect x="${x0}" y="14" width="${Math.max(2, w)}" height="12" rx="6" fill="${c}"/>` +
    `<line x1="${mid}" y1="9" x2="${mid}" y2="31" stroke="${muted}" stroke-width="1"/>` +
    `<text x="${M}" y="38" fill="${muted}" font-size="9.5">−${f2(cap)}</text>` +
    `<text x="${W - M}" y="38" fill="${muted}" font-size="9.5" text-anchor="end">+${f2(cap)}</text>` +
    `<text x="${mid}" y="9" fill="${muted}" font-size="9.5" text-anchor="middle">flat</text></svg>`
  );
}
