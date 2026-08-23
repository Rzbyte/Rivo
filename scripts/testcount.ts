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
    file: "web/app/page.tsx",
    pattern: /\["\d{3,4}", "tests, none skipped"\]/g,
    render: (n) => `["${n}", "tests, none skipped"]`,
  },
];

function runSuite(): { tests: number; files: number; skipped: number; failed: number } {
  execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${REPORT}`], {
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
  if (result.skipped > 0) {
    // A skipped database test is the failure mode this repository has actually
    // had: 21 tests silently skipped, and a count that looked almost right.
    console.error(
      `${result.skipped} test(s) SKIPPED. The count would be a lie about coverage. ` +
        `Set DATABASE_URL so the durable-layer tests run, then try again.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`suite    ${result.tests} passed, ${result.files} files, 0 skipped`);

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

  const artefact = { generatedAt: new Date().toISOString(), ...result };
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
