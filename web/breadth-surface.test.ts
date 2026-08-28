// The study must not quietly become a leaderboard.
//
// docs/submission/judge-faq.md §2 answers "how is Rivo different from Algo
// Arena" with a commitment: there is no leaderboard, no ranking, no prize and no
// social layer here, deliberately. DreamDEX runs Algo Arena for competition and
// it is scored on volume, over spot pairs Event Contracts are not even eligible
// for — so a ranked board would be both a broken promise and a worse version of
// somebody else's product.
//
// Six strategies in one table is exactly the shape that drifts into one. A sort,
// a rank column, a "best" badge — each is one small commit, and the document
// that forbids it is in a different directory from the component that would do
// it. This is the test that makes them fail together.
//
// It also guards the measurement discipline: a return with no sample size beside
// it is the number people quote.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINES } from "../src/intel/baselines.js";

const root = join(import.meta.dirname, "..");
const breadth = readFileSync(join(root, "web/components/Breadth.tsx"), "utf8");
const faq = readFileSync(join(root, "docs/submission/judge-faq.md"), "utf8");
const agents = readFileSync(join(root, "web/app/agents/page.tsx"), "utf8");

describe("the promise in judge-faq is still the promise the UI keeps", () => {
  it("judge-faq still refuses ranking, and says so in those words", () => {
    expect(faq).toMatch(/no leaderboard, no ranking, no prize and no social layer/i);
  });

  it("the component renders no rank, score or winner column", () => {
    for (const forbidden of [/<th[^>]*>\s*rank/i, /<th[^>]*>\s*#\s*</i, /<th[^>]*>\s*score/i, /winner/i]) {
      expect(breadth, `Breadth.tsx must not render ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("does not sort the rows — registration order is not a ranking", () => {
    // `.sort(` on the strategy list is the one line that turns this table into a
    // board without anybody deciding to.
    expect(breadth).not.toMatch(/strategies[^;]*\.sort\(/);
    expect(breadth).not.toMatch(/baselines[^;]*\.sort\(/);
  });

  it("names the null hypothesis rather than hiding it", () => {
    // A study whose control is quietly dropped when it looks silly is not a
    // study. coin-flip is on the board on purpose.
    expect(BASELINES.map((b) => b.slug)).toContain("coin-flip");
  });
});

describe("a return is never shown without its sample size", () => {
  it("the table has a windows column before the return column", () => {
    const w = breadth.indexOf("<th>Windows</th>");
    const r = breadth.indexOf("<th>Return on stake</th>");
    expect(w, "Breadth.tsx should render a Windows column").toBeGreaterThan(-1);
    expect(r, "Breadth.tsx should render a Return on stake column").toBeGreaterThan(-1);
    expect(w).toBeLessThan(r);
  });

  it("says how many settled contracts a verdict needs", () => {
    expect(breadth).toMatch(/minWindows/);
  });

  it("distinguishes 'nothing settled' from 'too few to say'", () => {
    // Two different facts. Collapsing them into one dash is how "we have no
    // data" gets read as "we found nothing".
    expect(breadth).toMatch(/nothing settled/);
    expect(breadth).toMatch(/too few to say/);
  });

  it("states that every number is hypothetical", () => {
    expect(breadth).toMatch(/hypothetical/i);
  });
});

describe("the three kinds of agent stay in three sections", () => {
  it("the connected-agents table excludes Rivo's own model and its baselines", () => {
    // One table holding all three would assert a stranger's endpoint and a
    // reference strategy are the same kind of thing.
    expect(agents).toMatch(/summary\?\.baseline !== true/);
    expect(agents).toMatch(/a\.slug !== "rivo-v1"/);
  });

  it("renders the baselines through their own component", () => {
    expect(agents).toMatch(/<Breadth \/>/);
  });
});
