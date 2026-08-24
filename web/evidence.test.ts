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

/** Routes whose source opens an evidence artefact, by import or through the reader. */
const routesReadingEvidence = (): string[] =>
  execSync("git ls-files web/app/api", { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith("route.ts"))
    .filter((f) => /@\/lib\/evidence|docs\/evidence/.test(read(f)))
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
