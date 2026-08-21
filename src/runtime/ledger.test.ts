// The cash ledger.
//
// These exist because of a real failure, not a hypothetical one. A live run
// reached 451.76 of cash against 50 of allocated capital, and nothing in the
// system noticed: reconciliation could hand the portfolio a position it never
// paid for, and the eventual payout was credited with no matching debit. The
// equity curve, the drawdown breaker and every report downstream were quietly
// wrong for hours.
//
// The identity is one line — cash + open cost == capital + contributed +
// realised — and every path that moves positions has to preserve it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionLog, emptyState, ledgerBalances, ledgerImbalance, type DecisionRecord, type HeldPosition, type RivoState } from "./state.js";
import { reconcile } from "./reconcile.js";
import { backoffSec, FAILURE_BACKOFF_CAP_SEC } from "./loop.js";
import type { Asset } from "../core/config.js";

const NOW = 1_800_000_000;

const held = (over: Partial<HeldPosition> = {}): HeldPosition => ({
  marketId: "0xmarket1",
  asset: "BTC" as Asset,
  intervalSec: 3600,
  leg: "UP",
  shares: 10,
  entryPrice: 0.4,
  cost: 4,
  expiry: NOW + 3600,
  deltaPer1PctPerShare: 0.02,
  openedAt: NOW - 600,
  fairAtEntry: 0.5,
  ...over,
});

/** A state that already balances: 50 capital, one position bought for 4. */
function balanced(): RivoState {
  const s = emptyState(50, "balanced", false);
  s.open = [held()];
  s.cash = 46;
  return s;
}

const meta = new Map([
  ["0xmarket9:UP", { asset: "BTC" as Asset, intervalSec: 3600, expiry: NOW + 1800 }],
]);

describe("the ledger identity", () => {
  it("holds for a fresh portfolio", () => {
    expect(ledgerBalances(emptyState(50, "balanced", true))).toBe(true);
  });

  it("holds after an ordinary purchase", () => {
    expect(ledgerBalances(balanced())).toBe(true);
  });

  it("catches an imbalance rather than reporting health", () => {
    const s = balanced();
    s.cash += 100; // the bug, in one line
    expect(ledgerBalances(s)).toBe(false);
    expect(ledgerImbalance(s)).toBeCloseTo(100, 9);
  });
});

describe("reconciliation preserves it", () => {
  it("adopting a position the chain holds does not create cash from nothing", () => {
    const s = balanced();
    reconcile({
      state: s,
      chain: new Map([["0xmarket1:UP", 10], ["0xmarket9:UP", 20]]),
      marks: new Map([["0xmarket9:UP", 0.3]]),
      meta,
      now: NOW,
    });
    expect(s.open).toHaveLength(2);
    expect(s.contributed).toBeCloseTo(6, 9); // 20 shares at the 0.3 mark
    expect(ledgerBalances(s)).toBe(true);
  });

  it("keeps adopted value OUT of capital, so a stray token cannot raise risk limits", () => {
    // Risk budgets are fractions of capital. If adoption raised capital, finding
    // an unexpected position on the wallet would widen Rivo's own delta budget —
    // exactly backwards, since the position already consumes that budget.
    const s = balanced();
    reconcile({
      state: s,
      chain: new Map([["0xmarket1:UP", 10], ["0xmarket9:UP", 500]]),
      marks: new Map([["0xmarket9:UP", 0.5]]),
      meta,
      now: NOW,
    });
    expect(s.capital).toBe(50);
    expect(s.contributed).toBeCloseTo(250, 9);
    expect(ledgerBalances(s)).toBe(true);
  });

  it("dropping a position the chain does not hold does not step equity up for free", () => {
    const s = balanced();
    s.open = [held({ openedAt: NOW - 10_000 })];
    reconcile({ state: s, chain: new Map(), now: NOW });
    expect(s.open).toHaveLength(0);
    expect(s.contributed).toBeCloseTo(-4, 9);
    expect(ledgerBalances(s)).toBe(true);
  });

  it("resizing to match the chain books the difference", () => {
    const s = balanced();
    s.open = [held({ openedAt: NOW - 10_000 })];
    reconcile({ state: s, chain: new Map([["0xmarket1:UP", 5]]), now: NOW });
    expect(s.open[0]!.shares).toBe(5);
    expect(s.open[0]!.cost).toBeCloseTo(2, 9);
    expect(s.contributed).toBeCloseTo(-2, 9);
    expect(ledgerBalances(s)).toBe(true);
  });

  it("stays balanced across adopt, resize and drop in one pass", () => {
    const s = emptyState(50, "balanced", false);
    s.cash = 40;
    s.open = [
      held({ marketId: "0xkeep", cost: 4, shares: 10, openedAt: NOW - 10_000 }),
      held({ marketId: "0xshrink", cost: 3, shares: 10, openedAt: NOW - 10_000 }),
      held({ marketId: "0xgone", cost: 3, shares: 10, openedAt: NOW - 10_000 }),
    ];
    reconcile({
      state: s,
      chain: new Map([["0xkeep:UP", 10], ["0xshrink:UP", 4], ["0xmarket9:UP", 8]]),
      marks: new Map([["0xmarket9:UP", 0.25]]),
      meta,
      now: NOW,
    });
    expect(s.open.map((p) => p.marketId).sort()).toEqual(["0xkeep", "0xmarket9", "0xshrink"]);
    expect(ledgerBalances(s)).toBe(true);
  });

  it("leaves a position inside the indexer grace window untouched", () => {
    // A position opened seconds ago may legitimately be invisible to the
    // indexer. Dropping it would break the ledger AND lose a real position.
    const s = balanced();
    s.open = [held({ openedAt: NOW - 30 })]; // well inside the 120s grace
    reconcile({ state: s, chain: new Map(), now: NOW });
    expect(s.open).toHaveLength(1);
    expect(s.contributed).toBe(0);
    expect(ledgerBalances(s)).toBe(true);
  });

  it("drops a position that has been invisible for LONGER than the grace window", () => {
    const s = balanced();
    s.open = [held({ openedAt: NOW - 121 })];
    reconcile({ state: s, chain: new Map(), now: NOW });
    expect(s.open).toHaveLength(0);
    expect(ledgerBalances(s)).toBe(true);
  });
});

