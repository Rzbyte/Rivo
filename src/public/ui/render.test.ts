// Render tests.
//
// The product surface is a pure function from state to HTML, which makes it
// testable without a browser and worth testing: a throw inside a view is a blank
// page, and a blank page during a demo is indistinguishable from a broken
// project. These assert that every screen renders, that user-supplied and
// venue-supplied strings are escaped, and — most importantly — that the "why"
// panel prints the constraint the ENGINE chose rather than one the UI inferred.

import { beforeAll, describe, expect, it } from "vitest";
import type { DecisionView, PortfolioView } from "../engine.js";
import { newPolicy, limitsOf } from "../../portfolio/policy.js";
import { explain } from "../explain.js";
import { esc, horizon, meter, signed } from "./dom.js";
import { landing } from "./landing.js";
import { explorer } from "./explorer.js";
import { configure, dashboard, walletChip, type AppState } from "./portfolio.js";
import { termChart } from "./charts.js";
import * as store from "../store.js";

beforeAll(() => {
  // charts.ts reads CSS custom properties for theme colours. In Node there is no
  // document, so supply the narrowest possible stand-in rather than a DOM library.
  (globalThis as Record<string, unknown>).document = { documentElement: {} };
  (globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => "#123456" });
});

const OWNER = "0x1111111111111111111111111111111111111111";
const policy = { ...newPolicy(OWNER, 50, "balanced"), state: "running" as const };

const decision = (over: Partial<DecisionView> = {}): DecisionView => ({
  marketId: "0xmarket1",
  asset: "BTC",
  intervalSec: 3600,
  tenor: "1h",
  leg: "UP",
  label: "BTC 1h UP",
  fair: 0.62,
  ask: 0.55,
  bid: 0.53,
  edge: 0.07,
  action: "SKIP",
  shares: 0,
  cost: 0,
  binding: "BTC delta budget ±2.50/1%",
  limits: [
    { name: "kelly 8.0% of capital", allowedCost: 4, binding: false },
    { name: "BTC delta budget ±2.50/1%", allowedCost: 0, binding: true },
  ],
  kellyFull: 0.16,
  kellyTarget: 4,
  minutesLeft: 42,
  deltaPer1PctPerShare: 0.03,
  ...over,
});

const view = (over: Partial<PortfolioView> = {}): PortfolioView => ({
  at: 1_800_000_000,
  policy,
  limits: limitsOf(policy),
  cycles: 3,
  capital: 50,
  deployed: 12,
  cash: 38,
  equity: 50.4,
  realizedPnl: 0.4,
  unrealizedPnl: 0,
  capitalAtRisk: 12,
  risk: { assetDelta: new Map(), combinedDelta: 0, expiryBuckets: new Map(), capitalAtRisk: 12, maxLoss: 12 },
  exposures: [
    { asset: "BTC", delta: 2.5, cap: 2.5, cost: 8 },
    { asset: "ETH", delta: -0.4, cap: 2.5, cost: 4 },
  ],
  combined: { delta: 2.1, cap: 3 },
  expiry: [{ bucket: "2027-01-15T12:00", cost: 8, cap: 15 }],
  tenor: [{ intervalSec: 3600, label: "1h", cost: 8, cap: null }],
  positions: [
    {
      marketId: "0xmarket1", asset: "BTC", intervalSec: 3600, leg: "UP", shares: 20,
      entryPrice: 0.4, cost: 8, expiry: 1_800_003_600, deltaPer1PctPerShare: 0.125,
      openedAt: 1_799_996_400, fairAtEntry: 0.5, mark: 0.45, value: 9, label: "BTC 1h UP",
    },
  ],
  accepted: [],
  skipped: [decision()],
  closed: [],
  spot: { BTC: 68000, ETH: 2100 },
  rho: 0.83,
  unpriced: [],
  activity: [],
  ...over,
});

