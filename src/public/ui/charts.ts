// Inline SVG charts. No dependencies, theme-aware, and readable at phone width.
//
// Every chart here answers one question a table cannot. The term structure shows
// that the eight live windows lean the SAME WAY at the same time, which is the
// entire argument for a portfolio layer and is invisible in a list of rows.

import { cssVar, esc, f2, f3 } from "./dom.js";

interface TermRow {
  label: string;
  /** Rivo's probability that this window closes above its opening price. */
  fair: number;
  /** What the book charges to buy that outcome. */
  ask: number | null;
  /** What the book pays to sell it. */
  bid: number | null;
}

/**
 * Rivo's model against the book, one row per live window.
 *
 * Drawn as a dumbbell — a filled dot for the model, a hollow ring for the ask,
 * and a thick line between them — because the quantity that matters is the GAP,
 * and a gap is a distance. An earlier version drew the two as separate ticks
 * with a faint band between, and it was unreadable: the band collapsed to two
 * invisible pixels whenever the book had no bid (which is most of the time on
 * this venue), the legend described a band that was not there, and the edge
 * column was clipped by the viewBox. None of that was a styling problem. The
 * chart was asking the reader to compute the story instead of showing it.
 */
export function termChart(rows: TermRow[]): string {
  if (rows.length === 0) return `<p class="empty">no live windows</p>`;

  const L = 92, R = 74, ROW = 34, TOP = 46;
  const W = 720, H = TOP + rows.length * ROW + 16;
  const x = (p: number) => L + Math.max(0, Math.min(1, p)) * (W - L - R);
  const line = cssVar("--line"), muted = cssVar("--muted"), ink = cssVar("--ink");
  const accent = cssVar("--accent"), pos = cssVar("--pos"), neg = cssVar("--neg"), panel = cssVar("--panel");

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (p) =>
        `<line x1="${x(p)}" y1="${TOP - 12}" x2="${x(p)}" y2="${H - 12}" stroke="${line}" stroke-width="1"/>` +
        `<text x="${x(p)}" y="${TOP - 20}" fill="${muted}" font-size="10.5" text-anchor="middle">${(p * 100).toFixed(0)}%</text>`,
    )
    .join("");

  const bars = rows
    .map((r, i) => {
      const y = TOP + 6 + i * ROW;
      const xf = x(r.fair);

      if (r.ask === null) {
        return (
          `<text x="0" y="${y + 4}" fill="${ink}" font-size="12.5" font-weight="600">${esc(r.label)}</text>` +
          `<circle cx="${xf}" cy="${y}" r="5" fill="${accent}"/>` +
          `<text x="${W - R + 8}" y="${y + 4}" fill="${muted}" font-size="10.5">no offer</text>`
        );
      }

      const edge = r.fair - r.ask;          // positive: the book is selling it below what Rivo thinks it is worth
      const c = edge > 0.005 ? pos : edge < -0.005 ? neg : muted;
      const xa = x(r.ask);
      const [lo, hi] = xf < xa ? [xf, xa] : [xa, xf];

      return (
        `<text x="0" y="${y + 4}" fill="${ink}" font-size="12.5" font-weight="600">${esc(r.label)}</text>` +
        // The gap, as a physical distance.
        `<line x1="${lo}" y1="${y}" x2="${hi}" y2="${y}" stroke="${c}" stroke-width="4" stroke-linecap="round" opacity=".45"/>` +
        // Where the book will sell it to you: a ring, because it is a price you can choose to pay.
        `<circle cx="${xa}" cy="${y}" r="4.5" fill="${panel}" stroke="${c}" stroke-width="2"/>` +
        // Rivo's own number: filled, because it is not negotiable.
        `<circle cx="${xf}" cy="${y}" r="5" fill="${accent}"/>` +
        `<text x="${W - R + 8}" y="${y + 4}" fill="${c}" font-size="11.5" font-family="ui-monospace,monospace">` +
        `${edge >= 0 ? "+" : "\u2212"}${Math.abs(edge * 100).toFixed(1)}</text>`
      );
    })
    .join("");

  return (
    `<div class="scroll"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:520px" role="img" ` +
    `aria-label="Rivo's model against the order book for every live window">` +
    `<text x="0" y="14" fill="${muted}" font-size="10.5">chance this window closes ABOVE its opening price</text>` +
    `${grid}${bars}</svg></div>` +
    `<div class="note" style="margin-top:12px;font-size:13px">` +
    `<svg width="52" height="12" style="display:inline-block;vertical-align:-2px" aria-hidden="true">` +
    `<line x1="8" y1="6" x2="44" y2="6" stroke="${muted}" stroke-width="4" stroke-linecap="round" opacity=".45"/>` +
    `<circle cx="8" cy="6" r="5" fill="${accent}"/>` +
    `<circle cx="44" cy="6" r="4.5" fill="${panel}" stroke="${muted}" stroke-width="2"/></svg> ` +
    `<b>Filled dot</b> is Rivo's model. <b>Ring</b> is what the book charges. The line between them is the ` +
    `edge, in percentage points, shown on the right — <span style="color:${pos}">green</span> when the book ` +
    `is selling below Rivo's value, <span style="color:${neg}">red</span> when above.` +
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
