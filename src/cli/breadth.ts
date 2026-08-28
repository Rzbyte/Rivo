// `npm run breadth` — does anything simple clear the spread on Event Contracts?
//
// Writes `docs/evidence/strategy-breadth.json`: every registered agent's shadow
// record, grouped by the contract each decision was made inside.
//
// The report is assembled in `src/intel/breadth-report.ts` and `/api/breadth`
// calls the same function, so the dated artefact and the live page cannot
// disagree about anything but when they were computed. This file is the printer.
//
// Every row here is HYPOTHETICAL. Not one of these decisions moved capital: the
// columns are named `hypothetical_*` precisely so a query has to opt into the
// lie, and this one opts in on purpose and says so in the artefact.
//
//   npm run breadth                    # write the artefact
//   npm run breadth -- --dry           # print it, write nothing

import { writeFileSync } from "node:fs";
import { loadEnv } from "../core/env.js";
import { closeDb, configured, safeTarget } from "../db/pool.js";
import { breadthReport } from "../intel/breadth-report.js";

const OUT = "docs/evidence/strategy-breadth.json";

const pct = (v: number | null): string =>
  v === null ? "     —" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

async function main(): Promise<void> {
  loadEnv();
  if (!configured()) {
    console.error("DATABASE_URL is not set. The shadow ledger lives in Postgres.");
    process.exitCode = 1;
    return;
  }

  const report = await breadthReport();
  if (report.strategies.length === 0) {
    console.error("No agents registered. Try: npm run seed:agents");
    process.exitCode = 1;
    await closeDb();
    return;
  }

  console.log(`database   ${safeTarget()}`);
  console.log("");
  console.log("strategy          state         asked  settled  windows   return    95% interval      verdict");
  console.log("─".repeat(100));
  for (const r of report.strategies) {
    const iv = r.lo95 === null ? "        —        " : `${pct(r.lo95)} … ${pct(r.hi95)}`;
    console.log(
      `${r.slug.padEnd(17)} ${r.state.padEnd(12)} ${String(r.asked).padStart(6)} ${String(r.settled).padStart(8)} ` +
        `${String(r.windows).padStart(8)}  ${pct(r.returnOnStake)}  ${iv}  ${r.verdict ?? (r.thin ? "thin" : "—")}`,
    );
  }
  console.log("");

  if (process.argv.includes("--dry")) {
    console.log("--dry: nothing written.");
  } else {
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${OUT}`);
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
