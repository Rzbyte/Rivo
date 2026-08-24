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
