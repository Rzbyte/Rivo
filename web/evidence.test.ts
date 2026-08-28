// The evidence has to survive the deployment, not just the repository.
//
// /api/agents opened docs/evidence/alpha-research.json, nothing imported it, and
// Next traces imports rather than reads — so the file was left out of the
// serverless bundle and the route answered `research: null` in production. Every
// fold rendered locally. On Vercel the fold table, the edge buckets and the
// gate's reasons were empty dashes: the working behind a verdict, missing on the
// one deployment anybody would read it on, with nothing red anywhere.
//
// That bug is invisible to a type checker, to the local dev server, and to every
// test that runs from the repository root. The only thing that catches it is
// asserting that the tracing config covers what the code actually opens.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { ARTEFACTS, artefact } from "./lib/evidence";

const read = (p: string): string => readFileSync(resolve(p), "utf8");

/**
 * Source with its comments removed, because a mention is not a read.
 *
 * The detector below looks for the shape of opening an artefact, and it used to
 * look at the whole file — so a route that merely NAMED docs/evidence in a
 * comment was demanded to appear in the tracing config, which would have traced
 * files it never opens. /api/breadth tripped exactly that by explaining, in
 * prose, that it and the dated artefact must not disagree.
 *
 * Deliberately conservative: block comments, and whole lines that are comments.
 * A trailing `// docs/evidence` after code survives and still counts, which is
 * the safe direction to be wrong in — this guard exists because a route that
 * opened an artefact and was not traced answered `research: null` in production
 * with nothing red anywhere, and a false positive costs a sentence while a false
 * negative costs the working behind a verdict.
 *
 * Whole-line only also keeps `https://` inside a string literal intact, which a
 * naive strip of everything after `//` would not.
 */
const withoutComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

/** Routes whose source opens an evidence artefact, by import or through the reader. */
const routesReadingEvidence = (): string[] =>
  execSync("git ls-files web/app/api", { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith("route.ts") && existsSync(resolve(f)))
    .filter((f) => /@\/lib\/evidence|docs\/evidence/.test(withoutComments(read(f))))
    .map((f) => f.replace(/^web\/app(\/api\/.*)\/route\.ts$/, "$1"));

describe("evidence artefacts", () => {
  it("every artefact the app names is actually present", () => {
    // A name in ARTEFACTS that matches no file is a page section that silently
    // never renders — the failure mode is a missing block, not an error.
    for (const name of ARTEFACTS) {
      const found = ["docs/evidence", "../docs/evidence"].some((d) => existsSync(resolve(d, `${name}.json`)));
      expect(found, `docs/evidence/${name}.json is missing`).toBe(true);
    }
  });

  it("parses each one", () => {
    for (const name of ARTEFACTS) expect(artefact(name), name).not.toBeNull();
  });

  it("is traced into the deployment bundle for every route that reads it", () => {
    const config = read("web/next.config.mjs");
    const traced = config.slice(config.indexOf("outputFileTracingIncludes"));
    const routes = routesReadingEvidence();
    expect(routes.length, "no route reads evidence — did the reader move?").toBeGreaterThan(0);
    for (const route of routes) {
      expect(traced, `${route} opens an evidence file but next.config.mjs does not trace one for it`)
        .toContain(`"${route}"`);
    }
    expect(traced).toMatch(/docs\/evidence/);
  });

  it("counts a read and not a mention", () => {
    // The three shapes that are real, and the one that is not. Without the
    // last case this detector demands tracing for any route that so much as
    // names the directory in prose.
    expect(withoutComments(`import { artefact } from "@/lib/evidence";`)).toMatch(/@\/lib\/evidence/);
    expect(withoutComments(`const p = "docs/evidence/alpha-research.json";`)).toMatch(/docs\/evidence/);
    expect(withoutComments(`const u = "https://x/docs/evidence";`)).toMatch(/docs\/evidence/);
    expect(withoutComments(`// the artefact in docs/evidence cannot disagree`)).not.toMatch(/docs\/evidence/);
    expect(withoutComments(`/* docs/evidence */`)).not.toMatch(/docs\/evidence/);
  });

  it("still catches the route the guard was written for", () => {
    // /api/agents opens docs/evidence/alpha-research.json as a path literal.
    // If comment-stripping ever swallowed that, this whole file would pass
    // while guarding nothing.
    expect(routesReadingEvidence()).toContain("/api/agents");
  });

  it("keeps the held-out sample size attached to the held-out numbers", () => {
    // The README once quoted the holdout AUC and Brier against the size of the
    // whole study — 30,771 rather than 9,232. Both numbers were real and the
    // sentence joining them was not, which is the most expensive kind of error
    // for a project whose argument is that it measures carefully.
    const cal = artefact<{ holdout: { n: number; auc: number; brier: number } }>("calibration");
    expect(cal).not.toBeNull();
    const n = cal!.holdout.n.toLocaleString("en-US");
    const readme = read("README.md");
    const headline = readme.slice(readme.indexOf("The forecasting model works"), readme.indexOf("Trading on it"));
    expect(headline, "the headline quotes holdout figures without the holdout's size").toContain(n);
    expect(headline).toContain(cal!.holdout.auc.toFixed(4));
  });
});

describe("the calibration route", () => {
  it("falls back to the stored artefact rather than 503", () => {
    // The strongest finding in the product had one point of failure: no
    // database, no number. A managed Postgres that sleeps on an idle plan is
    // not hypothetical, and an empty headline during judging is not recoverable.
    const src = read("web/app/api/calibration/route.ts");
    expect(src).toContain("calibration-report");
    expect(src).toMatch(/snapshot\(\)\s*\?\?/);
    // Both paths: never configured, and configured but not answering.
    expect(src).toMatch(/catch\s*\{[\s\S]{0,400}snapshot\(\)/);
  });

  it("never passes stale figures off as live ones", () => {
    // A fallback that cannot be told apart from live data turns "the database is
    // down" into "these numbers are current", which is the one claim this
    // project must not make by accident.
    const src = read("web/app/api/calibration/route.ts");
    expect(src).toContain("stale: true");
    expect(src).toMatch(/computedAt/);
  });
});
