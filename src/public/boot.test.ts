// Boot the actual app against a DOM.
//
// The render tests cover views in isolation; this covers the thing that breaks
// in practice — the entry point. It runs the shipped bundle in a real DOM with
// the network faked, so a crash in routing, wallet restore, evidence loading or
// the first cycle fails here instead of on a blank page during a demo.
//
// It reads `public/app.js`, which means it also asserts the BUILD works: an
// esbuild config that quietly drops a module, or a Node builtin reaching the
// browser bundle, shows up as a boot failure rather than passing typecheck and
// dying in production.

import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { VENUE } from "../core/venue.js";

const BUNDLE = resolve("public/app.js");
const SHELL = resolve("public/index.html");

/** Minimal, deterministic stand-ins for every network call the app makes. */
function fakeFetch(calls: string[]) {
  return async (input: unknown): Promise<unknown> => {
    const url = String((input as { url?: string })?.url ?? input);
    calls.push(url);
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

    if (url.endsWith("calibration.json")) {
      return json({
        period: { from: 0, to: 86400 },
        sample: { marketsTotal: 1, marketsUsed: 1, forecasts: 30771, realizedUpRate: 0.5 },
        discrimination: { auc: 0.81 },
        calibration: { brier: 0.17, brierCoin: 0.25, brierPrior: 0.25, logLoss: 0.55 },
        shrinkage: { prior: 0.5, slope: 0.92, brierAfter: 0.177 },
        reliability: [{ lo: 0, hi: 0.1, n: 10, meanP: 0.05, freq: 0.06 }],
        byPhase: [{ phase: 0.1, n: 10, auc: 0.6, brier: 0.24 }],
        holdout: { n: 9232, auc: 0.8305, brier: 0.1696, brierCoin: 0.25 },
      });
    }
    if (/\.json$/.test(url)) return { ok: false, status: 404, json: async () => ({}) };
    // Any GraphQL read: an empty but well-formed venue. The app must render a
    // venue with nothing live rather than throwing on empty arrays.
    return json({ data: { BinaryMarket: [], OracleAnswer: [], MarketReferenceLink: [], BinaryOrder: [], Candle: [], PriceUpdate: [] } });
  };
}

let win: Window;
let calls: string[];

beforeAll(async () => {
  if (!existsSync(BUNDLE)) throw new Error(`${BUNDLE} missing — run \`npm run build:public\` first`);
  calls = [];
  win = new Window({ url: "https://rivo.test/" });
  win.document.write(readFileSync(SHELL, "utf8").replace('<script type="module" src="app.js"></script>', ""));
  (win as unknown as { fetch: unknown }).fetch = fakeFetch(calls);
  // No wallet: the most common visitor, and the path most likely to throw on a
  // missing `window.ethereum`.
  // Node defines some of these as getter-only on globalThis, so assign through
  // defineProperty rather than plain assignment and skip any that refuse.
  const g = globalThis as Record<string, unknown>;
  const src = win as unknown as Record<string, unknown>;
  for (const k of ["window", "document", "location", "navigator", "getComputedStyle", "fetch", "localStorage", "HTMLElement", "Event"]) {
    try {
      Object.defineProperty(g, k, { value: src[k], writable: true, configurable: true });
    } catch {
      /* a global this environment will not let us shadow; the bundle reads it off `window` anyway */
    }
  }
  const code = readFileSync(BUNDLE, "utf8");
  await new win.Function(code)();
  // Let boot's async work settle: evidence load, backend discovery, first cycle.
  await new Promise((r) => setTimeout(r, 400));
});

describe("the app boots", () => {
  it("renders navigation and a route without throwing", () => {
    const html = win.document.body.innerHTML;
    expect(html.length).toBeGreaterThan(500);
    expect(html).toContain("Rivo");
    expect(html).not.toContain("failed to start");
  });

  it("renders the landing route by default", () => {
    expect(win.document.body.innerHTML).toMatch(/portfolio/i);
  });

  it("shows the connect control when no wallet is present", () => {
    expect(win.document.body.innerHTML).toMatch(/Connect wallet/i);
  });

  it("reads its evidence artefacts", () => {
    expect(calls.some((u) => u.includes("calibration.json"))).toBe(true);
  });

  it("survives a venue with nothing live rather than throwing", () => {
    // Every array came back empty. An engine that assumes at least one window
    // would have thrown inside the first cycle and blanked the page.
    expect(win.document.body.innerHTML).not.toContain("failed to start");
  });

  it("routes to the explorer and the evidence page", async () => {
    for (const [hash, expected] of [["#/explorer", /live contract|reading the venue/i], ["#/evidence", /Measured before it was trusted/i]] as const) {
      win.location.hash = hash;
      win.dispatchEvent(new win.Event("hashchange"));
      await new Promise((r) => setTimeout(r, 120));
      expect(win.document.body.innerHTML).toMatch(expected);
    }
  });

  it("routes to the app and asks for a wallet rather than crashing", async () => {
    win.location.hash = "#/app";
    win.dispatchEvent(new win.Event("hashchange"));
    await new Promise((r) => setTimeout(r, 120));
    const html = win.document.body.innerHTML;
    expect(html).toMatch(/wallet/i);
    expect(html).not.toContain("failed to start");
  });
});

describe("the bundle is genuinely browser-safe", () => {
  it("contains no Node builtin imports", () => {
    const code = readFileSync(BUNDLE, "utf8");
    expect(code).not.toMatch(/require\(["']node:/);
    expect(code).not.toMatch(/from["']node:/);
  });

  it("contains no private key material or env secrets", () => {
    // The bundle is published publicly, and a build that inlined .env would be a
    // catastrophe that typechecks perfectly.
    //
    // The venue ids are legitimately 64 hex characters and are public constants,
    // so they are excluded by value rather than by loosening the pattern — a
    // looser pattern is how a real key would slip through.
    const code = readFileSync(BUNDLE, "utf8");
    const publicConstants = [VENUE.testnet.venueId, VENUE.mainnet.venueId].map((v) => v.replace(/^0x/, "").toLowerCase());
    const suspects = [...code.matchAll(/0x([0-9a-fA-F]{64})\b/g)]
      .map((m) => m[1]!.toLowerCase())
      .filter((hex) => !publicConstants.includes(hex));
    expect(suspects).toEqual([]);
    expect(code).not.toMatch(/PRIVATE_KEY\s*[:=]\s*["'][^"']{8,}["']/);
  });
});
