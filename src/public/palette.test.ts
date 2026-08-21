// The palette, checked rather than eyeballed.
//
// Contrast is the one part of visual design that is arithmetic, so there is no
// excuse for shipping it on judgement. This reads the tokens out of the actual
// stylesheet — not a copy kept in a test — and computes WCAG 2.1 ratios for
// every foreground against every surface, in both themes.
//
// It caught a real failure the moment it was written: `--faint` sat at 3.02:1
// in light mode, which is fine for large text and is not what it is used for.
// It sets 10.5px uppercase labels — column heads, stat keys, field labels — so
// it owes 4.5:1 like any other small text. The "it's only a label" instinct is
// exactly how the least readable text on a page ends up being the text that
// tells you what you are looking at.
//
// Tuned only in lightness, so the palette keeps its warmth rather than being
// flattened toward grey to satisfy a number.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSS = readFileSync(resolve("public/index.html"), "utf8");

/** Relative luminance, per WCAG 2.1. */
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
 * Pull one token out of a block of the stylesheet.
 *
 * The light theme is defined on bare `:root` and the dark theme is redefined
 * under `:root[data-theme="dark"]`, so slicing at that selector separates them
 * without needing a CSS parser.
 */
function tokens(theme: "light" | "dark"): Record<string, string> {
  const darkAt = CSS.indexOf(':root[data-theme="dark"]');
  expect(darkAt).toBeGreaterThan(0);
  const block = theme === "light" ? CSS.slice(0, CSS.indexOf("@media (prefers-color-scheme: dark)")) : CSS.slice(darkAt);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (!(m[1]! in out)) out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

/** Every colour that carries text, and every surface it is set on. */
const FOREGROUNDS = ["ink", "muted", "faint", "accent", "pos", "neg", "warn"] as const;
const SURFACES = ["bg", "panel", "panel-2"] as const;

describe.each(["light", "dark"] as const)("the %s palette is readable", (theme) => {
  const t = tokens(theme);

  it("defines every token it is asked about", () => {
    for (const k of [...FOREGROUNDS, ...SURFACES]) expect(t[k], `--${k} in ${theme}`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(FOREGROUNDS)("sets %s to at least 4.5:1 on every surface", (fg) => {
    for (const surface of SURFACES) {
      const ratio = contrast(t[fg]!, t[surface]!);
      // 4.5:1 is the AA threshold for text below 18.66px, which is all of it —
      // the labels this palette's lightest colour is used for are 10.5px.
      expect(ratio, `--${fg} on --${surface} in ${theme} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the accent legible when it is a fill rather than ink", () => {
    // The primary button paints accent-ink on accent. That pairing is inverted
    // from every other one here, so it is the one most easily broken by
    // adjusting the accent alone.
    const ratio = contrast(t["accent-ink"]!, t.accent!);
    expect(ratio, `accent-ink on accent in ${theme} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it("separates the surfaces from each other enough for a hairline to read", () => {
    // Depth in this design comes from rules rather than shadows, so a border
    // that cannot be told from what it borders removes the only cue there is.
    expect(contrast(t.line!, t.bg!)).toBeGreaterThanOrEqual(1.2);
    expect(contrast(t["line-2"]!, t.panel!)).toBeGreaterThanOrEqual(1.3);
  });
});

describe("the two themes stay in step", () => {
  it("defines the same tokens in both", () => {
    const light = Object.keys(tokens("light")).sort();
    const dark = Object.keys(tokens("dark")).sort();
    // A token defined in one theme only renders as whatever the other theme
    // left behind — usually the light value on a dark ground, which is exactly
    // the invisible-text bug that is hardest to notice on the machine that
    // shipped it.
    for (const k of dark) expect(light, `--${k} is defined in dark but not light`).toContain(k);
  });
});
