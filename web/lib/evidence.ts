// The measured artefacts, read from disk.
//
// Every number on /evidence was produced by a command in this repository and
// written to docs/evidence/ as JSON. The page reads those files; it does not
// recompute anything and it does not hold a second copy of any figure. That is
// the point — a claim a reader cannot re-derive is a claim they have to take on
// trust, and this product's entire argument is that they should not have to.
//
// Reading from disk in a serverless function has one trap, and Rivo has already
// been bitten by it once: Next traces what a route IMPORTS, not what it OPENS.
// The migrations were left out of the bundle that way and /api/health answered
// "the database did not answer" while the database answered perfectly. Same
// class of bug hit /api/agents silently — it shipped without alpha-research.json
// and the fold table rendered as dashes in production while looking correct
// locally. web/next.config.mjs lists these paths for that reason, and
// web/evidence.test.ts asserts the list still covers what is read here.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Artefacts this app reads. The names are the filenames without `.json`. */
export const ARTEFACTS = [
  "canary-fresh",
  "calibration",
  "backtest",
  "maker-live",
  "coherence",
  "calibration-report",
  "alpha-research",
] as const;

export type Artefact = (typeof ARTEFACTS)[number];

/**
 * Where docs/evidence sits, relative to the process's working directory.
 *
 * Two candidates because the same code runs from the repository root (tests,
 * `next dev` from the workspace root) and from web/ (the Vercel build). Trying
 * both is two `existsSync` calls and removes a whole class of "works locally"
 * failure.
 */
const CANDIDATES = ["docs/evidence", "../docs/evidence"] as const;

const cache = new Map<string, unknown>();

/** One artefact, or null when this deployment does not carry it. */
export function artefact<T = unknown>(name: Artefact): T | null {
  if (cache.has(name)) return cache.get(name) as T | null;
  for (const dir of CANDIDATES) {
    const full = resolve(dir, `${name}.json`);
    if (!existsSync(full)) continue;
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8")) as T;
      cache.set(name, parsed);
      return parsed;
    } catch {
      // A corrupt artefact is a missing artefact. Rendering half of one would
      // put a number on the page whose provenance nobody could reconstruct.
      break;
    }
  }
  cache.set(name, null);
  return null;
}
