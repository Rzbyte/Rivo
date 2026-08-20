// Inline SVG charts. No dependencies, theme-aware, and readable at phone width.
//
// Every chart here answers one question a table cannot. The term structure shows
// that the eight live windows lean the SAME WAY at the same time, which is the
// entire argument for a portfolio layer and is invisible in a list of rows.

import { cssVar, esc, f2, f3 } from "./dom.js";

interface TermRow {
  label: string;
  fair: number;
  ask: number | null;
  bid: number | null;
}

/**
 * Model against book for every live leg.
 *
 * Model is a horizontal tick, the book a filled bar between bid and ask, so the
 * eye reads the GAP rather than two absolute levels — the gap is the tradeable
 * quantity and the levels are not.
 */
export function termChart(rows: TermRow[]): string {
  if (rows.length === 0) return `<p class="empty">no live windows</p>`;
  const W = 720, H = 34 + rows.length * 38, L = 108, R = 40;
  const x = (p: number) => L + p * (W - L - R);
  const line = cssVar("--line"), muted = cssVar("--muted"), ink = cssVar("--ink");
  const accent = cssVar("--accent"), pos = cssVar("--pos"), neg = cssVar("--neg");

  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (p) =>
        `<line x1="${x(p)}" y1="26" x2="${x(p)}" y2="${H - 8}" stroke="${line}" stroke-width="1"/>` +
        `<text x="${x(p)}" y="18" fill="${muted}" font-size="10.5" text-anchor="middle">${(p * 100).toFixed(0)}%</text>`,
    )
    .join("");

  const bars = rows
    .map((r, i) => {
      const y = 38 + i * 38;
      const lo = r.bid ?? r.ask ?? r.fair;
      const hi = r.ask ?? r.bid ?? r.fair;
      const gap = r.ask === null ? null : r.fair - r.ask;
      const c = gap === null ? muted : gap > 0.01 ? pos : gap < -0.01 ? neg : muted;
      const bw = Math.max(2, x(hi) - x(lo));
      return (
        `<text x="0" y="${y + 4}" fill="${ink}" font-size="12" font-weight="560">${esc(r.label)}</text>` +
        `<rect x="${x(lo)}" y="${y - 7}" width="${bw}" height="14" rx="3" fill="${c}" opacity=".2"/>` +
        `<line x1="${x(r.fair)}" y1="${y - 11}" x2="${x(r.fair)}" y2="${y + 11}" stroke="${accent}" stroke-width="2.5" stroke-linecap="round"/>` +
        `<text x="${W - R + 6}" y="${y + 4}" fill="${c}" font-size="11" font-family="ui-monospace,monospace">` +
        `${gap === null ? "—" : (gap >= 0 ? "+" : "−") + Math.abs(gap).toFixed(3)}</text>`
      );
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Rivo fair value against the order book for every live window">` +
    `${ticks}${bars}</svg>` +
    `<p class="note" style="margin-top:10px">` +
    `<span style="color:var(--accent)">▎</span> Rivo's model &nbsp;·&nbsp; shaded band = bid–ask &nbsp;·&nbsp; ` +
    `right column = model − ask, the edge before constraints.</p>`
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
