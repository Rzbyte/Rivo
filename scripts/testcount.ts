// `npm run testcount` — make every documented test count the real one.
// `npm run testcount -- --check` — fail if any of them has drifted.
//
// Four documents claimed four different numbers: README said 545 in three
// places, ARCHITECTURE said 545, ALPHA-RESEARCH said 557, and the landing page
// said 603. None was right. A count written by hand goes stale the next time
// somebody adds a test, and a stale count in a document about rigour is worse
// than no count at all — it is the one claim a reader can check in ten seconds.
//
// So the number is generated. This runs the suite, records the result in
// docs/evidence/testcount.json, and rewrites every documented occurrence from
// it. `--check` does the same comparison without writing, which is what CI
// runs: drift becomes a failing build rather than a thing somebody notices.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ARTEFACT = "docs/evidence/testcount.json";
const REPORT = "/tmp/rivo-testcount.json";

/**
 * Files excluded from the documented count, and why.
 *
 * `executor.kit.test.ts` runs only when the DreamDEX bot kit is installed —
 * `npm run link:kit`, which CI's test job deliberately does not do. Counting it
 * makes the number environment-dependent: 648 on a laptop with the kit linked,
 * 643 in CI, and a documented figure that is wrong in one place or the other.
 *
 * So the published number is the ALWAYS-RUNNABLE set: everything that runs given
 * a PostgreSQL and nothing else. The kit tests still run in `npm test`; they are
 * simply not part of a figure that has to mean the same thing everywhere.
 */
const OPTIONAL = ["**/*.kit.test.ts"];

/** Where a count appears, and the shape it appears in. */
const SITES: { file: string; pattern: RegExp; render: (n: number, files: number) => string }[] = [
  { file: "README.md", pattern: /\b\d{3,4} tests\b/g, render: (n) => `${n} tests` },
  { file: "docs/ARCHITECTURE.md", pattern: /\b\d{3,4} tests\b/g, render: (n) => `${n} tests` },
  {
    file: "docs/ALPHA-RESEARCH.md",
    pattern: /\*\*\d{3,4} passed, 0 skipped, \d+ files\*\*/g,
    render: (n, files) => `**${n} passed, 0 skipped, ${files} files**`,
  },
  {
    // The public cockpit at rzbyte.github.io/Rivo. It said "115 tests" — stale
    // by a factor of five, and missed by the first version of this script,
    // which is exactly how a count drifts: not by anybody editing it, but by a
    // site nobody remembered to list.
    file: "src/public/ui/evidence.ts",
    pattern: /# \d{3,4} tests, entirely offline/g,
    render: (n) => `# ${n} tests, entirely offline`,
  },
  {
    file: "web/app/page.tsx",
    pattern: /\["\d{3,4}", "tests, none skipped"\]/g,
    render: (n) => `["${n}", "tests, none skipped"]`,
  },
  {
    // The one document meant to be pasted verbatim into a judging form, and the
    // one this guard did not cover — so it drifted to 847 while every site the
    // guard did watch stayed correct. A number is only as checked as its least
    // listed home, and the least listed home is always the one somebody reads.
    file: "docs/submission/submission-copy.md",
    pattern: /\b\d{3,4} tests\b/g,
    render: (n) => `${n} tests`,
  },
];

function runSuite(): { tests: number; files: number; skipped: number; failed: number } {
  execFileSync("npx", ["vitest", "run", ...OPTIONAL.flatMap((g) => ["--exclude", g]), "--reporter=json", `--outputFile=${REPORT}`], {
    stdio: ["ignore", "ignore", "inherit"],
    env: process.env,
  });
  const r = JSON.parse(readFileSync(REPORT, "utf8")) as {
    numPassedTests?: number; numPendingTests?: number; numFailedTests?: number;
    testResults?: unknown[];
  };
  return {
    tests: r.numPassedTests ?? 0,
    // `testResults` is one entry per FILE. `numTotalTestSuites` counts describe
    // blocks — 195 of them against 42 files — and reporting that as a file
    // count is exactly the sort of number nobody checks.
    files: r.testResults?.length ?? 0,
    skipped: r.numPendingTests ?? 0,
    failed: r.numFailedTests ?? 0,
  };
}

function main(): void {
  const check = process.argv.includes("--check");
  const result = runSuite();

  if (result.failed > 0) {
    console.error(`${result.failed} test(s) failed — not recording a count from a red suite.`);
    process.exitCode = 1;
    return;
  }
  // The guard is about the DATABASE, which is the failure mode this repository
  // has actually had: 21 durable-layer tests silently skipping behind a count
  // that looked almost right. It is not about skips in general — the optional
  // integration above is excluded from the run entirely, so anything still
  // pending here is unexplained and the count would be a lie about coverage.
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      "DATABASE_URL is not set, so the durable-layer tests would skip and the count " +
        "would understate coverage. Set it and try again.",
    );
    process.exitCode = 1;
    return;
  }
  if (result.skipped > 0) {
    console.error(`${result.skipped} test(s) skipped unexpectedly — the count would be a lie about coverage.`);
    process.exitCode = 1;
    return;
  }

  console.log(`suite    ${result.tests} passed, ${result.files} files, 0 skipped (optional integrations excluded)`);

  let drifted = 0;
  for (const site of SITES) {
    if (!existsSync(site.file)) continue;
    const before = readFileSync(site.file, "utf8");
    const want = site.render(result.tests, result.files);
    const found = before.match(site.pattern) ?? [];
    const wrong = found.filter((f) => f !== want);
    if (wrong.length === 0) {
      console.log(`  ok    ${site.file} (${found.length} occurrence${found.length === 1 ? "" : "s"})`);
      continue;
    }
    drifted += wrong.length;
    if (check) {
      console.log(`  DRIFT ${site.file}: ${[...new Set(wrong)].join(", ")} — should be "${want}"`);
    } else {
      writeFileSync(site.file, before.replace(site.pattern, want));
      console.log(`  fixed ${site.file}: ${[...new Set(wrong)].join(", ")} -> "${want}"`);
    }
  }

  const artefact = { generatedAt: new Date().toISOString(), excluded: OPTIONAL, ...result };
  if (!check) {
    mkdirSync(dirname(resolve(ARTEFACT)), { recursive: true });
    writeFileSync(ARTEFACT, `${JSON.stringify(artefact, null, 2)}\n`);
    console.log(`\nwrote ${ARTEFACT}`);
  } else if (drifted > 0) {
    console.error(`\n${drifted} documented count(s) have drifted. Run: npm run testcount`);
    process.exitCode = 1;
  } else {
    console.log("\nevery documented count matches the suite.");
  }
}

main();
