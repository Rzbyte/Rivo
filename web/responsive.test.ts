// Does this page work on a phone?
//
// It did not, and nothing here noticed. The app shipped with no viewport meta
// tag and no width breakpoint of any kind, so a handset laid the dashboard out
// at 980px and scaled the result down to roughly a third of legible size. Both
// halves matter and each is useless alone: the tag without the rules gives you a
// desktop layout crammed into 380px, and the rules without the tag never fire,
// because the browser never reports the real width.
//
// These assertions are deliberately about the CONTRACT rather than the exact
// values. A breakpoint moving from 640 to 700 is a design decision; a breakpoint
// disappearing is a regression, and it is the kind that nobody sees on a laptop.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSS = readFileSync(resolve("web/app/globals.css"), "utf8");
const LAYOUT_RAW = readFileSync(resolve("web/app/layout.tsx"), "utf8");

/**
 * The file with its comments removed.
 *
 * The first version of the zoom-lock assertion below searched the whole file and
 * matched the sentence in the source explaining why zoom is NOT locked — a test
 * that fails precisely because somebody documented the right decision. An
 * assertion about code has to read code.
 */
const LAYOUT = LAYOUT_RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The body of every `@media` block whose condition matches. */
function mediaBlocks(match: RegExp): string[] {
  const out: string[] = [];
  const re = /@media([^{]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    if (!match.test(m[1]!)) continue;
    let depth = 1;
    let i = re.lastIndex;
    for (; i < CSS.length && depth > 0; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}") depth--;
    }
    out.push(CSS.slice(re.lastIndex, i - 1));
  }
  return out;
}

