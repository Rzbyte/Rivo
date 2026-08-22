// The palette, checked rather than eyeballed.
//
// The same arithmetic as src/public/palette.test.ts, applied to the web app's
// stylesheet, because the two surfaces share a palette and a claim: every
// foreground is legible against every surface it is used on, in both themes.
//
// The original test earned its place by catching `--faint` at 3.02:1 in light
// mode while setting 10.5px uppercase labels — the "it's only a label" instinct
// is exactly how the least readable text on a page ends up being the text that
// tells you what you are looking at.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSS = readFileSync(resolve("web/app/globals.css"), "utf8");

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channel = (i: number): number => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pull the tokens out of one theme's block.
 *
 * Light is defined on bare `:root`; dark is redefined under
 * `:root[data-theme="dark"]`, so slicing at that selector separates them without
 * needing a CSS parser.
 */
function tokens(theme: "light" | "dark"): Record<string, string> {
  const darkAt = CSS.indexOf(':root[data-theme="dark"]');
  expect(darkAt).toBeGreaterThan(0);
  const block = theme === "light" ? CSS.slice(0, CSS.indexOf("@media (prefers-color-scheme: dark)")) : CSS.slice(darkAt);
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) {
    if (!(name! in out)) out[name!] = value!.toLowerCase();
  }
  return out;
}

/** Surfaces text is actually set on, and the foregrounds set on them. */
const SURFACES = ["bg", "panel", "panel-2"] as const;
const FOREGROUNDS = ["ink", "muted", "faint"] as const;

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme`, () => {
    const t = tokens(theme);

    it("defines every token it is asked about", () => {
      for (const name of [...SURFACES, ...FOREGROUNDS, "accent", "accent-ink", "pos", "neg", "warn", "line", "line-2"]) {
        expect(t[name], `--${name} missing in ${theme}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    for (const fg of FOREGROUNDS) {
      for (const surface of SURFACES) {
        it(`--${fg} on --${surface} clears 4.5:1`, () => {
          // 4.5:1 rather than 3:1 for all three: `--faint` sets the 10.5px
          // uppercase labels, which are small text and owe the small-text ratio
          // whatever their role suggests.
          expect(contrast(t[fg]!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    for (const state of ["pos", "neg", "warn"] as const) {
      it(`--${state} is legible on its own soft background`, () => {
        expect(contrast(t[state]!, t[`${state}-soft`]!)).toBeGreaterThanOrEqual(4.5);
      });
      it(`--${state} is legible on --panel`, () => {
        expect(contrast(t[state]!, t.panel!)).toBeGreaterThanOrEqual(4.5);
      });
    }

    it("the primary button's text is legible on it", () => {
      expect(contrast(t["accent-ink"]!, t.accent!)).toBeGreaterThanOrEqual(4.5);
    });

    it("borders are visible against what they separate", () => {
      // Not a text ratio — a border is a 1px line and 3:1 is the non-text
      // threshold. Below it, panels stop being distinguishable from the page.
      expect(contrast(t.line!, t.panel!)).toBeGreaterThanOrEqual(1.2);
      expect(contrast(t["line-2"]!, t.panel!)).toBeGreaterThanOrEqual(1.3);
    });
  });
}

describe("the stylesheet's own promises", () => {
  it("honours a system dark preference as well as an explicit choice", () => {
    // A page that only reacts to `data-theme` renders light for everybody whose
    // OS is dark and who never touched a toggle — which is most people.
    expect(CSS).toContain("@media (prefers-color-scheme: dark)");
    expect(CSS).toContain(':root[data-theme="dark"]');
  });

  it("never removes a focus ring", () => {
    // A keyboard user who cannot see where they are cannot use the product, and
    // `outline: none` is the single most common way to do that to them.
    expect(CSS).not.toMatch(/outline:\s*(none|0)\s*;/);
    expect(CSS).toContain(":focus-visible");
  });

  it("respects a request for less motion", () => {
    expect(CSS).toContain("prefers-reduced-motion");
  });

  it("gives wide content its own scroll rather than the page", () => {
    // Tables of decisions and transactions are wide. If they scroll the body,
    // the whole page moves sideways on a phone.
    expect(CSS).toMatch(/\.scroll\s*\{\s*overflow-x:\s*auto/);
  });
});
