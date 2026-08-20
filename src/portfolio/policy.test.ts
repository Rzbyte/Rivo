// A policy is what stands between what a user asked for and what gets executed,
// so the properties pinned here are the ones whose failure would be silent: an
// override that loosens instead of tightens, a profile label that no longer
// matches its constraints, and a malformed capital figure reaching the sizer.

import { describe, expect, it } from "vitest";
import { limitsOf, mayManage, mayOpen, newPolicy, parsePolicy, resolvePolicy, type PortfolioPolicy } from "./policy.js";
import { PROFILES } from "./profiles.js";

const OWNER = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

describe("resolvePolicy", () => {
  it("returns the profile untouched when the user set no overrides", () => {
    const r = resolvePolicy(newPolicy(OWNER, 100, "balanced"));
    expect(r.maxDeployed).toBe(PROFILES.balanced.maxDeployed);
    expect(r.minEdge).toBe(PROFILES.balanced.minEdge);
    expect(r.kellyFraction).toBe(PROFILES.balanced.kellyFraction);
  });

  it("applies an override that tightens a ceiling", () => {
    const p = { ...newPolicy(OWNER, 100, "balanced"), overrides: { maxDeployed: 0.2 } };
    expect(resolvePolicy(p).maxDeployed).toBe(0.2);
  });

  it("REFUSES an override that would loosen a ceiling", () => {
    // The label is the thing being chosen. A Conservative portfolio that can be
    // widened to Active limits while still saying "Conservative" is a lie the UI
    // would keep telling.
    const p = { ...newPolicy(OWNER, 100, "conservative"), overrides: { maxDeployed: 0.99 } };
    expect(resolvePolicy(p).maxDeployed).toBe(PROFILES.conservative.maxDeployed);
  });

  it("treats minEdge and cashFloor as floors, where stricter means larger", () => {
    const p = {
      ...newPolicy(OWNER, 100, "active"),
      overrides: { minEdge: 0.2, cashFloor: 0.8 },
    };
    const r = resolvePolicy(p);
    expect(r.minEdge).toBe(0.2);
    expect(r.cashFloor).toBe(0.8);

    const loosen = { ...newPolicy(OWNER, 100, "conservative"), overrides: { minEdge: 0.001, cashFloor: 0.01 } };
    expect(resolvePolicy(loosen).minEdge).toBe(PROFILES.conservative.minEdge);
    expect(resolvePolicy(loosen).cashFloor).toBe(PROFILES.conservative.cashFloor);
  });

  it("keeps only tenor caps for cadences the venue actually lists", () => {
    const p = {
      ...newPolicy(OWNER, 100, "balanced"),
      overrides: { maxPerTenor: { 900: 0.05, 7: 0.5 } },
    };
    const caps = resolvePolicy(p).maxPerTenor!;
    expect(caps[900]).toBe(0.05);
    expect(caps[7]).toBeUndefined();
  });
});

describe("the three profiles are genuinely different portfolios", () => {
  it("differ in WHICH constraint binds, not only in scale", () => {
    // If they were a size dial, every ratio between them would be the same.
    // They are not: Conservative refuses concentration Active is happy to hold,
    // and Active crosses spreads Conservative will not.
    const deployRatio = PROFILES.active.maxDeployed / PROFILES.conservative.maxDeployed;
    const deltaRatio = PROFILES.active.maxAssetDeltaPer1Pct / PROFILES.conservative.maxAssetDeltaPer1Pct;
    const edgeRatio = PROFILES.conservative.minEdge / PROFILES.active.minEdge;
    expect(deltaRatio).toBeGreaterThan(deployRatio * 2);
    expect(edgeRatio).toBeGreaterThan(2);
  });

  it("produce different collateral limits at the same capital", () => {
    const at = (p: Parameters<typeof newPolicy>[2]) => limitsOf(newPolicy(OWNER, 100, p));
    expect(at("conservative").deployedCap).toBeLessThan(at("balanced").deployedCap);
    expect(at("balanced").deployedCap).toBeLessThan(at("active").deployedCap);
    expect(at("conservative").cashFloor).toBeGreaterThan(at("active").cashFloor);
  });
});

describe("parsePolicy", () => {
  it("lowercases the owner so a checksummed address cannot fork a portfolio", () => {
    // Two spellings of one address must not become two isolated portfolios.
    expect(parsePolicy({ owner: OWNER, capital: 10, profile: "balanced" }).owner).toBe(OWNER.toLowerCase());
  });

  it("rejects a bad address, capital or profile rather than coercing it", () => {
    expect(() => parsePolicy({ owner: "nope", capital: 10 })).toThrow(/owner/);
    expect(() => parsePolicy({ owner: OWNER, capital: 0 })).toThrow(/capital/);
    expect(() => parsePolicy({ owner: OWNER, capital: Number.NaN })).toThrow(/capital/);
    expect(() => parsePolicy({ owner: OWNER, capital: 10, profile: "reckless" })).toThrow(/profile/);
  });

  it("drops out-of-range overrides instead of clamping them silently", () => {
    const p = parsePolicy({
      owner: OWNER, capital: 10, profile: "balanced",
      overrides: { maxDeployed: 1.5, maxPerPosition: -1, cashFloor: 0.5 },
    });
    expect(p.overrides.maxDeployed).toBeUndefined();
    expect(p.overrides.maxPerPosition).toBeUndefined();
    expect(p.overrides.cashFloor).toBe(0.5);
  });

  it("defaults an unknown mode to shadow — never to trading with real money", () => {
    expect(parsePolicy({ owner: OWNER, capital: 10, mode: "yolo" }).mode).toBe("shadow");
    expect(parsePolicy({ owner: OWNER, capital: 10, mode: "autopilot" }).mode).toBe("autopilot");
  });
});

describe("pause and stop are different promises", () => {
  const p = (state: PortfolioPolicy["state"]) => ({ ...newPolicy(OWNER, 10, "balanced"), state });

  it("only a running portfolio may open new positions", () => {
    expect(mayOpen(p("running"))).toBe(true);
    for (const s of ["idle", "paused", "stopped", "halted"] as const) expect(mayOpen(p(s))).toBe(false);
  });

  it("a paused portfolio is still managed, so settlements and claims continue", () => {
    expect(mayManage(p("paused"))).toBe(true);
    expect(mayManage(p("halted"))).toBe(true);
    expect(mayManage(p("stopped"))).toBe(false);
  });
});
