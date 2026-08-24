// The old address has to land somewhere useful, not nowhere.
//
// rzbyte.github.io/Rivo served a second, self-contained Rivo with its own
// identity. Retiring it was right; disabling GitHub Pages to do it would not
// have been — the README links that address, and so may a submission, a message
// or somebody's bookmark. Turning a working link into a 404 to fix a positioning
// problem trades one bad outcome for a worse one.
//
// So it redirects, and these assert the redirect is real: a meta refresh that
// actually names the product, a link that works when the refresh does not, and a
// workflow that no longer publishes the bundle it used to.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string): string => readFileSync(resolve(p), "utf8");

/**
 * A file with its comments removed.
 *
 * Twice now a rule about shipped content has failed on the note explaining that
 * rule — the note has to name the thing it forbids in order to explain it. The
 * assertion is about what the file does, not about the sentence recording why.
 */
const body = (p: string): string =>
  read(p)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*#.*$/gm, "");

const PRODUCT = "https://rivo-autopilot.vercel.app/";

describe("the retired Pages address", () => {
  it("redirects to the product", () => {
    const html = read("pages/index.html");
    expect(html).toMatch(new RegExp(`http-equiv="refresh"[^>]*${PRODUCT.replace(/[./]/g, "\\$&")}`));
    expect(html).toContain(`<link rel="canonical" href="${PRODUCT}">`);
  });

  it("still works with the refresh blocked", () => {
    // A page that says "redirecting…" and nothing else is a dead end for anyone
    // whose browser, extension or reader stops the refresh.
    const html = body("pages/index.html");
    expect(html).toContain(`href="${PRODUCT}"`);
    expect(html).not.toMatch(/redirecting…|please wait/i);
    // It has to explain itself, because arriving somewhere that only bounces you
    // tells you nothing about what happened to what you were looking for.
    expect(html).toMatch(/has moved/i);
  });

  it("carries no trace of the retired identity", () => {
    const html = read("pages/index.html").toLowerCase();
    for (const phrase of ["autonomous portfolio manager", "turns dreamdex bots into a portfolio"]) {
      expect(html, `the redirect still says "${phrase}"`).not.toContain(phrase);
    }
  });

  it("renders on either theme and paints its own ground", () => {
    // It is one file with no stylesheet to fall back on, so a missing background
    // means the host's theme shows through and half the text disappears.
    const css = read("pages/index.html");
    expect(css).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain('[data-theme="dark"]');
  });

  it("no longer publishes the second product", () => {
    const wf = body(".github/workflows/pages.yml");
    // The upload must point at the redirect, not at the built bundle.
    expect(wf).toMatch(/path:\s*pages\s*$/m);
    expect(wf).not.toMatch(/path:\s*public\s*$/m);
    // And it must not rebuild it, which is the step that used to take a minute
    // of every push to publish a contradiction.
    expect(wf).not.toContain("build:public");
  });
});

describe("what the browser bundle is now", () => {
  it("is described as a portability proof rather than a live site", () => {
    // `npm run build:public` and boot.test.ts stay: the pricing engine running
    // in a browser with no Node is a real property worth testing. What changed
    // is that it is not a second product with its own address.
    const readme = read("README.md");
    expect(readme).toContain("## The browser bundle");
    expect(readme).not.toContain("## The public page");
    const section = readme.slice(readme.indexOf("## The browser bundle"));
    expect(section.slice(0, 1200)).toMatch(/portability proof|not a second product/);
    // The old address is named as redirecting, not as somewhere to go.
    expect(section.slice(0, 1200)).toMatch(/used to serve|redirects/);
  });
});
