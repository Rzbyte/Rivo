// One way for every page to stay current.
//
// Each surface had grown its own answer: Markets polled on a bare interval,
// Agents polled only its shadow table, Calibration and Proof fetched once on
// mount and then showed whatever had been true when the tab opened. A page
// about a live venue that stops moving is a screenshot, and a reader has no way
// to tell the difference.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ago } from "./lib/live.js";

const read = (p: string): string => readFileSync(resolve(p), "utf8");
const PAGES = ["markets", "calibration", "agents", "proof"] as const;

describe("every surface refreshes itself", () => {
  for (const page of PAGES) {
    it(`${page} uses the shared live hook`, () => {
      const src = read(`web/app/${page}/page.tsx`);
      expect(src).toMatch(/useLive</);
    });

    it(`${page} tells the reader how fresh the data is`, () => {
      // The only honest way to render data that might be old.
      expect(read(`web/app/${page}/page.tsx`)).toMatch(/ago\(/);
    });
  }

  it("no page still fetches once and stops", () => {
    for (const page of PAGES) {
      const src = read(`web/app/${page}/page.tsx`);
      // A bare useEffect(() => { fetch(...) }, []) is the shape that produced a
      // screenshot of a live venue.
      expect(src, page).not.toMatch(/useEffect\(\(\) => \{\s*fetch\(/);
    }
  });
});

describe("the hook", () => {
  const SRC = read("web/lib/live.ts");

  it("stops polling when the tab is hidden", () => {
    // A background tab hitting a venue's indexer every five seconds for an
    // afternoon is somebody else's bill.
    expect(SRC).toMatch(/visibilitychange/);
    expect(SRC).toMatch(/visibilityState === "visible"/);
  });

  it("catches up on return instead of waiting out the interval", () => {
    const onVis = SRC.slice(SRC.indexOf("const onVisibility"), SRC.indexOf("void load();\n    if (document"));
    expect(onVis).toMatch(/void load\(\)/);
  });

  it("discards a slow response that lost the race", () => {
    // Otherwise an earlier poll landing late puts older data on the screen.
    expect(SRC).toMatch(/seq\.current/);
    expect(SRC).toMatch(/if \(mine !== seq\.current\) return/);
  });

  it("removes its listener and its timer on unmount", () => {
    expect(SRC).toMatch(/removeEventListener\("visibilitychange"/);
    expect(SRC).toMatch(/clearInterval\(timer\)/);
  });

  it("asks for no cache, so a poll is a poll", () => {
    expect(SRC).toMatch(/cache: "no-store"/);
  });
});

describe("freshness in words", () => {
  const now = 1_000_000_000_000;
  it("says never before the first load", () => {
    expect(ago(0, now)).toBe("never");
  });
  it("reads naturally at every scale", () => {
    expect(ago(now - 500, now)).toBe("just now");
    expect(ago(now - 4_000, now)).toBe("4s ago");
    expect(ago(now - 90_000, now)).toBe("1m ago");
    expect(ago(now - 7_200_000, now)).toBe("2h ago");
  });
  it("never reports a negative age from a clock that is slightly ahead", () => {
    expect(ago(now + 5_000, now)).toBe("just now");
  });
});

describe("the cache does not outlive the poll", () => {
  it("keeps the markets TTL under the page's interval", () => {
    // A longer cache would make half the polls return the same snapshot — a
    // live surface that is only live every other request.
    const ttl = Number(/TTL_MS = ([\d_]+)/.exec(read("web/app/api/markets/route.ts"))![1]!.replace(/_/g, ""));
    const every = Number(/useLive<Payload>\("\/api\/markets", ([\d_]+)\)/.exec(read("web/app/markets/page.tsx"))![1]!.replace(/_/g, ""));
    expect(ttl).toBeLessThanOrEqual(every);
  });
});
