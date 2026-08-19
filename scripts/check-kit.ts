// `npm run check:kit` — does the installed bot kit still export what we call?
//
// Rivo declares `ec-core`'s surface locally so the repo installs standalone
// (see src/runtime/ec-core-types.ts). The cost of that choice is that the
// compiler cannot catch drift between our contract and the kit's real exports.
// This closes the gap: run it whenever the kit is updated, and before trusting
// the live path.

import { EC_CORE_EXPORTS, DEFAULT_EC_CORE_SPECIFIER } from "../src/runtime/ec-core-types.js";

async function main(): Promise<void> {
  const specifier = process.env.RIVO_EC_CORE ?? DEFAULT_EC_CORE_SPECIFIER;
  console.log(`checking "${specifier}" against the surface Rivo calls`);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (e) {
    console.error(`\nNOT INSTALLED — ${e instanceof Error ? e.message : String(e)}`);
    console.error(`\nThis is expected unless you intend to trade live. Read-only commands`);
    console.error(`(calibrate, scan, allocate, backtest, report, dry-run runtime) do not need it.`);
    console.error(`\nTo install: clone the kit beside this repo, \`npm install\` inside it, then \`npm run link:kit\`.`);
    process.exitCode = 1;
    return;
  }

  let missing = 0;
  for (const name of EC_CORE_EXPORTS) {
    const ok = typeof mod[name] === "function";
    console.log(`  ${ok ? "ok  " : "MISS"}  ${name}`);
    if (!ok) missing++;
  }
  console.log("");
  if (missing > 0) {
    console.error(`${missing} export(s) missing — the kit has moved. Update src/runtime/ec-core-types.ts.`);
    process.exitCode = 1;
  } else {
    console.log(`all ${EC_CORE_EXPORTS.length} exports present — the live executor's contract holds.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
