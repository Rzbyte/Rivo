// The statistics have to be wrong-proof, because they are the finding.
//
// The specific failure this file guards is the one `docs/CALIBRATION.md` names:
// treating rows as independent when they share a settled contract. That mistake
// does not produce an error — it produces a CONFIDENT number, which is worse,
// and it is invisible unless something asserts the interval widens when the
// clustering does.

import { describe, expect, it } from "vitest";
import { MIN_WINDOWS, summarise, verdict, type Entry } from "./breadth.js";

const entry = (marketId: string, stake: number, pnl: number, won: 0 | 1): Entry => ({ marketId, stake, pnl, won });

/** `n` windows, one decision each, every one paying `edge` per unit staked. */
const spread = (n: number, edge: number, stake = 1): Entry[] =>
  Array.from({ length: n }, (_, i) => entry(`w${i}`, stake, stake * edge, edge > 0 ? 1 : 0));

describe("the point estimate", () => {
  it("is total profit over total stake", () => {
    const s = summarise([entry("a", 10, 2, 1), entry("b", 30, -3, 0)]);
    expect(s.stake).toBe(40);
    expect(s.pnl).toBe(-1);
    expect(s.returnOnStake).toBeCloseTo(-1 / 40, 10);
  });

  it("counts windows, not rows", () => {
    const s = summarise([entry("a", 1, 0, 0), entry("a", 1, 0, 0), entry("b", 1, 0, 0)]);
    expect(s.entered).toBe(3);
    expect(s.windows).toBe(2);
  });

  it("reports a null return rather than Infinity when nothing was staked", () => {
    const s = summarise([entry("a", 0, 0, 0)]);
    expect(s.returnOnStake).toBeNull();
    expect(s.lo95).toBeNull();
  });

  it("survives an empty record without pretending to a result", () => {
    const s = summarise([]);
    expect(s.entered).toBe(0);
    expect(s.returnOnStake).toBeNull();
    expect(s.thin).toBe(true);
    expect(verdict(s)).toBeNull();
  });
});

describe("the interval is clustered by window", () => {
  it("brackets the point estimate", () => {
    const s = summarise(spread(400, -0.05));
    expect(s.lo95!).toBeLessThanOrEqual(s.returnOnStake!);
    expect(s.hi95!).toBeGreaterThanOrEqual(s.returnOnStake!);
  });

  it("is reproducible — a published interval that moves is not an interval", () => {
    const rows = spread(300, -0.04);
    expect(summarise(rows)).toEqual(summarise(rows));
  });

  it("WIDENS when the same rows are clustered into fewer windows", () => {
    // The whole point. 400 observations spread over 400 contracts carry far more
    // information than the same 400 spread over 20, and an interval that cannot
    // tell those apart is the exact mistake this module exists to avoid.
    const independent: Entry[] = [];
    const clustered: Entry[] = [];
    for (let i = 0; i < 400; i++) {
      const pnl = i % 2 === 0 ? 0.5 : -0.5;
      independent.push(entry(`w${i}`, 1, pnl, i % 2 === 0 ? 1 : 0));
      clustered.push(entry(`w${i % 20}`, 1, pnl, i % 2 === 0 ? 1 : 0));
    }
    const wideOf = (e: Entry[]) => { const s = summarise(e); return s.hi95! - s.lo95!; };
    expect(wideOf(clustered)).toBeGreaterThan(wideOf(independent));
  });

  it("finds a real loss when there is one", () => {
    const s = summarise(spread(600, -0.08));
    expect(s.hi95!).toBeLessThan(0);
    expect(verdict(s)).toBe("LOSES");
  });

  it("finds a real edge when there is one", () => {
    const s = summarise(spread(600, 0.08));
    expect(s.lo95!).toBeGreaterThan(0);
    expect(verdict(s)).toBe("CLEARS_THE_SPREAD");
  });
});

describe("thin rows do not get to conclude", () => {
  it("marks a small sample thin", () => {
    expect(summarise(spread(MIN_WINDOWS - 1, -0.05)).thin).toBe(true);
    expect(summarise(spread(MIN_WINDOWS, -0.05)).thin).toBe(false);
  });

  it("refuses a verdict on a thin row even when the interval looks decisive", () => {
    // 10 windows all losing heavily: the interval will exclude zero, and the row
    // still may not say so. Sample size outranks a clean-looking bound.
    const s = summarise(spread(10, -0.5));
    expect(s.hi95!).toBeLessThan(0);
    expect(verdict(s)).toBeNull();
  });

  it("says INCONCLUSIVE when a wide-enough sample still straddles zero", () => {
    const rows: Entry[] = [];
    for (let i = 0; i < 400; i++) rows.push(entry(`w${i}`, 1, i % 2 === 0 ? 0.9 : -0.9, i % 2 === 0 ? 1 : 0));
    const s = summarise(rows);
    expect(s.thin).toBe(false);
    expect(verdict(s)).toBe("INCONCLUSIVE");
  });
});
