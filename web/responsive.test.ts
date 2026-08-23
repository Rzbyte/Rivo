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

  it("never pins a fixed height on the header", () => {
    // The header once carried `height: 56px` around a row that wraps, so at
    // 320px the wallet address and the sign-out control wrapped to a second line
    // and were clipped by the header itself — in the DOM, invisible on the
    // phone. The first fix added `height: auto` at the breakpoint; the header
    // now simply never sets a fixed height, which cannot be undone by a
    // narrower screen than anybody tested.
    const header = /header\.top \.wrap\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    let sawMinHeight = false;
    while ((m = header.exec(CSS))) {
      expect(m[1]!, "header.top .wrap must not set a fixed height").not.toMatch(/(^|;)\s*height:\s*\d/);
      if (/min-height/.test(m[1]!)) sawMinHeight = true;
    }
    expect(sawMinHeight, "the header needs a height floor").toBe(true);
  });

  it("stops the header row wrapping where it would be clipped", () => {
    expect(narrow).toMatch(/header\.top \.row\s*\{[^}]*flex-wrap:\s*nowrap/);
  });

  it("has a gutter that follows the screen rather than stepping at one width", () => {
    // The page gutter used to be a flat 20px with a narrower override at the
    // breakpoint, which is two numbers to keep in agreement and a visible jump
    // between them. One fluid value covers every width in between.
    expect(CSS).toMatch(/--pad-x:\s*clamp\(/);
    expect(CSS).toMatch(/\.wrap\s*\{[^}]*padding:[^;]*var\(--pad-x\)/);
  });

  it("gives panels less padding on a small screen", () => {
    // Panel padding is the space that costs the most at 360px, and it is fluid
    // for the same reason the gutter is.
    expect(CSS).toMatch(/\.panel\s*\{[^}]*padding:\s*clamp\(/);
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