/** A signed-in, running state — the only one most of these screens render. */
const app = (): AppState => ({
  wallet: {
    address: OWNER, chainId: 50312, network: "testnet", gas: 1.5, collateral: 100,
    gasSymbol: "STT", collateralSymbol: "tUSDC",
  },
  connecting: false, error: null, policy, view: view(), backend: null,
  draft: { capital: 50, profile: "balanced", mode: "shadow" },
  busy: false, showAdvanced: true, equity: [], activity: [],
});

describe("every screen renders", () => {
  it("renders the landing page with a live preview", async () => {
    const { landing } = await import("./landing.js");
    const html = landing({ preview: view(), evidence: { auc: 0.83, brier: 0.17, skill: 0.32, n: 30771 }, connected: false });
    expect(html).toContain("portfolio");
    expect(html).toContain("0.83");
    expect(html.length).toBeGreaterThan(1000);
  });

  it("renders the dashboard", async () => {
    const { dashboard } = await import("./portfolio.js");
    const html = dashboard({
      wallet: {
        address: OWNER, chainId: 50312, network: "testnet", gas: 1.5, collateral: 100,
        gasSymbol: "STT", collateralSymbol: "tUSDC",
      },
      connecting: false, error: null, policy, view: view(), backend: null,
      draft: { capital: 50, profile: "balanced", mode: "shadow" },
      busy: false, showAdvanced: false, equity: [], activity: [],
    });
    expect(html).toContain("shadow");
    expect(html).toContain("Why this allocation?");
    expect(html).toContain("BTC 1h UP");
  });

  it("renders the evidence page from artefacts, and survives missing ones", async () => {
    const { evidence } = await import("./evidence.js");
    const empty = evidence({ calibration: null, backtest: null, coherence: null, maker: null, canary: null });
    expect(empty).toContain("not published");
    expect(() => evidence({ calibration: null, backtest: null, coherence: null, maker: null, canary: null })).not.toThrow();
  });

  it("renders the explorer's empty state rather than throwing on no snapshot", async () => {
    const { explorer } = await import("./explorer.js");
    expect(explorer(null)).toContain("reading the venue");
  });
});

describe("the why panel is the engine's answer, not the UI's", () => {
  it("names the binding constraint the allocator chose", () => {
    const v = view();
    const e = explain(v.skipped[0]!, v);
    expect(e.raw).toBe("BTC delta budget ±2.50/1%");
    expect(e.detail).toContain("BTC directional exposure");
  });

  it("attributes the budget to the position actually holding it", () => {
    const v = view();
    const e = explain(v.skipped[0]!, v);
    expect(e.competitors.map((c) => c.label)).toContain("BTC 1h UP");
  });

  it("distinguishes a leg already at target from one that lost out", () => {
    const v = view();
    const atTarget = explain(decision({ binding: "top-up of 0.00 below minimum trade 0.50 — not worth the spread" }), v);
    expect(atTarget.detail).toContain("already at the size Rivo wants");
    const sliver = explain(decision({ binding: "top-up of 0.40 below minimum trade 0.50 — not worth the spread" }), v);
    expect(sliver.detail).toContain("0.40 more here");
  });

  it("reports a Kelly-bound BUY as unconstrained rather than blaming a limit", () => {
    const v = view();
    const e = explain(decision({ action: "BUY", shares: 8, cost: 4.4, binding: "kelly 8.0% of capital" }), v);
    expect(e.detail).toContain("not by a portfolio limit");
  });

  it("quotes limits in the same collateral the policy resolved", () => {
    const v = view();
    const e = explain(decision({ binding: "deployed cap 70%" }), v);
    expect(e.detail).toContain(v.limits.deployedCap.toFixed(2));
  });
});

