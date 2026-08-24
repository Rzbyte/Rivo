// The clock on the Markets page.
//
// It rendered `secondsLeft` straight from the payload, so it moved once per
// poll — ten seconds at a time, and up to eighteen behind, since the endpoint
// caches for eight. On a fifteen-minute contract that is the difference between
// a live venue and a screenshot of one.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve("web/app/markets/page.tsx"), "utf8");

describe("the countdown", () => {
  it("counts from the absolute expiry, not the payload's snapshot", () => {
    // `expiry` was already on every card. Using it is what makes the number a
    // clock rather than a reading of one.
    expect(SRC).toMatch(/const left = c\.expiry - now/);
    expect(SRC).not.toMatch(/countdown\(c\.secondsLeft\)/);
  });

  it("ticks every second on its own timer", () => {
    expect(SRC).toMatch(/setInterval\([\s\S]{0,80}?,\s*1_000\)/);
  });

  it("aligns to the wall clock so every card turns over together", () => {
    // A timer started on mount drifts against the second boundary and against
    // the row above it, which reads as the page being slightly broken.
    expect(SRC).toMatch(/1_000 - \(Date\.now\(\) % 1_000\)/);
  });

  it("clears both timers on unmount", () => {
    // Two of them — the alignment timeout and the interval it starts — and
    // leaking either is a tick that keeps firing after the page is gone.
    const effect = SRC.slice(SRC.indexOf("function useNow"), SRC.indexOf("export default function Markets"));
    expect(effect).toMatch(/clearTimeout\(align\)/);
    expect(effect).toMatch(/clearInterval\(interval\)/);
  });

  it("keeps seconds visible under an hour", () => {
    // Above an hour the seconds are noise; under one they are the whole point,
    // because that is the window where somebody is watching it tick.
    expect(SRC).toMatch(/h > 0[\s\S]{0,160}\$\{String\(sec\)\.padStart\(2, "0"\)\}s/);
  });
});