describe("the live failure this prevents", () => {
  it("reproduces the drift when adoption is not booked, and shows the fix removes it", () => {
    // Simulate the old behaviour: adopt without recording the contribution, then
    // settle the adopted position and credit its payout.
    const broken = balanced();
    broken.open.push(held({ marketId: "0xadopted", shares: 20, cost: 6, adopted: true }));
    // no contributed adjustment — the bug
    expect(ledgerBalances(broken)).toBe(false);
    expect(ledgerImbalance(broken)).toBeCloseTo(6, 9);

    const fixed = balanced();
    fixed.open.push(held({ marketId: "0xadopted", shares: 20, cost: 6, adopted: true }));
    fixed.contributed = (fixed.contributed ?? 0) + 6;
    expect(ledgerBalances(fixed)).toBe(true);
  });
});

describe("failing orders back off instead of retrying forever", () => {
  it("escalates the delay, so a permanently unsellable leg stops burning cycles", () => {
    // `lastTradedAt` only records SUCCESS, so before this a leg whose orders
    // reverted had no cooldown at all. Measured on a live canary: one stuck
    // 0.56-share position produced 22 errors across 110 cycles.
    expect(backoffSec(1)).toBe(60);
    expect(backoffSec(2)).toBe(120);
    expect(backoffSec(3)).toBe(240);
    expect(backoffSec(4)).toBe(480);
  });

  it("caps the delay so a leg is never abandoned outright", () => {
    expect(backoffSec(50)).toBe(FAILURE_BACKOFF_CAP_SEC);
    expect(FAILURE_BACKOFF_CAP_SEC).toBeLessThanOrEqual(3600);
  });

  it("treats a zero or negative count as the first retry rather than throwing", () => {
    expect(backoffSec(0)).toBe(60);
    expect(backoffSec(-3)).toBe(60);
  });
});

describe("the decision log stays on disk without eating it", () => {
  // The log is the forward-test record and was deliberately unbounded. Measured
  // at ~3.6KB a cycle, a 45-second cadence writes ~7MB a day, and a trading
  // process that dies of a full disk dies holding positions — at a moment
  // determined by the disk rather than by anything about the market.
  let dir: string;
  const savedCap = process.env.RIVO_LOG_MAX_BYTES;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivo-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedCap === undefined) delete process.env.RIVO_LOG_MAX_BYTES;
    else process.env.RIVO_LOG_MAX_BYTES = savedCap;
  });

  const rec = (i: number) =>
    ({ at: i, cycle: i, marketId: `0x${i}`, leg: "UP", action: "SKIP", note: "x".repeat(200) }) as unknown as DecisionRecord;

  it("rolls aside once past the cap, and keeps writing", () => {
    process.env.RIVO_LOG_MAX_BYTES = "2000";
    const path = join(dir, "decisions.jsonl");
    const log = new DecisionLog(path);

    for (let i = 0; i < 40; i++) log.append([rec(i)]);

    expect(existsSync(`${path}.1`)).toBe(true);
    // Still readable, and reading returns the current generation rather than
    // throwing on a file that moved under it.
    const tail = log.read();
    expect(tail.length).toBeGreaterThan(0);
    expect(statSync(path).size).toBeLessThan(4000);
  });

  it("rolls by renaming, so no reader is ever handed half a record", () => {
    process.env.RIVO_LOG_MAX_BYTES = "1000";
    const path = join(dir, "decisions.jsonl");
    const log = new DecisionLog(path);
    for (let i = 0; i < 20; i++) log.append([rec(i)]);

    // Every line in both generations parses. Truncating in place instead of
    // renaming is what would break this.
    for (const f of [path, `${path}.1`]) {
      for (const line of readFileSync(f, "utf8").split("\n").filter((l) => l.trim())) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("keeps everything when the cap is disabled", () => {
    process.env.RIVO_LOG_MAX_BYTES = "0";
    const path = join(dir, "decisions.jsonl");
    const log = new DecisionLog(path);
    for (let i = 0; i < 40; i++) log.append([rec(i)]);
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(log.count()).toBe(40);
  });
});
