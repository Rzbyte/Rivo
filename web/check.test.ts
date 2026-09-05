// The consumer surface, held to the two promises that make it publishable.
//
// A page that folds the sample size away is one edit from being a page that
// lost it, and a page that renders a verdict about a price is one edit from
// being a page that sells it. Neither edit would look like a mistake in review;
// both would change what this product is. So both are asserted here rather than
// left to intention.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSESSMENT_LABEL, type AssessmentCode } from "../src/intel/assessment.js";

const SOURCE = readFileSync(resolve("web/app/check/page.tsx"), "utf8");

describe("the check surface", () => {
  it("has a branch for every assessment the engine can produce", () => {
    // A code with no branch falls through to the default, which says "This
    // price is honest" — the one wrong answer that reads like a right one. A
    // new code added to the engine has to fail here rather than ship as praise.
    //
    // The logic itself lives in web/lib/verdict.ts and is exercised on its
    // behaviour there; this only holds the coverage, which a source read can
    // check without rendering anything.
    const logic = readFileSync(resolve("web/lib/verdict.ts"), "utf8");
    for (const code of Object.keys(ASSESSMENT_LABEL) as AssessmentCode[]) {
      expect(logic, `no branch for ${code}`).toContain(`case "${code}"`);
    }
  });

  it("can reach nothing that signs, funds or trades", () => {
    // The refusal is structural rather than editorial: if this file cannot
    // import a signer, a wallet or a portfolio route, no amount of later copy
    // can turn a measurement into an execution.
    const forbidden = [
      "@rivo/signing",
      "@rivo/runtime/executor",
      "usePrivy",
      "@privy-io",
      "/api/portfolios",
      "/api/try-agent",
      "autopilot",
    ];
    for (const f of forbidden) {
      expect(SOURCE, `the check page must not reach ${f}`).not.toContain(f);
    }
  });

  it("reads the same endpoint the dense surface reads", () => {
    // Two surfaces describing one contract differently is the failure this
    // product exists to catch, and it would be the more embarrassing one for
    // happening inside it. Same endpoint, same assessment, folded differently.
    expect(SOURCE).toContain('useLive<Payload>("/api/markets"');
    // And the verdict is derived from the engine's own assessment rather than
    // recomputed here, so the two surfaces cannot drift into two opinions.
    const logic = readFileSync(resolve("web/lib/verdict.ts"), "utf8");
    expect(logic).toContain("c.assessment.code");
  });

  it("keeps the sample size one tap away rather than absent", () => {
    // Folding is only honest while the fold opens. These are the fields a
    // reader needs to know what a realized frequency is the frequency OF.
    for (const field of ["cohortLabel", "windows", "lo95", "hi95", "fellBack"]) {
      expect(SOURCE, `the working must still show ${field}`).toContain(field);
    }
  });

  it("says plainly that it is not advice", () => {
    expect(SOURCE.toLowerCase()).toContain("not advice");
  });

  it("is the first thing the nav offers", () => {
    // A front door behind four other doors is not one.
    const nav = readFileSync(resolve("web/components/Nav.tsx"), "utf8");
    const block = nav.slice(nav.indexOf("const SECTIONS"), nav.indexOf("] as const"));
    const first = block.match(/\["(\/[a-z]+)"/);
    expect(first?.[1]).toBe("/check");
  });
});
