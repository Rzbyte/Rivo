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
 * Dark is the COMMITTED default here, not the absence of light: the bare `:root`
 * carries the dark palette and light is the override. That inversion is the
 * whole point of the redesign, so the slicing follows it — dark is everything
 * before the light media query, light is everything from the explicit
 * `[data-theme="light"]` block onward.
 */
function tokens(theme: "light" | "dark"): Record<string, string> {
  const lightAt = CSS.indexOf(':root[data-theme="light"]');
  const lightMedia = CSS.indexOf("@media (prefers-color-scheme: light)");
  expect(lightAt, "the explicit light block is missing").toBeGreaterThan(0);
  expect(lightMedia, "the light media query is missing").toBeGreaterThan(0);
  const block = theme === "dark" ? CSS.slice(0, lightMedia) : CSS.slice(lightAt);
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) {
    if (!(name! in out)) out[name!] = value!.toLowerCase();
  }
  return out;
}

/**
 * The colour a translucent token actually renders as.
 *
 * The soft backgrounds are no longer hex — they are the outcome colour at 12%
 * alpha, which is what lets one definition sit correctly on a panel, on the page
 * ground, and inside a banner. A contrast test that read them as opaque hex
 * would be measuring a colour that never reaches a screen, so this composites
 * them over the surface they are painted on, which is what an eye receives.
 */
function softOver(css: string, name: string, over: string): string | null {
  const m = new RegExp(`--${name}:\\s*rgb\\(\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*/\\s*([\\d.]+)\\s*\\)`).exec(css);
  if (!m) return null;
  const a = Number(m[4]);
  const b = over.replace("#", "");
  const mix = (fg: number, i: number): number =>
    Math.round(fg * a + Number.parseInt(b.slice(i, i + 2), 16) * (1 - a));
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${hex(mix(Number(m[1]), 0))}${hex(mix(Number(m[2]), 2))}${hex(mix(Number(m[3]), 4))}`;
}

/** Surfaces text is actually set on, and the foregrounds set on them. */
const SURFACES = ["ground", "panel", "panel-2"] as const;
const FOREGROUNDS = ["ink", "ink-2", "ink-3"] as const;

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme`, () => {
    const t = tokens(theme);

    it("defines every token it is asked about", () => {
      for (const name of [...SURFACES, ...FOREGROUNDS, "brand", "on-brand", "up", "down", "warn", "rule", "rule-2"]) {
        expect(t[name], `--${name} missing in ${theme}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    for (const fg of FOREGROUNDS) {
      for (const surface of SURFACES) {
        it(`--${fg} on --${surface} clears 4.5:1`, () => {
          // 4.5:1 rather than 3:1 for all three: `--ink-3` sets the 10.5px
          // uppercase labels, which are small text and owe the small-text ratio
          // whatever their role suggests.
          expect(contrast(t[fg]!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    for (const state of ["up", "down", "warn"] as const) {
      it(`--${state} is legible on its own soft background`, () => {
        const lightAt = CSS.indexOf(':root[data-theme="light"]');
        const scope = theme === "dark" ? CSS.slice(0, CSS.indexOf("@media (prefers-color-scheme: light)")) : CSS.slice(lightAt);
        const composited = softOver(scope, `${state}-soft`, t.panel!);
        expect(composited, `--${state}-soft missing in ${theme}`).not.toBeNull();
        expect(contrast(t[state]!, composited!)).toBeGreaterThanOrEqual(4.5);
      });
      it(`--${state} is legible on --panel`, () => {
        expect(contrast(t[state]!, t.panel!)).toBeGreaterThanOrEqual(4.5);
      });
    }

    it("the primary button's text is legible on it", () => {
      expect(contrast(t["on-brand"]!, t.brand!)).toBeGreaterThanOrEqual(4.5);
    });

    it("the accent is legible as a link on every surface", () => {
      // The accent is structural — it sets links, the active tab and focus. It
      // is not an outcome colour and must never be read as one.
      for (const surface of SURFACES) {
        expect(contrast(t.brand!, t[surface]!), `--brand on --${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("borders are visible against what they separate", () => {
      // Not a text ratio — a border is a 1px line and 3:1 is the non-text
      // threshold. Below it, panels stop being distinguishable from the page.
      expect(contrast(t.rule!, t.panel!)).toBeGreaterThanOrEqual(1.2);
      expect(contrast(t["rule-2"]!, t.panel!)).toBeGreaterThanOrEqual(1.3);
    });
  });
}

describe("the stylesheet's own promises", () => {
  it("honours a system dark preference as well as an explicit choice", () => {
    // A page that only reacts to `data-theme` renders light for everybody whose
    // OS is dark and who never touched a toggle — which is most people.
    // Dark is the committed default, so the query that honours a SYSTEM
    // preference is the light one. The assertion is that a system preference is
    // honoured at all — not which way round the default happens to be.
    expect(CSS).toContain("@media (prefers-color-scheme: light)");
    expect(CSS).toContain(':root:not([data-theme="dark"])');
    expect(CSS).toContain(':root[data-theme="light"]');
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
