// The landing page is the one page that reads no data, so it is the one page
// where a number can rot without anything going red.
//
// It carried "AUC 0.8158" and "−6.49%" as string literals. Both were correct
// when typed. Neither was connected to `PRODUCTION_STRATEGY`, which is what the
// execution gate actually reads and what /agents actually renders — so a
// revalidation run that moved either would have left the front door quoting one
// verdict while the page behind it showed another, with nothing failing.
//
// This is the same shape as the test count that drifted to 847 in the one
// document nothing guarded, and the same shape as README §7 describing a
// different order than final-proof.json. Three instances is a pattern, and the
// pattern is: a number with no test is a number that will be wrong later.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCTION_STRATEGY } from "../src/research/gating.js";
import { BASELINES } from "../src/intel/baselines.js";

const root = join(import.meta.dirname, "..");
const landing = readFileSync(join(root, "web/app/page.tsx"), "utf8");

describe("the landing page quotes nothing it typed by hand", () => {
  it("imports the strategy constant the gate reads", () => {
    expect(landing).toMatch(/import \{ PRODUCTION_STRATEGY \} from "@rivo\/research\/gating\.js"/);
  });

  it("renders the AUC from that constant, not as a literal", () => {
    expect(landing).toMatch(/PRODUCTION_STRATEGY\.auc/);
    expect(landing, "the AUC is hardcoded again").not.toContain(String(PRODUCTION_STRATEGY.auc));
  });

  it("renders the return on stake from that constant, not as a literal", () => {
    expect(landing).toMatch(/PRODUCTION_STRATEGY\.returnOnStake/);
    // Both spellings, because the page renders a typographic minus and a
    // keyboard hyphen is what somebody would actually type.
    const asWritten = Math.abs(PRODUCTION_STRATEGY.returnOnStake * 100).toFixed(2);
    expect(landing, "the return on stake is hardcoded again").not.toContain(`−${asWritten}%`);
    expect(landing, "the return on stake is hardcoded again").not.toContain(`-${asWritten}%`);
  });

  it("renders the verdict from that constant, not as a literal", () => {
    expect(landing).toMatch(/PRODUCTION_STRATEGY\.state/);
  });

  it("counts the strategies rather than asserting a number", () => {
    // "seven strategies" would be wrong the moment a baseline is added or
    // removed, and nothing outside this file would notice.
    expect(landing).toMatch(/BASELINES\.length/);
    expect(landing, "the strategy count is hardcoded").not.toMatch(/\b(six|seven|eight) strategies\b/i);
  });
});

describe("what the front door leads with", () => {
  it("does not open on the rejection", () => {
    // The finding stays on the page. It stops being the first thing read.
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(landing)?.[1] ?? "";
    expect(h1).not.toMatch(/reject/i);
    expect(h1).not.toMatch(/fail/i);
    const lede = /className="lede"[^>]*>([\s\S]*?)<\/p>/.exec(landing)?.[1] ?? "";
    expect(lede.length, "the lede should say what Rivo is for").toBeGreaterThan(80);
    expect(lede).not.toMatch(/REJECTED/);
  });

  it("still carries the rejection somewhere on the page", () => {
    // Moving it must not become quietly dropping it. This is the assertion that
    // keeps the reorder honest.
    expect(landing).toMatch(/PRODUCTION_STRATEGY\.state/);
    expect(landing).toMatch(/failed/);
  });

  it("keeps every claim in 'What Rivo does not claim'", () => {
    for (const claim of [
      "That its strategy is profitable",
      "That calibration predicts the future",
      "That a disagreement is a mispricing",
      "That testnet results mean mainnet results",
    ]) {
      expect(landing, `${claim} was dropped`).toContain(claim);
    }
  });

  it("links the thirty-second view that nothing used to link", () => {
    // /demo exists for "somebody with thirty seconds and no account" and was
    // reachable only by typing the URL.
    expect(landing).toMatch(/href="\/demo"/);
  });

  it("asks for no wallet", () => {
    expect(landing).not.toMatch(/connect wallet/i);
    expect(landing).toMatch(/needs a wallet to read/i);
  });
});

describe("the baselines the page counts are the ones that exist", () => {
  it("has more than one, or the sentence about a study is false", () => {
    expect(BASELINES.length).toBeGreaterThan(1);
  });
});
