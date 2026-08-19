// `npm run web` — serve the dashboard over whatever the runtime has written.
import { writeFileSync } from "node:fs";
import { defaultDataDir } from "../runtime/state.js";
import { serve, snapshotHtml } from "../web/server.js";

const arg = (f: string, d?: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const dataDir = arg("--data-dir", defaultDataDir())!;
const out = arg("--snapshot");
if (out) {
  writeFileSync(out, snapshotHtml(dataDir));
  console.log(`wrote ${out}`);
} else {
  serve(dataDir, Number(arg("--port", "3000")));
}
