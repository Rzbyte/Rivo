// Rendering helpers.
//
// The page builds HTML strings and assigns them, rather than reaching for a
// framework. At this size that is not a compromise: the whole app is a few
// screens over a state object that changes once a cycle, and a bundle small
// enough to inline is worth more here than a diffing algorithm — it is what lets
// the entire product ship as one file a judge can open with no server.
//
// `esc` is applied to everything that came from the network. Market ids, oracle
// values and error strings all reach the DOM, and the venue is a public API.

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const f2 = (n: number): string => n.toFixed(2);
export const f3 = (n: number): string => n.toFixed(3);
export const pct = (n: number, d = 1): string => `${(100 * n).toFixed(d)}%`;
export const signed = (n: number, d = 2): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;
export const cls = (n: number): string => (n > 0 ? "pos" : n < 0 ? "neg" : "mut");

/** Wallet address as a person reads it. */
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Clock time, for feed rows. */
export const clock = (unix: number): string =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function relTime(unix: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - unix);
  if (d < 60) return `${Math.round(d)}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

/** Minutes to a compact horizon label. */
export function horizon(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

/** A usage bar that changes colour as it approaches and passes its limit. */
export function meter(used: number, cap: number): string {
  if (!(cap > 0)) return "";
  const frac = Math.abs(used) / cap;
  const k = frac >= 0.999 ? "over" : frac >= 0.85 ? "full" : "";
  return `<div class="meter ${k}"><i style="width:${Math.min(100, frac * 100).toFixed(1)}%"></i></div>`;
}

/** Read a CSS custom property, so SVG picks up the active theme. */
export const cssVar = (v: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#888";

export function mount(html: string): void {
  const app = document.getElementById("app");
  if (app) app.innerHTML = html;
}

/** Delegate clicks by `data-act`, so re-rendering never leaves dead handlers behind. */
export function onAction(handler: (act: string, el: HTMLElement, ev: Event) => void): void {
  document.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
    if (el) handler(el.dataset.act!, el, ev);
  });
}

/**
 * The panel a route shows when it has nothing to show yet.
 *
 * There are two of these and conflating them is the bug this exists to stop. A
 * page that is still reading looks exactly like a page whose read failed, and
 * the second one waited forever behind the first one's wording — the front door
 * said "reading the live venue…" indefinitely whenever the indexer hiccuped,
 * which is indistinguishable from a broken site and was the first thing a
 * visitor would see.
 *
 * So the failure case says what broke, when, and offers the one action that can
 * help. Nothing here retries on its own — the cycle already does that on its own
 * schedule; this is for the person who does not want to wait for it.
 */
export function pending(what: string, error: string | null, sinceSec?: number): string {
  if (!error) return `<div class="panel pad"><p class="empty">${esc(what)}…</p></div>`;
  const when = sinceSec ? ` ${relTime(sinceSec)}` : "";
  return `
  <div class="panel pad">
    <h3 style="margin:0">Could not reach the venue</h3>
    <p class="mut" style="font-size:13.5px;margin:8px 0 0">
      The last attempt${when} failed. Rivo reads public Somnia indexers directly from this page, so
      this is usually the indexer or your connection rather than anything here — nothing is
      configured and nothing is signed.
    </p>
    <p class="note warn" style="margin:12px 0 0">${esc(error)}</p>
    <div style="display:flex;gap:9px;margin-top:12px;flex-wrap:wrap">
      <button class="primary" data-act="retry">Try again</button>
      <a class="btn" href="#/evidence">Read the evidence instead</a>
    </div>
    <p class="mut" style="font-size:12px;margin:10px 0 0">It also retries by itself every 30 seconds.</p>
  </div>`;
}
