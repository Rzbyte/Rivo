// `npm run web` — the cockpit.
//
//   npm run web                      serve on :3000 against ./data
//   npm run web -- --port 3117       another port
//   npm run web -- --data-dir ./data-live
//   npm run web -- --snapshot out.html   freeze to one self-contained file

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultDataDir } from "../runtime/state.js";
import { serve, snapshotHtml } from "../web/server.js";

const arg = (f: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};

const dataDir = arg("--data-dir", defaultDataDir())!;
const repoRoot = resolve(arg("--root", process.cwd())!);
const out = arg("--snapshot");

if (out) {
  writeFileSync(out, snapshotHtml(dataDir, repoRoot));
  console.log(`wrote ${out}`);
} else {
  serve({
    dataDir,
    repoRoot,
    port: Number(arg("--port", "3000")),
    intervalMs: Number(arg("--interval-ms", "60000")),
  });
}