describe("the viewport tag", () => {
  it("exists, because without it none of the CSS below runs", () => {
    expect(LAYOUT).toMatch(/export const viewport/);
    expect(LAYOUT).toMatch(/width:\s*["']device-width["']/);
    expect(LAYOUT).toMatch(/initialScale:\s*1/);
  });

  it("does not lock zoom", () => {
    // The usual companion to the tag, and it takes pinch-to-zoom from the people
    // who most need it. The iOS focus-zoom it is normally used to suppress is
    // fixed properly, by sizing inputs at 16px.
    expect(LAYOUT).not.toMatch(/maximumScale/);
    expect(LAYOUT).not.toMatch(/userScalable/);
  });
});

describe("small screens", () => {
  const narrow = mediaBlocks(/max-width/).join("\n");

  it("has a width breakpoint at all", () => {
    expect(mediaBlocks(/max-width/).length).toBeGreaterThan(0);
  });

  it("collapses the two-column grid instead of overflowing it", () => {
    // `.cols-2` reserves a 300px track. On a 360px handset, minus two 14px
    // gutters, that fits once and only once — auto-fit gives one column but
    // still reserves the track, so the panel overflows by the difference.
    expect(narrow).toMatch(/\.cols-2\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  it("stacks the decision row rather than squeezing prices to nothing", () => {
    expect(narrow).toMatch(/\.decision\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  it("does not clip the header when its contents no longer fit", () => {
    // The header pinned a 56px height around a row that wraps, so on a 320px
    // screen the wallet address and the sign-out control wrapped onto a second
    // line and were cut off by the header — in the DOM, invisible on the phone.
    expect(narrow).toMatch(/header\.top \.wrap\s*\{[^}]*height:\s*auto/);
    expect(narrow).toMatch(/header\.top \.wrap\s*\{[^}]*min-height/);
    expect(narrow).toMatch(/header\.top \.row\s*\{[^}]*flex-wrap:\s*nowrap/);
  });

  it("shrinks the padding that costs the most at 360px", () => {
    expect(narrow).toMatch(/\.wrap\s*\{[^}]*padding:/);
    expect(narrow).toMatch(/\.panel\s*\{[^}]*padding:/);
  });
});

describe("the product surfaces on a phone", () => {
  const read = (p: string): string => readFileSync(resolve(p), "utf8");
  const PAGES = ["markets", "calibration", "agents", "proof"] as const;

  it("puts every wide table in its own scroll container", () => {
    // The page body must never scroll sideways. A table that does it inside its
    // own box is fine; a table that does it to the document is not.
    for (const page of PAGES) {
      const src = read(`web/app/${page}/page.tsx`);
      const tables = (src.match(/<table>/g) ?? []).length;
      const scrolls = (src.match(/className="scroll"/g) ?? []).length;
      expect(scrolls, `${page}: ${tables} table(s), ${scrolls} scroll container(s)`).toBeGreaterThanOrEqual(tables);
    }
  });

  it("drops supporting columns rather than scrolling the answer off screen", () => {
    // A dense table on a phone can scroll — and then the comparison the table
    // exists to show is the part that scrolled away.
    expect(CSS).toMatch(/@media[^{]*max-width[\s\S]*?\.hide-sm\s*\{[^}]*display:\s*none/);
    for (const page of ["calibration", "agents", "proof"] as const) {
      expect(read(`web/app/${page}/page.tsx`), page).toMatch(/hide-sm/);
    }
  });

  it("leads a market card with its one comparison, not a list of six equals", () => {
    // The card answers one question: what is asked, against what comparable
    // contracts actually did. Six equal-weight rows is a table of contents.
    const src = read("web/app/markets/page.tsx");
    expect(src).toMatch(/className="compare"/);
    expect(src).toMatch(/className="big"/);
    // And the gap is drawn as well as printed — a distance a reader can see
    // rather than a subtraction they have to do.
    expect(src).toMatch(/className="scale"/);
    expect(CSS).toMatch(/\.scale \.span\s*\{/);
  });

  it("encodes assessment state in form, not only in words", () => {
    // A screen of cards has to be scannable without reading any of them.
    expect(CSS).toMatch(/\.verdict\.claim\s*\{/);
    expect(CSS).toMatch(/\.verdict\.caution\s*\{/);
    expect(read("web/app/markets/page.tsx")).toMatch(/className=\{`verdict/);
  });

  it("shrinks the comparison headline before it reaches the screen edge", () => {
    const narrow = mediaBlocks(/max-width/).join("\n");
    expect(narrow).toMatch(/\.compare \.big\s*\{[^}]*font-size/);
  });
});

describe("a page states its answer before its working", () => {
  const read = (p: string): string => readFileSync(resolve(p), "utf8");

  /** Blocks that occupy the column on first sight, before anything is opened. */
  const stacked = (page: string): number => {
    const src = read(`web/app/${page}/page.tsx`);
    // Anything inside a Reveal is one row until a reader asks for it.
    const withoutReveals = src.replace(/<Reveal[\s\S]*?<\/Reveal>/g, "<Reveal/>");
    return (withoutReveals.match(/className="sec-head"/g) ?? []).length
      + (withoutReveals.match(/className="panel/g) ?? []).length;
  };

  it("keeps the Agents page from being an endless column", () => {
    // It reached twenty-six stacked blocks — seven headings, thirteen panels,
    // four tables — because every section this product grew was appended and
    // nobody decided what belongs on first sight.
    expect(stacked("agents")).toBeLessThanOrEqual(12);
  });

  it("keeps Proof and Calibration to a readable column too", () => {
    expect(stacked("proof")).toBeLessThanOrEqual(10);
    expect(stacked("calibration")).toBeLessThanOrEqual(6);
  });

  it("hides nothing — the working is one click away, not gone", () => {
    // A judge checking the arithmetic must still reach the fold table, the edge
    // buckets, the gate's reasons and the methodology.
    const agents = read("web/app/agents/page.tsx");
    for (const t of ["Fold by fold", "Claimed edge against realised", "Why the gate refused it"]) {
      expect(agents, t).toContain(t);
    }
    expect(read("web/app/calibration/page.tsx")).toContain("How this is measured");
    expect(read("web/app/proof/page.tsx")).toContain("Every transaction");
  });

  it("leaves the thesis on the page rather than behind a control", () => {
    // The verdict, the loop and the live comparison are the argument. Only the
    // working folds.
    const proof = read("web/app/proof/page.tsx");
    const loop = proof.slice(proof.indexOf("<h2>The loop</h2>"));
    expect(loop).not.toMatch(/^[\s\S]{0,200}<Reveal/);
    expect(read("web/app/agents/page.tsx")).toMatch(/Economic quality[\s\S]{0,400}Verdict/);
  });

  it("gives a disclosure a label worth pressing", () => {
    // A row that says only "details" is a row nobody opens.
    const css = read("web/app/globals.css");
    expect(css).toMatch(/\.reveal > summary::before/);
    expect(css).toMatch(/\.reveal\[open\] > summary::before[^}]*rotate/);
    expect(read("web/components/Reveal.tsx")).toMatch(/hint\?: string/);
  });
});

describe("touch", () => {
  const coarse = mediaBlocks(/pointer:\s*coarse/).join("\n");

  it("keys off the pointer, not the width", () => {
    // A tablet in landscape is wider than the breakpoint and still a finger.
    expect(mediaBlocks(/pointer:\s*coarse/).length).toBeGreaterThan(0);
  });

  it("gives buttons a real target", () => {
    const m = /min-height:\s*(\d+)px/.exec(coarse);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(44);
  });

  it("sizes inputs at 16px so Safari does not zoom the page on focus", () => {
    // Under 16px, iOS enlarges the whole page when a field takes focus and does
    // not restore it. Every field inherited the 15px body size, so the first tap
    // on the budget box left the page zoomed and scrolling sideways — which
    // reads as a broken layout, not as a zoom.
    expect(coarse).toMatch(/input[^{]*\{[^}]*font-size:\s*16px/);
  });
});

describe("things that overflow sideways", () => {
  it("lets every table scroll inside its own container", () => {
    expect(CSS).toMatch(/\.scroll\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("scrolls the tab strip rather than wrapping it to two rows", () => {
    expect(CSS).toMatch(/\.tabs\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("opts out of iOS text inflation on rotation", () => {
    expect(CSS).toMatch(/-webkit-text-size-adjust:\s*100%/);
  });
});
