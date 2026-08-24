// Rivo publishes exactly one web surface.
//
// It used to publish two. rzbyte.github.io/Rivo served a self-contained Rivo
// with its own identity and its own hero, which was true while it was the only
// surface and became a contradiction the moment the product moved to
// intelligence and validation on Vercel. A judge could reach either one and get
// a different answer to "what is this".
//
// Retiring it was a positioning decision, not a cleanup: the code that built it
// stays, because the pricing engine running in a browser with no Node and no
// backend is a real property and boot.test.ts proves it by booting the shipped
// bundle in a DOM. What is gone is the second address.
//
// These assert it stays gone. Adding a second deploy target is a two-line
// workflow and an easy thing to do without noticing it recreates the problem.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const read = (p: string): string => readFileSync(resolve(p), "utf8");

/** File contents with comments stripped — the rule is about what ships, not the note explaining it. */
const body = (p: string): string =>
  read(p)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*#.*$/gm, "");

const workflows = (): string[] =>
  execSync("git ls-files .github/workflows", { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && existsSync(resolve(f)));

describe("one web surface", () => {
  it("has no workflow that publishes a second site", () => {
    for (const wf of workflows()) {
      const src = body(wf);
      expect(src, `${wf} deploys to GitHub Pages`).not.toMatch(/deploy-pages|upload-pages-artifact|configure-pages/);
    }
  });

  it("carries no redirect stub waiting to be re-published", () => {
    expect(existsSync(resolve("pages")), "the pages/ directory is back").toBe(false);
    expect(existsSync(resolve(".github/workflows/pages.yml")), "pages.yml is back").toBe(false);
  });

  it("points readers at the one deployment", () => {
    const readme = read("README.md");
    // The retired address must not be offered as somewhere to go: it no longer
    // resolves, and a dead link in the first document a judge opens is worse
    // than no link.
    expect(readme, "README still links the retired Pages address").not.toContain("rzbyte.github.io");
    expect(readme).toContain("rivo-autopilot.vercel.app");
  });

  it("counts the same sections the nav does", () => {
    // The nav gained /evidence and the README kept saying "four surfaces", which
    // is the drift a reader notices before anybody else does: the document
    // introducing the product disagreed with the product about how many parts it
    // has. Derived from the nav rather than from a number typed twice.
    const nav = read("web/components/Nav.tsx");
    const block = nav.slice(nav.indexOf("const SECTIONS"), nav.indexOf("] as const"));
    const count = (block.match(/\["\//g) ?? []).length;
    expect(count, "no sections found — did SECTIONS move?").toBeGreaterThan(3);
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    const readme = read("README.md");
    // Case-insensitive: it opens a sentence, so it is capitalised there.
    expect(readme.toLowerCase(), `the nav has ${count} sections`).toContain(`${words[count]} surfaces`);
    // Every one of them has a numbered heading of its own.
    for (let i = 1; i <= count; i++) expect(readme, `section ${i}`).toMatch(new RegExp(`^### ${i} · `, "m"));
  });

  it("quotes calibration figures that match the artefact they came from", () => {
    // The headline calibration result is recomputed by the worker every few
    // hours, so the README quotes a stored snapshot and says so. What it must
    // not do is drift from the file it claims to be quoting.
    const cal = JSON.parse(read("docs/evidence/calibration-report.json")) as {
      generatedAt: string;
      window: { windows: number; brier: number; brierBase: number; skill: number };
    };
    const w = cal.window;
    const section = read("README.md");
    const body = section.slice(section.indexOf("### 2 · Calibration"), section.indexOf("### 3 · Agents"));
    expect(body, "window count").toContain(w.windows.toLocaleString("en-US"));
    expect(body, "brier").toContain(w.brier.toFixed(4));
    expect(body, "base rate brier").toContain(w.brierBase.toFixed(4));
    expect(body, "skill").toContain(`${(w.skill * 100).toFixed(1)}%`);
    expect(body, "the date the snapshot was taken").toContain(cal.generatedAt.slice(0, 10));
    // And it has to say the live figure moves, or the snapshot reads as a claim
    // about today.
    expect(body).toMatch(/snapshot|recomputes/);
  });

  it("puts the live address where somebody opening the repo will see it", () => {
    // It was at line 274. A judge should not have to scroll past the
    // architecture to find out where the thing runs.
    const head = read("README.md").split("\n").slice(0, 22).join("\n");
    expect(head, "no live URL in the first 22 lines").toContain("rivo-autopilot.vercel.app");
  });

  it("keeps the browser bundle, which was never the problem", () => {
    // The contradiction was a second published identity, not the code. This
    // stays built and tested: an engine that runs in a browser with no backend
    // is worth being able to demonstrate, and boot.test.ts runs what ships.
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:public"]).toBeTruthy();
    expect(existsSync(resolve("src/public/boot.test.ts"))).toBe(true);
    expect(body(".github/workflows/ci.yml")).toContain("build:public");
  });
});
