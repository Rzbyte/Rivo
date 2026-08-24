// `npm run calibration -- --days 90 [--cache f.json] [--store] [--out f.json]`
//
// Answers the question the venue cannot: when DreamDEX quoted 67%, how often did
// the thing actually happen?
//
// `--store` writes the report to PostgreSQL, which is what the product reads.
// The computation reads a month of fills across every settled window, so it is a
// background job's work and not a page load's.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Indexer } from "../core/indexer.js";
import { buildObservations, type Observation } from "../research/dataset.js";
import { calibrate, type CalibrationReport } from "../intel/calibration.js";
import { network } from "../core/config.js";

const arg = (flag: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (f: string): boolean => process.argv.includes(f);

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const bar = (x: number, w = 22): string => "█".repeat(Math.round(x * w)).padEnd(w, "·");

function print(r: CalibrationReport, title: string): void {
  console.log("");
  console.log(title);
  console.log("-".repeat(96));
  console.log(
    `  ${"quoted".padEnd(13)} ${"n".padStart(6)} ${"windows".padStart(8)} ${"realized".padStart(9)} ${"95% interval".padStart(16)}  ${"gap".padStart(8)}`,
  );
  for (const b of r.buckets) {
    const label = `${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%`;
    const flag = b.thin ? "  thin" : "";
    console.log(
      `  ${label.padEnd(13)} ${String(b.n).padStart(6)} ${String(b.windows).padStart(8)} ` +
        `${pct(b.realized).padStart(9)} ${`${pct(b.lo95)} – ${pct(b.hi95)}`.padStart(16)}  ` +
        `${(b.gap >= 0 ? "+" : "") + pct(b.gap)}`.padStart(8) +
        flag,
    );
  }
  console.log("");
  console.log(`  ${r.n.toLocaleString()} observations · ${r.windows.toLocaleString()} settled windows · basis ${r.basis}`);
  console.log(`  Brier ${r.brier.toFixed(4)} against ${r.brierBase.toFixed(4)} for always quoting the base rate — skill ${pct(r.skill)}`);
  console.log(`  base rate ${pct(r.baseRate)} · buckets under ${r.minWindows} windows are marked thin and claim nothing`);
}

async function main(): Promise<void> {
  const days = Number(arg("--days", "90"));
  const cache = arg("--cache");
  const out = arg("--out");

  let rows: Observation[];
  if (cache && existsSync(cache)) {
    console.log(`dataset   cached  ${cache}`);
    rows = JSON.parse(readFileSync(cache, "utf8")) as Observation[];
  } else {
    const built = await buildObservations(new Indexer(), { days, keepBothLegs: true, onProgress: (m) => console.log(m) });
    rows = built.rows;
    if (cache) {
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify(rows));
    }
  }

  // Executable side only. Calibrating on a midpoint measures a price nobody
  // could trade, which is a fine academic exercise and a misleading product.
  const executable = rows.filter((r) => r.executable);

  console.log("");
  console.log("RIVO CALIBRATION  ·  is the quoted probability the real one?");
  console.log("=".repeat(96));
  console.log(`network   ${network()}`);
  console.log(`universe  executable side only — a fill proves one direction was takeable, not both`);

  const windowBasis = calibrate(executable, { basis: "window" });
  const snapshotBasis = calibrate(executable, { basis: "snapshot" });

  print(windowBasis, "ONE OBSERVATION PER SETTLED WINDOW  ← the claim");
  print(snapshotBasis, "ONE PER FILL (correlated — shown for completeness, not for claims)");

  console.log("");
  console.log("Why two tables: every fill inside one settled window shares one outcome, so the");
  console.log("second table's sample size is a count of snapshots rather than of independent");
  console.log("facts. Both are here because hiding one of them is how a calibration claim gets");
  console.log("its confidence from correlation.");

  if (has("--store")) {
    const { query, closeDb } = await import("../db/pool.js");
    await query(
      `INSERT INTO calibration_reports
         (network, asset, interval_sec, basis, observations, windows, period_from, period_to, brier, skill, report)
       VALUES ($1, NULL, NULL, 'window', $2, $3, to_timestamp($4), to_timestamp($5), $6, $7, $8)`,
      [network(), windowBasis.n, windowBasis.windows, windowBasis.from, windowBasis.to, windowBasis.brier, windowBasis.skill, JSON.stringify(windowBasis)],
    );
    console.log("\nstored to calibration_reports");
    await closeDb();
  }

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), window: windowBasis, snapshot: snapshotBasis }, null, 2));
    console.log(`wrote ${out}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
