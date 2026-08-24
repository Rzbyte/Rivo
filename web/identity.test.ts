// What the product says it is, in the places nobody looks at twice.
//
// The page bodies had been rewritten for the pivot. The <title>, the meta
// description and the link-preview card had not, so the tab, the search result
// and every shared link still advertised "autonomous portfolio manager" — the
// product Rivo deliberately stopped being. Nothing was broken and nothing threw;
// a stale title renders perfectly.
//
// So the identity is pinned against the README, which is the document a human
// keeps current. If the positioning changes, this fails until the metadata
// follows it — in either direction.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const read = (p: string): string => readFileSync(resolve(p), "utf8");

/**
 * Source with its comments removed.
 *
 * The first version of this asserted on the raw file and failed on the note
 * above the fix, which names the retired phrase in order to explain it. The
 * rule is about copy the product ships, not about the sentence recording why
 * that copy changed — and a rule that forbids writing down what went wrong is a
 * rule that guarantees the next person repeats it.
 */
const copy = (p: string): string =>
  read(p)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .toLowerCase();

/** The product's own one-line positioning, from the README's opening claim. */
const positioning = (): string => {
  const claim = read("README.md").match(/^\*\*(.+?)\*\*$/m)?.[1];
  expect(claim, "README no longer opens with a bold positioning line").toBeTruthy();
  return (claim ?? "").toLowerCase();
};

const metadataOf = (file: string): string => {
  const src = read(file);
  const start = src.indexOf("export const metadata");
  expect(start, `${file} declares no metadata`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n};", start));
};

describe("the shipped identity", () => {
  it("names the product the README describes", () => {
    const meta = metadataOf("web/app/layout.tsx");
    const title = meta.match(/title:\s*"([^"]+)"/)?.[1] ?? "";
    expect(title, "no title in layout metadata").not.toBe("");

    // Every substantive word of the title has to appear in the README's own
    // claim. Stopwords are dropped so wording may differ; subject may not.
    const stop = new Set(["rivo", "for", "and", "the", "a", "an", "of", "to", "on", "in"]);
    const words = title.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w && !stop.has(w));
    const claim = positioning();
    for (const w of words) {
      expect(claim, `the title says "${w}" and the README does not`).toContain(w);
    }
  });

  it("does not advertise the product Rivo stopped being", () => {
    // The specific phrases the pivot retired. Listed rather than inferred,
    // because a general rule would not have caught these and did not.
    const retired = ["autonomous portfolio manager", "set a budget and a risk profile", "while you are offline"];
    for (const file of ["web/app/layout.tsx", "web/app/page.tsx"]) {
      const src = copy(file);
      for (const phrase of retired) {
        expect(src, `${file} still carries "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it("defines the title exactly once", () => {
    // The stale title survived a pivot because the landing page overrode it and
    // looked correct, while every other route inherited the fallback and did
    // not. Two definitions that agree today is how the first one got stale.
    const owners = execSync("git ls-files web/app", { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".tsx") && existsSync(resolve(f)) && /export const metadata/.test(read(f)));
    expect(owners.length, "found no metadata at all — did the glob stop matching?").toBeGreaterThan(0);
    expect(owners, "more than one file declares page metadata").toEqual(["web/app/layout.tsx"]);
  });

  it("carries the same identity into a link preview", () => {
    // A submission is shared as a link before it is opened as a page, and the
    // card is built from openGraph when it exists and from nothing when it does
    // not — the one context where a fixed <title> would not have reached.
    const meta = metadataOf("web/app/layout.tsx");
    expect(meta).toContain("openGraph");
    const og = meta.slice(meta.indexOf("openGraph"));
    expect(og.match(/title:\s*"([^"]+)"/)?.[1]).toBe(meta.match(/title:\s*"([^"]+)"/)?.[1]);
    expect(og).toMatch(/description:\s*\n?\s*"/);
  });

  it("keeps the legacy page from claiming to be the product", () => {
    // public/index.html is the portfolio layer, shadow-traded in the browser.
    // It is allowed to argue the portfolio case — that is what its body does —
    // but not to present itself as Rivo's whole identity.
    const html = copy("public/index.html");
    expect(html).not.toContain("autonomous portfolio manager");
    expect(html).toContain("<title>");
  });
});
