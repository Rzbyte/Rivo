// The one sentence on the consumer surface that can be wrong rather than ugly.
//
// This file exists because the first version was wrong. It mapped the engine's
// OVERCONFIDENT straight onto "the book is asking too much", which is correct
// above 0.5 and inverted below it — and on this venue every window quotes both
// legs, so half of all contracts would have been described backwards to the
// reader least equipped to notice.
//
// The engine's labels are about CERTAINTY (further from 0.5 than the outcomes
// justified). A reader wants DIRECTION (am I being asked more or less than this
// has been worth). Those coincide above 0.5 and oppose below it, which is
// exactly the shape of bug that survives a demo and fails in front of a judge.

import { describe, expect, it } from "vitest";
import { verdict, type VerdictInput } from "./verdict";
import { assess, ASSESSMENT_LABEL, type AssessmentCode } from "@rivo/intel/assessment.js";

/** A contract with everything healthy except what a test is about to set. */
const card = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  price: 0.5,
  spread: 0.01,
  depth: 900,
  reference: 0.5,
  historical: { realized: 0.5, windows: 200 },
  assessment: { code: "WELL_CALIBRATED" },
  ...over,
});

describe("the verdict a reader is shown", () => {
  it("calls a cheap leg cheap even when the engine calls it overconfident", () => {
    // Quoted 20%, settled 30%. The engine says OVERCONFIDENT — the price sat
    // further from 0.5 than the outcomes justified. The reader is being asked
    // for LESS than the band has been worth, and that is what the page says.
    const v = verdict(
      card({ price: 0.2, historical: { realized: 0.3, windows: 120 }, assessment: { code: "OVERCONFIDENT" } }),
    );
    expect(v.headline).toBe("The book is asking too little");
    expect(v.tone).toBe("under");
    // And the engine's own word survives in the sentence, so the two surfaces
    // cannot be read as disagreeing about the same contract.
    expect(v.detail).toContain("more certainty");
  });

  it("calls an expensive leg expensive when the engine calls it overconfident", () => {
    // Quoted 80%, settled 70%: above 0.5 the two framings agree.
    const v = verdict(
      card({ price: 0.8, historical: { realized: 0.7, windows: 120 }, assessment: { code: "OVERCONFIDENT" } }),
    );
    expect(v.headline).toBe("The book is asking too much");
    expect(v.tone).toBe("over");
  });

  it("reads direction from the numbers for underconfident too", () => {
    const cheap = verdict(
      card({ price: 0.4, historical: { realized: 0.52, windows: 90 }, assessment: { code: "UNDERCONFIDENT" } }),
    );
    expect(cheap.headline).toBe("The book is asking too little");
    const dear = verdict(
      card({ price: 0.6, historical: { realized: 0.48, windows: 90 }, assessment: { code: "UNDERCONFIDENT" } }),
    );
    expect(dear.headline).toBe("The book is asking too much");
  });

  it("agrees with the engine on every contract the engine will label", () => {
    // The property, rather than three examples of it: for any priced leg with a
    // real comparable set, the direction the page states must match the sign of
    // realized − price. Walked across the whole probability range, both legs.
    for (let price = 0.05; price <= 0.95; price += 0.05) {
      for (const realized of [price - 0.12, price - 0.05, price + 0.05, price + 0.12]) {
        if (realized <= 0 || realized >= 1) continue;
        const historical = { realized, windows: 200 };
        const code = assess({ price, bid: price - 0.01, ask: price, depth: 900, reference: price, historical }).code;
        if (code !== "OVERCONFIDENT" && code !== "UNDERCONFIDENT") continue;
        const v = verdict(card({ price, historical, assessment: { code } }));
        const shouldBeCheap = realized > price;
        expect(
          v.headline,
          `price ${price.toFixed(2)} realized ${realized.toFixed(2)} (${code})`,
        ).toBe(shouldBeCheap ? "The book is asking too little" : "The book is asking too much");
      }
    }
  });

  it("lets a caveat outrank a claim", () => {
    // A reader takes the biggest number on the screen and leaves, so a thin
    // sample must not appear as a footnote under a confident headline.
    const thin = verdict(card({ historical: { realized: 0.9, windows: 4 }, assessment: { code: "INSUFFICIENT_SAMPLE" } }));
    expect(thin.tone).toBe("caveat");
    expect(thin.detail).toContain("4");

    const wide = verdict(card({ spread: 0.09, assessment: { code: "HIGH_SPREAD" } }));
    expect(wide.tone).toBe("caveat");

    const empty = verdict(card({ depth: 2, assessment: { code: "LOW_LIQUIDITY" } }));
    expect(empty.tone).toBe("caveat");
  });

  it("says nobody knows when nothing comparable has settled", () => {
    const v = verdict(card({ historical: null, assessment: { code: "INSUFFICIENT_SAMPLE" } }));
    expect(v.detail).toMatch(/nobody knows/i);
  });

  it("never phrases a verdict as an instruction", () => {
    // Descriptive, always. The moment one of these reads "buy" or "sell" the
    // page has stopped being a measurement, whatever the disclaimer says.
    for (const code of Object.keys(ASSESSMENT_LABEL) as AssessmentCode[]) {
      const v = verdict(card({ assessment: { code }, historical: { realized: 0.62, windows: 80 } }));
      const text = `${v.headline} ${v.detail}`.toLowerCase();
      // Instruction shapes, not vocabulary: "a round trip costs 9%" describes,
      // "you should buy" prescribes, and only the second one is the failure.
      for (const phrase of ["you should", "we recommend", "recommend", "worth buying", "worth selling", "good trade", "free money", "expected profit"]) {
        expect(text, `${code} said "${phrase}"`).not.toContain(phrase);
      }
    }
  });
});