describe("escaping", () => {
  it("escapes venue strings that reach the DOM", () => {
    expect(esc('<img src=x onerror="alert(1)">')).not.toContain("<img");
    expect(esc("a & b")).toBe("a &amp; b");
  });

  it("renders a decision whose binding string contains markup", async () => {
    const { dashboard } = await import("./portfolio.js");
    const v = view({ skipped: [decision({ binding: "<script>alert(1)</script>", label: "<b>x</b>" })] });
    const html = dashboard({
      wallet: {
        address: OWNER, chainId: 50312, network: "testnet", gas: 1, collateral: 1,
        gasSymbol: "STT", collateralSymbol: "tUSDC",
      },
      connecting: false, error: null, policy, view: v, backend: null,
      draft: { capital: 50, profile: "balanced", mode: "shadow" },
      busy: false, showAdvanced: false, equity: [], activity: [],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("formatting helpers", () => {
  it("formats horizons the way a trader reads them", () => {
    expect(horizon(0.4)).toBe("<1m");
    expect(horizon(42)).toBe("42m");
    expect(horizon(90)).toBe("1.5h");
    expect(horizon(2880)).toBe("2.0d");
  });

  it("signs with a real minus sign and no double sign", () => {
    expect(signed(1.5)).toBe("+1.50");
    expect(signed(-1.5)).toBe("−1.50");
  });

  it("marks a meter over its limit", () => {
    expect(meter(3, 2)).toContain("over");
    expect(meter(1, 2)).not.toContain("over");
    expect(meter(1, 0)).toBe("");
  });
});

describe("a page that cannot reach the venue says so", () => {
  // The failure this pins is not a crash. It is a page that waits: the landing
  // route and the explorer both rendered "reading the live venue…" and left it
  // there forever when a read threw, because the only place an error surfaced
  // was the dashboard's activity feed. An indefinite loading state is
  // indistinguishable from a broken site, and the landing page is the first
  // thing anyone sees.

  it("still says 'reading' while it genuinely is", () => {
    const html = landing({ preview: null, evidence: null, connected: false, error: null });
    expect(html).toContain("reading the live venue");
    expect(html).not.toContain("Could not reach the venue");
  });

  it("names the failure, and offers the action that helps", () => {
    const html = landing({
      preview: null,
      evidence: null,
      connected: false,
      error: "NetworkError when attempting to fetch resource",
      errorAt: Math.floor(Date.now() / 1000) - 120,
    });
    expect(html).toContain("Could not reach the venue");
    expect(html).toContain("NetworkError");
    expect(html).toContain('data-act="retry"');
    // And says it is not the visitor's problem to configure away. Collapsed,
    // because the source wraps this sentence across lines.
    expect(html.replace(/\s+/g, " ")).toContain("nothing is configured and nothing is signed");
  });

  it("escapes whatever the failure said, since it reaches the DOM", () => {
    const html = landing({ preview: null, evidence: null, connected: false, error: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("does the same on the explorer, which fails the same way", () => {
    expect(explorer(null, "testnet", null)).toContain("reading the venue");
    const failed = explorer(null, "testnet", "indexer 503");
    expect(failed).toContain("Could not reach the venue");
    expect(failed).toContain('data-act="retry"');
  });
});

describe("nothing overflows a phone", () => {
  // A table wider than the viewport does not clip — it stretches its ancestors
  // and pushes the whole page sideways, so one wide table breaks every screen it
  // appears on. The convention is a `.scroll` wrapper; the convention had drifted
  // on three of seven tables. This asserts the convention instead of the memory
  // of it, across every view that renders one.
  const wrapped = (html: string): boolean => {
    // Walk the tags in order; every <table> must be inside an open .scroll div.
    let depthSinceScroll: number | null = null;
    for (const m of html.matchAll(/<(\/?)(div|table)\b([^>]*)>/g)) {
      const [, closing, tag, attrs] = m;
      if (tag === "table" && !closing && depthSinceScroll === null) return false;
      if (tag !== "div") continue;
      if (!closing) {
        if (depthSinceScroll !== null) depthSinceScroll++;
        else if ((attrs ?? "").includes("scroll")) depthSinceScroll = 0;
      } else if (depthSinceScroll !== null) {
        if (depthSinceScroll === 0) depthSinceScroll = null;
        else depthSinceScroll--;
      }
    }
    return true;
  };

  it("the check itself can fail", () => {
    // A convention test that cannot go red is decoration. These four cases pin
    // the walker: bare table, wrapped table, a wrapper that closed before the
    // table, and a table nested deeper inside a wrapper that is still open.
    expect(wrapped("<div><table></table></div>")).toBe(false);
    expect(wrapped('<div class="scroll"><table></table></div>')).toBe(true);
    expect(wrapped('<div class="scroll"></div><table></table>')).toBe(false);
    expect(wrapped('<div class="scroll"><div><span></span><table></table></div></div>')).toBe(true);
  });

  // Built inside each test, not at collection time: charts.ts reads CSS custom
  // properties, and the stand-in for those is installed by beforeAll.
  const views: Record<string, () => string> = {
    dashboard: () => dashboard(app()),
    configure: () => configure(app()),
    explorer: () => explorer(null, "testnet", "unreachable"),
    landing: () => landing({ preview: null, evidence: null, connected: false, error: null }),
  };

  for (const [name, build] of Object.entries(views)) {
    it(`keeps every table in ${name} inside a scroll container`, () => {
      const html = build();
      expect(html).toContain("<div"); // the walker is only meaningful on real markup
      expect(wrapped(html)).toBe(true);
    });
  }
});

describe("a keyboard and a screen reader can use it", () => {
  // The × that discards a portfolio is the most destructive control on the page
  // and, announced as "times", the least identifiable. A title attribute is not
  // a substitute: it is a tooltip, not a name.
  it("names the icon-only controls", () => {
    const demo = store.demoIdentity();
    let checked = 0;
    for (const address of [demo, "0x1111111111111111111111111111111111111111"]) {
      const html = walletChip({
        wallet: {
          address: address as `0x${string}`, chainId: 50312, network: "testnet", gas: 1, collateral: 1,
          gasSymbol: "STT", collateralSymbol: "tUSDC",
        },
        connecting: false, error: null, policy: null, view: null, backend: null,
        draft: { capital: 50, profile: "balanced", mode: "shadow" },
        busy: false, showAdvanced: false, equity: [], activity: [],
      } as AppState);
      if (!html.includes("×")) continue;
      expect(html).toMatch(/aria-label="[^"]{4,}"/);
      checked++;
    }
    // Both the demo and the wallet chip carry one. Without this the loop could
    // find no × at all and the test would pass having asserted nothing.
    expect(checked).toBe(2);
  });
});

describe("the front door leads with the refusal", () => {
  // The strongest claim this project can make is that it turned down a trade it
  // could see money in, and named the limit that stopped it. That used to live
  // in a note at the bottom of a panel most visitors never scrolled to.
  const refused = (binding: string) =>
    decision({ label: "BTC 15m DOWN", fair: 0.118, ask: 0.059, edge: 0.059, binding, action: "SKIP" });

  it("makes the refused leg the headline, in the product's own numbers", () => {
    const html = landing({
      preview: view({ skipped: [refused("BTC delta budget ±2.50/1%")] }),
      evidence: null,
      connected: false,
      error: null,
    });
    expect(html).toContain("Rivo turned this down");
    expect(html).toContain("BTC 15m DOWN");
    expect(html).toContain("0.059");
    expect(html).toContain("0.118");
    expect(html).toContain("BTC delta budget");
  });

  it("holds the static claim until there is a refusal to name", () => {
    // The venue read takes seconds. A hero that is empty for that long is worse
    // than one that says what the product is and then gets specific.
    const html = landing({ preview: null, evidence: null, connected: false, error: null });
    expect(html).toContain("into a portfolio");
    expect(html).not.toContain("Rivo turned this down");
  });

  it("will not headline a refusal that was only about the price", () => {
    // "Edge below floor" is Rivo declining a bad trade, which every bot does.
    // Only a PORTFOLIO limit demonstrates the thing this page is arguing.
    const html = landing({
      preview: view({ skipped: [refused("edge below floor")] }),
      evidence: null,
      connected: false,
      error: null,
    });
    expect(html).not.toContain("Rivo turned this down");
    expect(html).toContain("into a portfolio");
  });
});

describe("the decision ledger shows the pattern the cards hide", () => {
  const leg = (label: string, binding: string, action: "BUY" | "SKIP" = "SKIP") =>
    decision({ label, binding, action, edge: 0.05, kellyTarget: 2, cost: action === "BUY" ? 1 : 0 });

  it("marks a constraint that bound repeatedly, and counts it", () => {
    const budget = "BTC delta budget ±2.50/1%";
    const html = dashboard({
      ...app(),
      view: view({
        accepted: [leg("BTC 4h DOWN", budget, "BUY")],
        skipped: [leg("BTC 15m DOWN", budget), leg("BTC 1h DOWN", budget), leg("ETH 1h UP", "edge below floor")],
      }),
    });
    expect(html).toContain("×3");
    // And says out loud what the repetition means, rather than leaving the
    // reader to notice a column of identical strings.
    expect(html).toMatch(/bound 3 of the 4 legs/);
  });

  it("says nothing about a pattern when there is not one", () => {
    const html = dashboard({
      ...app(),
      view: view({
        accepted: [],
        skipped: [leg("BTC 15m DOWN", "edge below floor"), leg("ETH 1h UP", "max position 20%")],
      }),
    });
    expect(html).not.toContain("×3");
    expect(html).not.toMatch(/bound \d+ of the/);
  });

  it("still carries the prose for the legs that earn it", () => {
    // The ledger is added ALONGSIDE the cards, not instead of them: the table
    // carries the shape, the cards carry the argument.
    const html = dashboard({ ...app(), view: view({ skipped: [leg("BTC 15m DOWN", "BTC delta budget ±2.50/1%")] }) });
    expect(html).toContain("Refused with positive edge");
    expect(html).toContain("every constraint the allocator applied");
  });
});

describe("the term structure shows both legs, around agreement", () => {
  const row = (asset: string, tenor: string, up: number | null, down: number | null) => ({
    asset,
    tenor,
    label: `${asset} ${tenor}`,
    up: up === null ? null : { fair: 0.5 + up, ask: 0.5 },
    down: down === null ? null : { fair: 0.5 + down, ask: 0.5 },
  });

  it("calls out an asset whose windows all lean the same way", () => {
    // This is the entire portfolio argument, and the old absolute-scale chart
    // could not show it: four windows at wildly different prices, all priced
    // above the book by the same amount, looked like four unrelated bars.
    const html = termChart([
      row("BTC", "15m", 0.04, 0.05),
      row("BTC", "1h", 0.03, 0.06),
      row("BTC", "4h", 0.05, 0.04),
      row("BTC", "1d", 0.001, 0.001),
    ]);
    expect(html).toMatch(/3 of 4 windows lean the same way/);
  });

  it("says so plainly when there is no lean", () => {
    const html = termChart([row("ETH", "15m", 0.001, -0.002), row("ETH", "1h", -0.001, 0.002)]);
    expect(html).toContain("no consistent lean");
  });

  it("takes its scale from the data rather than clipping", () => {
    // A quiet cycle must not be flattened to noise, and a violent one must not
    // run off the end of the axis.
    expect(termChart([row("BTC", "15m", 0.01, 0.01)])).toContain("+0.05");
    expect(termChart([row("BTC", "15m", 0.17, 0.02)])).toContain("+0.20");
  });

  it("draws a leg with no offer as absent rather than as agreement", () => {
    // An unquoted leg has no distance from the book to draw. Showing it at the
    // centre line would claim the model and the book agree, which is a stronger
    // statement than "nobody is quoting it".
    const html = termChart([row("BTC", "1d", null, 0.04)]);
    expect(html).toContain("—");
  });
});
