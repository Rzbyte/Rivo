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
    const empty = evidence({ calibration: null, backtest: null, coherence: null, maker: null });
    expect(empty).toContain("not published");
    expect(() => evidence({ calibration: null, backtest: null, coherence: null, maker: null })).not.toThrow();
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
